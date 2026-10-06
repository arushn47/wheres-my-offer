import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { calculateDriveRoundVerdicts } from '@/lib/sync/round-verdict-service';
import { recalculateApplicationStatuses } from '@/lib/sync/reprocess';
import { withUserMutationLease } from '@/lib/sync/mutation-lease';
import { loadUserCandidateIdentity, matchesCandidateRow } from '@/lib/sync/user-identity';
import { classifyShortlistEmail } from '@/lib/sync/round-identity';
import { isQuotedReply, getEvidenceMessageText } from '@/lib/sync/body';

const [userId,driveId,...flags]=process.argv.slice(2);
if (!/^[a-f0-9-]{36}$/i.test(userId || '') || !/^[a-f0-9-]{36}$/i.test(driveId || '')) throw new Error('Usage: repair-shortlists.ts USER_UUID DRIVE_UUID [--apply]');
const apply=flags.includes('--apply');
const supabase=createAdminClient();
async function checked<T>(query: PromiseLike<{data:T;error:unknown}>) { const {data,error}=await query;if(error)throw error;if(data===null)throw new Error('Database query returned no data');return data as NonNullable<T>; }
async function readState() {
  const application=await checked(supabase.from('applications').select('*').eq('user_id',userId).eq('placement_drive_id',driveId).single());
  const events=await checked(supabase.from('events').select('*').eq('user_id',userId).eq('placement_drive_id',driveId));
  const matches=await checked(supabase.from('candidate_matches').select('*').eq('user_id',userId).eq('placement_drive_id',driveId));
  const notifications=await checked(supabase.from('notifications').select('*').eq('user_id',userId).eq('placement_drive_id',driveId));
  return {application,events,matches,notifications};
}
const drive=await checked(supabase.from('placement_drives').select('id,company_id,companies(name)').eq('id',driveId).single());
const company=(Array.isArray(drive.companies)?drive.companies[0]:drive.companies)!.name;
const token=company.split(/[^a-z0-9]+/i).find((word:string)=>word.length>=4);
if(!token)throw new Error('Drive has no unambiguous company token');
const circulars=await checked(supabase.from('college_emails').select('id,subject,body_text,received_at,sender_email').ilike('subject','%'+token+'%').order('received_at'));
const personal=await checked(supabase.from('personal_emails').select('id,subject,body_snippet,received_at,sender').eq('user_id',userId).eq('placement_drive_id',driveId));
const verdicts=await calculateDriveRoundVerdicts(supabase,userId,driveId,[...circulars.map(row=>({...row,college_email_id:row.id})),...personal]);
const before=await readState();
console.log(JSON.stringify({mode:apply?'apply':'preview',company,oldStatus:before.application.status,decisions:verdicts.map(v=>({round:v.roundKey,state:v.state,eligible:v.eligible,finalNegative:v.finalNegative,reason:v.reason})),automaticEvents:before.events.filter(e=>!e.manual_override).length,storedMatches:before.matches.length}));
if(apply) await withUserMutationLease(userId,async()=>{
  const snapshot=await readState();
  await mkdir('backups',{recursive:true});
  const path='backups/shortlist-repair-'+Date.now()+'.json';
  await writeFile(path,JSON.stringify({userId,driveId,drive,circularIds:circulars.map(c=>c.id),...snapshot},null,2));
  const identity=await loadUserCandidateIdentity(supabase,userId);
  const groups=new Map<string,typeof snapshot.matches>();
  for(const match of snapshot.matches) {
    if(!/Google Sheet/i.test(match.matched_value || '') || !matchesCandidateRow((match.matched_value || '').split(/[:,]/),identity).matched)continue;
    const source=circulars.find(row=>row.id===match.college_email_id);
    if(!source)continue;
    const url=(source.body_text || '').match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/(?:e\/)?[\w-]+/)?.[0];
    if(!url)continue;
    const key=createHash('sha256').update(url+'|'+match.matched_value).digest('hex');
    groups.set(key,[...(groups.get(key)||[]),match]);
  }
  for(const [rosterKey,duplicates] of groups) {
    duplicates.sort((a,b)=>{
      const sa=circulars.find(row=>row.id===a.college_email_id)!;const sb=circulars.find(row=>row.id===b.college_email_id)!;
      return Number(isQuotedReply(sa.subject || ''))-Number(isQuotedReply(sb.subject || '')) || (sa.received_at || '').localeCompare(sb.received_at || '');
    });
    const primary=duplicates[0];const source=circulars.find(row=>row.id===primary.college_email_id)!;
    if(duplicates.length>1) await checked(supabase.from('candidate_matches').delete().eq('user_id',userId).eq('placement_drive_id',driveId).in('id',duplicates.slice(1).map(m=>m.id)).select('id'));
    const round=classifyShortlistEmail(source.subject || '',getEvidenceMessageText({subject:source.subject || '',bodyPlain:source.body_text || '',bodyHtml:'',bodySnippet:''}));
    await checked(supabase.from('candidate_matches').update({roster_key:rosterKey,matched_round_type:round,evidence:{...primary.evidence,sourceEmailIds:[...new Set([...(primary.evidence?.sourceEmailIds || []),...duplicates.map(m=>m.college_email_id)])],parserVersion:3,identityBasis:'exact_known_account'}}).eq('id',primary.id).eq('user_id',userId).select('id'));
  }
  const result=await recalculateApplicationStatuses(userId,undefined,{targetPlacementDriveIds:[driveId],recalculateStatusesFromRemainingEvidence:true,suppressNotifications:true,skipBodyRecovery:true,skipGSheetScan:true});
  if(result.updatedCount!==1)throw new Error('Repair did not update the requested drive');
  const after=await readState();
  const current=await checked(supabase.from('round_verdicts').select('verdict').eq('user_id',userId).eq('placement_drive_id',driveId).eq('is_current',true).single());
  if(!current.verdict.eligible && after.events.some(e=>!e.manual_override && /test|interview/.test(e.event_type) && new Date(e.start_time).getTime()>Date.now()))throw new Error('Unsupported future invitation survived repair');
  console.log(JSON.stringify({status:after.application.status,currentRound:current.verdict.roundKey,eligible:current.verdict.eligible,finalNegative:current.verdict.finalNegative,matches:after.matches.length,automaticEvents:after.events.filter(e=>!e.manual_override).length,supersededAlerts:after.notifications.filter(n=>n.superseded_at).length,snapshot:path}));
});
