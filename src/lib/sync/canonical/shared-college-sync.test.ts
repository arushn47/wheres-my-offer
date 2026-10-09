import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),gmail:vi.fn(),ingest:vi.fn(),fanout:vi.fn()}));
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>({from:mocks.from,rpc:mocks.rpc})}));
vi.mock('@/lib/gmail/client',()=>({createGmailClient:mocks.gmail}));
vi.mock('@/lib/gmail/history',()=>({fetchHistoryChanges:vi.fn(),getProfileHistoryId:vi.fn()}));
vi.mock('@/lib/sync/canonical/shared-college-ingest',()=>({ingestSharedCollegeCircular:mocks.ingest,fanOutSharedCollegeArchiveToUser:mocks.fanout}));
import { runSharedCollegeSync } from './shared-college-sync';
beforeEach(()=>{
 vi.resetAllMocks();vi.stubEnv('SHARED_COLLEGE_EMAIL','');
 mocks.rpc.mockResolvedValue({data:true,error:null});mocks.gmail.mockResolvedValue({gmail:{}});
 mocks.from.mockImplementation((table:string)=>{
  const query={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),order:vi.fn().mockReturnThis(),limit:vi.fn().mockReturnThis(),
   maybeSingle:async()=>({data:{received_at:'2026-10-01T00:00:00Z'},error:null}),
   single:async()=>({data:{initial_scan_complete:true,pending_message_ids:['first','second'],pending_offset:0,next_page_token:null,pending_next_page_token:null,pending_history_id:'history'},error:null}),
   then:(resolve:(value:unknown)=>unknown)=>Promise.resolve({data:table==='gmail_accounts'?[{id:'account',email:'college@example.test',last_history_id:'history'}]:[],error:null}).then(resolve)};
  return query;
 });
});
afterEach(()=>vi.unstubAllEnvs());
it('keeps pending IDs and their offset intact when the cron budget expires',async()=>{
 const result=await runSharedCollegeSync({globalDeadline:Date.now()-1});
 expect(result.hasMore).toBe(true);expect(result.ingested).toBe(0);expect(mocks.ingest).not.toHaveBeenCalled();
 const checkpoints=mocks.rpc.mock.calls.filter(call=>call[0]==='checkpoint_shared_college_sync');
 expect(checkpoints).toHaveLength(2);
 expect(checkpoints[1][1]).toMatchObject({p_pending_message_ids:['first','second'],p_pending_offset:0,p_pending_history_id:'history'});
 expect(mocks.rpc.mock.calls.at(-1)?.[0]).toBe('release_shared_college_sync_lease');
});
it('does no Gmail work when the shared lease is already held',async()=>{
 mocks.rpc.mockResolvedValueOnce({data:false,error:null});
 expect((await runSharedCollegeSync()).alreadyRunning).toBe(true);expect(mocks.gmail).not.toHaveBeenCalled();
});
it('retains the message offset until recipients with active user leases can be retried',async()=>{
 mocks.ingest.mockResolvedValue({canonicalId:'circular',deferredUsers:1});
 const result=await runSharedCollegeSync();
 expect(result).toMatchObject({userWorkPending:true,hasMore:true,failed:0});
 expect(mocks.ingest).toHaveBeenCalledOnce();
 const checkpoints=mocks.rpc.mock.calls.filter(call=>call[0]==='checkpoint_shared_college_sync');
 expect(checkpoints.at(-1)?.[1]).toMatchObject({p_pending_message_ids:['first','second'],p_pending_offset:0,p_pending_history_id:'history'});
});
