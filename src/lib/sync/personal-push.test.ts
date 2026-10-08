import {expect,it,vi} from 'vitest';
import {drainPersonalPush} from './personal-push';
const complete={errors:[],hasMorePagesPending:false};
function params(sync=vi.fn(),history='123') {
  const query={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:async()=>({data:{last_history_id:history},error:null})};
  return {sync:sync as unknown as Parameters<typeof drainPersonalPush>[0]['sync'],admin:{from:()=>query} as unknown as Parameters<typeof drainPersonalPush>[0]['admin'],userId:'user',accountId:'account',historyId:'123'};
}
it('drains saved pages under one deadline before acknowledging the notification',async()=>{
  const sync=vi.fn().mockResolvedValueOnce({...complete,hasMorePagesPending:true}).mockResolvedValueOnce(complete);
  await drainPersonalPush(params(sync));expect(sync).toHaveBeenCalledTimes(2);
  expect(sync.mock.calls[0][2].globalDeadline).toBe(sync.mock.calls[1][2].globalDeadline);
});
it('leaves a concurrent owner intact and requires a retry',async()=>{
  const sync=vi.fn().mockResolvedValue({...complete,alreadyRunning:true});
  await expect(drainPersonalPush(params(sync))).rejects.toThrow('already running');expect(sync).toHaveBeenCalledOnce();
});
it('does not acknowledge a returned sync error or a cursor behind the notification',async()=>{
  await expect(drainPersonalPush(params(vi.fn().mockResolvedValue({...complete,errors:['Failed']})))).rejects.toThrow('Failed');
  const sync=vi.fn().mockResolvedValue(complete);
  await expect(drainPersonalPush(params(sync,'122'))).rejects.toThrow('saved work remaining');
  expect(sync).toHaveBeenCalledTimes(2);
});
