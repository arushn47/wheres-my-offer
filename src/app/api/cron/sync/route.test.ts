import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
const mocks=vi.hoisted(()=>({after:vi.fn(),runSync:vi.fn(),renew:vi.fn(),live:vi.fn(),deadlines:vi.fn(),shared:vi.fn(),query:vi.fn()}));
vi.mock('next/server',()=>({after:mocks.after,NextResponse:{json:(data:unknown,init?:ResponseInit)=>new Response(JSON.stringify(data),{...init,headers:{'content-type':'application/json'}})}}));
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>({from:mocks.query})}));
vi.mock('@/lib/sync/engine',()=>({runSync:mocks.runSync,CRON_TOTAL_BUDGET_MS:270000}));
vi.mock('@/lib/gmail/watch',()=>({renewExpiringWatches:mocks.renew}));
vi.mock('@/lib/notifications/service',()=>({checkAndNotifyLiveEvents:mocks.live,checkAndNotifyRegistrationDeadlines:mocks.deadlines}));
vi.mock('@/lib/sync/canonical/shared-college-sync',()=>({runSharedCollegeSync:mocks.shared}));
import { GET } from './route';
beforeEach(()=>{
 vi.resetAllMocks();vi.stubEnv('CRON_SECRET','test');vi.stubEnv('SHARED_COLLEGE_SYNC_ENABLED','true');
 mocks.query.mockImplementation(()=>({select:()=>({eq:async()=>({data:[{user_id:'one'},{user_id:'two'}],error:null})}),delete:()=>({eq:()=>({lt:async()=>({error:null})}),lt:async()=>({error:null})})}));
 mocks.renew.mockResolvedValue({renewed:0,failed:0});mocks.shared.mockResolvedValue({alreadyRunning:false,failed:0,hasMore:false});
 mocks.runSync.mockResolvedValue({alreadyRunning:false});
});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
const request=(wait:boolean)=>({headers:new Headers({authorization:'Bearer test'}),nextUrl:new URL('https://example.test/api/cron/sync'+(wait?'?wait=true':''))}) as unknown as NextRequest;
it('wait mode renews watches and shares one deadline across all users and the College worker',async()=>{
 const response=await GET(request(true));
 expect(response.status).toBe(200);expect(mocks.renew).toHaveBeenCalledOnce();
 const deadline=mocks.shared.mock.calls[0][0].globalDeadline;
 expect(mocks.runSync.mock.calls.every(call=>call[2].globalDeadline===deadline)).toBe(true);
 expect(mocks.live).toHaveBeenCalledTimes(2);expect(mocks.deadlines).toHaveBeenCalledTimes(2);
 expect((await response.json()).usersProcessed).toBe(2);
});
it('responds first and performs background work in after()',async()=>{
 await GET(request(false));
 expect(mocks.runSync).not.toHaveBeenCalled();expect(mocks.renew).not.toHaveBeenCalled();
 await mocks.after.mock.calls[0][0]();expect(mocks.runSync).toHaveBeenCalledTimes(2);
});
it('skips active user locks and their duplicate notifications',async()=>{
 mocks.runSync.mockResolvedValueOnce({alreadyRunning:true});
 const response=await GET(request(true)),body=await response.json();
 expect(body.details[0].status).toBe('skipped_already_running');
 expect(mocks.live).toHaveBeenCalledTimes(1);expect(mocks.deadlines).toHaveBeenCalledTimes(1);
});
it('includes maintenance time in the shared deadline',async()=>{
 let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now);
 mocks.renew.mockImplementation(async()=>{now+=280000;return {renewed:0,failed:0};});
 const response=await GET(request(true));
 expect(mocks.runSync).not.toHaveBeenCalled();expect(mocks.shared).not.toHaveBeenCalled();
 expect((await response.json()).usersProcessed).toBe(0);
});
it('reports a failed account query rather than claiming no accounts exist',async()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});
 mocks.query.mockReturnValue({select:()=>({eq:async()=>({error:{message:'query failed'}})})});
 expect((await GET(request(true))).status).toBe(500);
});
