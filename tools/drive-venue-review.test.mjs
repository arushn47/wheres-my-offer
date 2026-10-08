import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceBelongsToDrive, buildBatchReview, mergeProjection, latestVenueUpdates } from './drive-venue-review.mjs';

const drive = {id:'drive',drive_number:'pat-PL-2026-1407',normalized_drive_number:'pat-pl-2026-1407',source_college_email_id:'anchor',excluded_email_ids:[],recruitment_venues:null};
const source = {id:'anchor',subject:'Interview process',body_text:'Interviews will be held at Chargebee Chennai office.',received_at:'2026-10-07T12:23:05Z',classification:'registration',parsed_drive_numbers:[]};
test('all-drive review isolates same-company siblings and rejects pooled, excluded and irrelevant sources',()=>{
  const sibling={...drive,id:'sibling',drive_number:'pat-pl-2026-1324',normalized_drive_number:'pat-pl-2026-1324',source_college_email_id:'other'};
  const reviews=buildBatchReview([drive,sibling],[source]);
  assert.equal(reviews[0].after.label,'Company Office · Chennai');
  assert.equal(reviews[1].after.label,'To be announced');
  assert.equal(reviews[1].updates.length,0);
  for(const patch of [{classification:'irrelevant'}, {parsed_drive_numbers:['1407','1324']}, {id:'unanchored'}]) {
    assert.equal(sourceBelongsToDrive(drive,{...source,...patch}),false);
  }
  assert.equal(sourceBelongsToDrive({...drive,excluded_email_ids:['anchor']},source),false);
  assert.equal(sourceBelongsToDrive(drive,{...source,id:'numbered',parsed_drive_numbers:[' 1407 ']}),true);
});
test('newer unknown instructions supersede an older confirmed venue; stale sources cannot restore it',()=>{
  const confirmed={stage:'Test',kind:'online',name:'Online',quote:'Test online'};
  const unknown={stage:'Test',kind:'unknown',name:'',quote:'Test venue: TBA'};
  const result=mergeProjection(null,[
    {sourceId:'a',receivedAt:'2026-10-06T00:00:00Z',entries:[confirmed]},
    {sourceId:'b',receivedAt:'2026-10-07T00:00:00Z',entries:[unknown]},
    {sourceId:'c',receivedAt:'2026-10-05T00:00:00Z',entries:[confirmed]},
  ]);
  assert.equal(result.entries.length,1);
  assert.equal(result.entries[0].kind,'unknown');
  assert.equal(result.entries[0].sourceId,'b');
});
test('missing venue evidence does not create a projection from job location',()=>{
  const reviews=buildBatchReview([drive],[{...source,subject:'Placement registration',body_text:'Job Location: Chennai. Register before tomorrow.'}]);
  assert.equal(reviews[0].changed,false);
  assert.equal(reviews[0].updates.length,0);
  assert.equal(reviews[0].after.label,'To be announced');
});
test('a contradictory company name vetoes a historical number tag without enabling company-only matches',()=>{
  const named={...drive,company_name:'Winwire',company_aliases:['WinWire Technologies']};
  assert.equal(sourceBelongsToDrive(named,{...source,parsed_drive_numbers:['1407'],parsed_company_name:'Smart Data Solutions'}),false);
  assert.equal(sourceBelongsToDrive(named,{...source,parsed_company_name:'WinWire Technologies'}),true);
  assert.equal(sourceBelongsToDrive(named,{...source,id:'unassigned',parsed_company_name:'WinWire'}),false);
});
test('applying only winning source entries preserves the full historical merge, including unknown corrections',()=>{
  const entries=[{stage:'Test',kind:'online',name:'Online',quote:'Old'},{stage:'PPT',kind:'online',name:'Online',quote:'PPT'}];
  const updates=[{sourceId:'old',receivedAt:'2026-10-05T00:00:00Z',entries},
    {sourceId:'new',receivedAt:'2026-10-06T00:00:00Z',entries:[{stage:'Test',kind:'unknown',name:'',quote:'TBA'}]}];
  const minimal=latestVenueUpdates(null,updates);
  assert.deepEqual(mergeProjection(null,minimal),mergeProjection(null,updates));
  assert.equal(minimal.flatMap(u=>u.entries).length,2);
});
test('does not publish another company’s circular even if old company and number tags are contaminated',()=>{
  const named={...drive,company_name:'Winwire',company_aliases:[]};
  const wrong={...source,subject:'Smart Data Solutions Interviews',parsed_company_name:'Winwire',parsed_drive_numbers:['1407']};
  assert.equal(buildBatchReview([named],[wrong])[0].updates.length,0);
  const right={...source,subject:'WinWire Interviews',parsed_company_name:'Winwire'};
  assert.equal(buildBatchReview([named],[right])[0].updates.length,1);
});
test('invalidates a same-source parser result that no longer qualifies without restoring stale venues',()=>{
  const stale={stage:'Test',kind:'online',name:'Online',quote:'Students attending from own location will be suspended',sourceId:'anchor',receivedAt:source.received_at};
  const review=buildBatchReview([{...drive,recruitment_venues:{version:1,entries:[stale]}}],[{...source,body_text:'Students attending the test from own location will be suspended for further placements.'}])[0];
  assert.equal(review.after.label,'To be announced');
  assert.equal(review.updates[0].entries[0].kind,'unknown');
});
