import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutoverConnections, destinationConnection, verifyProductionPause, requireNoLiveWriters } from './cutover-connections.mjs';
const env = {NEXT_PUBLIC_SUPABASE_URL:'https://mltfzskewmpifnyleevb.supabase.co',db_pass:'synthetic-source',
 RESTORE_PROJECT_REF:'nvkxyeugonjevmbvxirm',RESTORE_SUPABASE_URL:'https://nvkxyeugonjevmbvxirm.supabase.co',
 host:'aws-1-ap-south-1.pooler.supabase.com',user:'postgres.nvkxyeugonjevmbvxirm',DB_PASS:'synthetic-replacement'};
test('keeps source and destination credentials independent',()=>{
 const connections = cutoverConnections(env);
 assert.equal(connections.source.password,'synthetic-source'); assert.equal(connections.destination.password,'synthetic-replacement');
 const sourceOnly={...env}; delete sourceOnly.DB_PASS;
 const restoreOnly={...env}; delete restoreOnly.db_pass;
 assert.equal(cutoverConnections(sourceOnly,restoreOnly).source.password,'synthetic-source');
 assert.equal(cutoverConnections(sourceOnly,restoreOnly).destination.password,'synthetic-replacement');
 for (const patch of [{user:'postgres.mltfzskewmpifnyleevb'},{RESTORE_PROJECT_REF:'xvxkkqdnatnqumnlshlg'},
   {NEXT_PUBLIC_SUPABASE_URL:env.RESTORE_SUPABASE_URL},{port:'6543'},{DB_USER:'postgres.nvkxyeugonjevmbvxirm'}]) assert.throws(()=>cutoverConnections({...env,...patch}));
});
test('destination maintenance works after cutover without source credentials and rejects mixed projects',()=>{
 const restore={...env}; delete restore.NEXT_PUBLIC_SUPABASE_URL; delete restore.db_pass;
 assert.equal(destinationConnection(restore).user,'postgres.nvkxyeugonjevmbvxirm');
 assert.equal(destinationConnection(restore).password,'synthetic-replacement');
 for (const patch of [{user:'postgres.mltfzskewmpifnyleevb'},
   {RESTORE_PROJECT_REF:'mltfzskewmpifnyleevb'},
   {RESTORE_SUPABASE_URL:'https://mltfzskewmpifnyleevb.supabase.co'},
   {port:'6543'},{host:'attacker.example'},{DB_PASS:''}]) {
   assert.throws(()=>destinationConnection({...restore,...patch}));
 }
 // An application switch still cannot authorize a two-database refresh.
 assert.throws(()=>cutoverConnections({...env,NEXT_PUBLIC_SUPABASE_URL:env.RESTORE_SUPABASE_URL}));
});
test('accepts only explicit maintenance fence responses, never ordinary service errors',async()=>{
 const seen=[];
 await verifyProductionPause(async(url,options)=>{seen.push([url,options]);return Response.json({error:'Database maintenance is in progress. Please retry shortly.'},{status:503,headers:{'Retry-After':'60'}});});
 assert.equal(seen.length,3); assert(seen.every(([,options])=>!options.headers && !options.body));
 for (const status of [200,307,401,500,503]) await assert.rejects(verifyProductionPause(async()=>Response.json({error:'Unauthorized'},{status})),/not active/);
});
test('refuses any remaining writer lease or claim',()=>{
 const zero={user_leases:0,shared_leases:0,push_claims:0,archive_leases:0}; requireNoLiveWriters(zero);
 for(const key of Object.keys(zero)) assert.throws(()=>requireNoLiveWriters({...zero,[key]:1}),/Live database writer/);
});
