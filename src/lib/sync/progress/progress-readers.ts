import type { createAdminClient } from '@/lib/supabase/admin';
import { optimizedReadEnabled, allowLegacyReadFallback } from '@/lib/supabase/read-policy';
type Admin=ReturnType<typeof createAdminClient>;
export interface PageProgress {gmail_account_id:string;page_index:number;message_count:number|null;next_offset:number|null}
export interface SharedProgress {
 gmail_account_id:string;is_syncing:boolean;phase:string;initial_scan_complete:boolean;next_page_token:string|null;
 pending_message_count:number;pending_offset:number;updated_at:string;lease_expires_at:string|null;last_error:string|null;
}
const missingMigration=allowLegacyReadFallback;
export async function readPersonalPageProgress(admin:Admin,userId:string,accountIds:string[]):Promise<PageProgress[]|null>{
 if(optimizedReadEnabled('COMPACT_SYNC_PROGRESS_ENABLED')){
   const {data,error}=await admin.rpc('get_user_sync_page_progress',{p_user_id:userId,p_account_ids:accountIds});
   if(!error)return data as PageProgress[]|null;
   if(!missingMigration(error))throw error;
 }
 const {data,error}=await admin.from('sync_pages').select('gmail_account_id,page_index,message_ids,next_offset')
   .eq('user_id',userId).in('gmail_account_id',accountIds).neq('status','complete').order('page_index',{ascending:true});
 if(error)throw error;
 return data?.map(page=>({gmail_account_id:page.gmail_account_id,page_index:page.page_index,next_offset:page.next_offset,
   message_count:Array.isArray(page.message_ids)?page.message_ids.length:null}))||null;
}
export async function readSharedProgress(admin:Admin):Promise<SharedProgress|null>{
 if(optimizedReadEnabled('COMPACT_SYNC_PROGRESS_ENABLED')){
   const {data,error}=await admin.rpc('get_shared_college_progress');
   if(!error)return (data as SharedProgress[]|null)?.[0]||null;
   if(!missingMigration(error))throw error;
 }
 const {data,error}=await admin.from('shared_college_sync_state')
   .select('gmail_account_id,is_syncing,phase,initial_scan_complete,next_page_token,pending_message_ids,pending_offset,updated_at,lease_expires_at,last_error')
   .order('updated_at',{ascending:false}).limit(1);
 if(error)throw error;
 const row=data?.[0];
 if(!row)return null;
 const {pending_message_ids,...rest}=row;
 return {...rest,pending_message_count:Array.isArray(pending_message_ids)?pending_message_ids.length:0};
}
