// All-drive, venue-only maintenance through the same service-role API as the app.
// Each merge uses v44's row lock, exact-source guard and latest-evidence ordering.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { DESTINATION_REF } from './cutover-connections.mjs';
import { buildBatchReview, digest, sourceBelongsToDrive, latestVenueUpdates } from './drive-venue-review.mjs';
import { resolveDriveVenue } from '../src/lib/drive-venues.ts';
import { systemJsonRequest } from './system-json-request.mjs';

const args=process.argv.slice(2), applying=args[0]==='--apply-reviewed';
if (!(args.length===1 && args[0]==='--all' || applying && args.length===2)) throw Error('Use --all, or --apply-reviewed FILE');
const reviewed=applying?JSON.parse(await readFile(args[1],'utf8')):null;
const env=parseEnv(await readFile('.env.local','utf8'));
if(new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname!==`${DESTINATION_REF}.supabase.co` || !env.SUPABASE_SERVICE_ROLE_KEY) throw Error('Mumbai application credentials required');
async function request(path,params={},body) {
  const url=new URL(`/rest/v1/${path}`,env.NEXT_PUBLIC_SUPABASE_URL);
  for(const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
  return systemJsonRequest({url:url.href,method:body?'POST':'GET',headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`},body:body?JSON.stringify(body):null});
}
async function loadSnapshot() {
  const drives=(await request('placement_drives',{select:'*,companies(name,aliases)',order:'id',limit:'501'})).map(({companies,...drive})=>({...drive,company_name:companies?.name,company_aliases:companies?.aliases||[]}));
  if(drives.length>500) throw Error('Drive batch bound exceeded');
  const metadata=[];
  for(let offset=0;offset<5000;offset+=1000) {
    const page=await request('college_emails',{select:'id,subject,received_at,classification,parsed_drive_numbers,parsed_company_name',order:'id',offset:String(offset),limit:'1000'});
    metadata.push(...page);if(page.length<1000) break;if(offset===4000) throw Error('Source batch bound exceeded');
  }
  const matched=metadata.filter(s=>drives.some(d=>sourceBelongsToDrive(d,s)));
  const sources=[];
  for(let offset=0;offset<matched.length;offset+=100) {
    sources.push(...await request('college_emails',{select:'id,subject,body_text,received_at,classification,parsed_drive_numbers,parsed_company_name',
      id:`in.(${matched.slice(offset,offset+100).map(s=>s.id).join(',')})`,order:'id'}));
  }
  sources.sort((a,b)=>a.id.localeCompare(b.id));
  console.info(JSON.stringify({drives:drives.length,exactSources:sources.length}));
  return {drives,sources};
}
const snapshot=await loadSnapshot();
const rejectedSourceIds=new Set((reviewed?.rejectedSources||[]).map(s=>s.sourceId));
if([...rejectedSourceIds].some(id=>!snapshot.sources.some(s=>s.id===id))) throw Error('Rejected source is outside the reviewed batch');
const reviews=buildBatchReview(snapshot.drives,snapshot.sources,rejectedSourceIds);
const counts={drives:reviews.length,sources:snapshot.sources.length,withEvidence:reviews.filter(r=>r.updates.length).length,
  displayKnown:reviews.filter(r=>r.after.label!=='To be announced').length,remainingTba:reviews.filter(r=>r.after.label==='To be announced').length};
const context=d=>({id:d.id,drive_number:d.drive_number,normalized_drive_number:d.normalized_drive_number,
  source_college_email_id:d.source_college_email_id,excluded_email_ids:d.excluded_email_ids,recruitment_venues:d.recruitment_venues});
const inputHash=digest({drives:snapshot.drives.map(context),sources:snapshot.sources}),reviewsHash=digest(reviews);
await mkdir('scratch/drive-venue-reviews',{recursive:true});
if(!applying) {
  const report={version:4,projectRef:DESTINATION_REF,scope:'all-drives',readOnly:true,checkedAt:new Date().toISOString(),inputHash,reviewsHash,counts,reviews};
  await writeFile('scratch/drive-venue-reviews/all-drives.json',JSON.stringify(report,null,2));
  await writeFile('scratch/drive-venue-reviews/all-drives-snapshot.json',JSON.stringify(snapshot));
  console.log(JSON.stringify({...counts,path:'scratch/drive-venue-reviews/all-drives.json',readOnly:true},null,2));
} else {
  if(reviewed.version!==4 || reviewed.projectRef!==DESTINATION_REF || reviewed.scope!=='all-drives' || !reviewed.readOnly
    || reviewed.inputHash!==inputHash || reviewed.reviewsHash!==reviewsHash || digest(reviewed.reviews)!==reviewsHash) throw Error('Reviewed evidence changed; prepare/review again');
  let mergedSources=0,drivesChanged=0;
  // Revalidate each drive and its evidence immediately before its atomic merges.
  for(const review of reviews.filter(r=>r.changed)) {
    const original=snapshot.drives.find(d=>d.id===review.driveId);
    const [current]=await request('placement_drives',{select:'*',id:`eq.${review.driveId}`});
    if(digest(context(original))!==digest(context(current))) throw Error(`Drive changed; stop and review again: ${review.driveId}`);
    const updates=latestVenueUpdates(original.recruitment_venues,review.updates);
    const ids=updates.map(u=>u.sourceId);
    const fresh=[];
    for(let offset=0;offset<ids.length;offset+=100) fresh.push(...await request('college_emails',{
      select:'id,subject,body_text,received_at,classification,parsed_drive_numbers,parsed_company_name',id:`in.(${ids.slice(offset,offset+100).join(',')})`,order:'id'}));
    const expected=snapshot.sources.filter(s=>ids.includes(s.id));
    fresh.sort((a,b)=>a.id.localeCompare(b.id));
    if(digest(expected)!==digest(fresh)) throw Error(`Source changed; stop and review again: ${review.driveId}`);
    for(const update of updates) {
      await request('rpc/merge_drive_recruitment_venues',{}, {p_drive_id:review.driveId,p_source_id:update.sourceId,p_received_at:update.receivedAt,p_entries:update.entries});
      mergedSources++;
    }
    const [after]=await request('placement_drives',{select:'*',id:`eq.${review.driveId}`});
    const other=({recruitment_venues,company_name,company_aliases,...fields})=>fields;
    if(digest(other(current))!==digest(other(after))) {
      await writeFile('scratch/drive-venue-reviews/concurrent-drive-change.json',JSON.stringify({driveId:review.driveId,before:current,after},null,2));
      throw Error(`Non-venue columns changed during update: ${review.driveId}`);
    }
    if(resolveDriveVenue(after.recruitment_venues,'VIT Bhopal').label!==review.after.label) throw Error(`Display verification failed: ${review.driveId}`);
    drivesChanged++;
    console.info(JSON.stringify({updated:drivesChanged,drive:review.name,number:review.driveNumber,label:review.after.label}));
    await writeFile('scratch/drive-venue-reviews/all-drives-progress.json',JSON.stringify({drivesChanged,mergedSources,lastDriveId:review.driveId}));
  }
  const final=(await request('placement_drives',{select:'id,recruitment_venues,companies(name),drive_number',order:'id',limit:'501'}));
  const displays=final.map(d=>({driveId:d.id,name:d.companies?.name,driveNumber:d.drive_number,...resolveDriveVenue(d.recruitment_venues,'VIT Bhopal')}));
  const result={projectRef:DESTINATION_REF,applied:true,venueOnly:true,drivesChecked:reviews.length,drivesChanged,mergedSources,
    displayKnown:displays.filter(d=>d.label!=='To be announced').length,remainingTba:displays.filter(d=>d.label==='To be announced').length,
    verifiedOtherDriveFieldsUnchanged:true};
  await writeFile('scratch/drive-venue-reviews/all-drives-applied.json',JSON.stringify({result,displays},null,2));
  console.log(JSON.stringify(result,null,2));
}
