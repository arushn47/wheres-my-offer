import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireFinalArchive, sequenceMatches } from './cutover-archive-policy.mjs';
test('rejects old, unfenced, mismatched, or incomplete final archives',()=>{
 const now=Date.now(),ref='source';
 const manifest={projectRef:ref,snapshotConsistent:true,createdAt:new Date(now).toISOString(),cutoverPauseVerifiedAt:new Date(now-1000).toISOString(),writersDrainedAttested:true,
  files:['database.dump','roles.sql'].map(name=>({name,sha256:'a'.repeat(64)}))};
 requireFinalArchive(manifest,ref,now);
 for(const patch of [{projectRef:'other'},{snapshotConsistent:false},{writersDrainedAttested:false},{cutoverPauseVerifiedAt:null},
  {createdAt:new Date(now-31*60000).toISOString()},{createdAt:new Date(now+1000).toISOString()},{files:[]}]) assert.throws(()=>requireFinalArchive({...manifest,...patch},ref,now));
});
test('final sequence verification permits safe high-water values but never a rewind',()=>{
 assert(sequenceMatches('12:true','12:true')); assert(!sequenceMatches('12:true','13:true'));
 assert(sequenceMatches('12:true','13:true',true)); assert(sequenceMatches('1:false','1:true',true));
 assert(!sequenceMatches('12:true','11:true',true)); assert(!sequenceMatches('12:true','12:false',true));
 assert(!sequenceMatches('12:true',undefined,true)); assert(!sequenceMatches('12:true','invalid',true));
});
