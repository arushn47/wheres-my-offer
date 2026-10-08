import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({watch:vi.fn()}));
vi.mock('./client',()=>({createGmailClient:async()=>({gmail:{users:{watch:mocks.watch}}})}));
import {renewExpiringWatches} from './watch';
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
it('renews notification coverage without advancing the processed-mail cursor',async()=>{
  vi.stubEnv('GOOGLE_PUBSUB_TOPIC','topic');
  mocks.watch.mockResolvedValue({data:{historyId:'999',expiration:String(Date.now()+604800000)}});
  const update=vi.fn().mockReturnValue({eq:async()=>({error:null})});
  const admin={from:()=>({select:()=>({eq:()=>({or:async()=>({data:[{id:'personal',email:'user@gmail.com',account_type:'personal',last_history_id:'100'}]})})}),update})} as unknown as Parameters<typeof renewExpiringWatches>[0];
  expect(await renewExpiringWatches(admin)).toEqual({renewed:1,failed:0});
  expect(update.mock.calls[0][0]).toHaveProperty('watch_expires_at');
  expect(update.mock.calls[0][0]).not.toHaveProperty('last_history_id');
});
