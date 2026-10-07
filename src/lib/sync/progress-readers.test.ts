import { afterEach, expect, it, vi } from 'vitest';
import { readPersonalPageProgress, readSharedProgress } from './progress-readers';
import type { createAdminClient } from '@/lib/supabase/admin';
type Admin=ReturnType<typeof createAdminClient>;
afterEach(()=>vi.unstubAllEnvs());
const legacyQuery=(data:unknown)=>({select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),in:vi.fn().mockReturnThis(),neq:vi.fn().mockReturnThis(),order:vi.fn().mockResolvedValue({data,error:null})});
it('uses account and session scope for compact personal progress',async()=>{
 vi.stubEnv('COMPACT_SYNC_PROGRESS_ENABLED','true');
 const rows=[{gmail_account_id:'account',page_index:0,message_count:100,next_offset:20}];
 const rpc=vi.fn().mockResolvedValue({data:rows,error:null}),from=vi.fn();
 expect(await readPersonalPageProgress({rpc,from} as unknown as Admin,'user',['account'])).toEqual(rows);
 expect(rpc).toHaveBeenCalledWith('get_user_sync_page_progress',{p_user_id:'user',p_account_ids:['account']});
 expect(from).not.toHaveBeenCalled();
});
it('keeps legacy progress counts when rollout is disabled',async()=>{
 vi.stubEnv('COMPACT_SYNC_PROGRESS_ENABLED','false');
 const query=legacyQuery([{gmail_account_id:'account',page_index:0,message_ids:['a','b'],next_offset:1}]);
 const rpc=vi.fn();
 expect(await readPersonalPageProgress({rpc,from:()=>query} as unknown as Admin,'user',['account'])).toEqual([{gmail_account_id:'account',page_index:0,message_count:2,next_offset:1}]);
 expect(rpc).not.toHaveBeenCalled();expect(query.eq).toHaveBeenCalledWith('user_id','user');
});
it('falls back on missing compact-progress RPCs',async()=>{
 vi.stubEnv('COMPACT_SYNC_PROGRESS_ENABLED','true');
 const query=legacyQuery([{gmail_account_id:'account',page_index:1,message_ids:null,next_offset:0}]);
 const rpc=vi.fn().mockResolvedValue({error:{code:'PGRST202'}});
 expect((await readPersonalPageProgress({rpc,from:()=>query} as unknown as Admin,'user',['account']))?.[0].message_count).toBeNull();
});
it('returns compact shared progress without a queue read',async()=>{
 vi.stubEnv('COMPACT_SYNC_PROGRESS_ENABLED','true');
 const state={gmail_account_id:'account',pending_message_count:100,pending_offset:20};
 const rpc=vi.fn().mockResolvedValue({data:[state],error:null}),from=vi.fn();
 expect(await readSharedProgress({rpc,from} as unknown as Admin)).toEqual(state);
 expect(from).not.toHaveBeenCalled();
});
it('preserves shared progress when the migration is unavailable',async()=>{
 vi.stubEnv('COMPACT_SYNC_PROGRESS_ENABLED','true');
 const state={gmail_account_id:'account',pending_message_ids:['a','b'],pending_offset:1};
 const query={select:vi.fn().mockReturnThis(),order:vi.fn().mockReturnThis(),limit:vi.fn().mockResolvedValue({data:[state],error:null})};
 const rpc=vi.fn().mockResolvedValue({error:{code:'PGRST202'}});
 expect(await readSharedProgress({rpc,from:()=>query} as unknown as Admin)).toEqual({gmail_account_id:'account',pending_message_count:2,pending_offset:1});
});
it('does not hide unexpected progress query failures',async()=>{
 vi.stubEnv('COMPACT_SYNC_PROGRESS_ENABLED','true');
 const error={code:'57014'},rpc=vi.fn().mockResolvedValue({error});
 await expect(readSharedProgress({rpc} as unknown as Admin)).rejects.toEqual(error);
});
