import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({session:vi.fn(),query:vi.fn()}));
vi.mock('@/lib/auth',()=>({getSession:mocks.session}));
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>({from:mocks.query})}));
import {GET} from './route';
beforeEach(()=>{vi.resetAllMocks();mocks.session.mockResolvedValue({userId:'owner'});});
it('returns only the current owner’s version and active lease without dispatching work',async()=>{
  const queries:Array<{table:string,columns?:string,filters:Array<unknown>}> = [];
  mocks.query.mockImplementation((table:string)=>{
    const capture={table,columns:'',filters:[] as unknown[]};queries.push(capture);
    const q={select:(columns:string)=>{capture.columns=columns;return q},eq:(key:string,value:string)=>{capture.filters.push([key,value]);return q},order:()=>q,limit:()=>q,
      maybeSingle:async()=>({data:table==='applications'?{last_updated:'revision'}:{is_syncing:true,lease_expires_at:new Date(Date.now()+60000).toISOString()},error:null})};return q;
  });
  expect(await (await GET()).json()).toEqual({version:'revision',isSyncing:true});
  expect(queries.every(q=>q.filters.some(f=>JSON.stringify(f)===JSON.stringify(['user_id','owner'])))).toBe(true);
  expect(queries.map(q=>q.columns)).toEqual(['last_updated','is_syncing,updated_at,lease_expires_at']);
});
it('rejects unauthenticated reads without querying the database',async()=>{
  mocks.session.mockResolvedValue(null);expect((await GET()).status).toBe(401);expect(mocks.query).not.toHaveBeenCalled();
});
