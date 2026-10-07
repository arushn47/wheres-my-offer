-- Keep message ID queues private and return only their sizes to progress readers.
BEGIN;
CREATE OR REPLACE FUNCTION public.get_user_sync_page_progress(p_user_id UUID,p_account_ids UUID[])
RETURNS TABLE(gmail_account_id UUID,page_index INTEGER,message_count INTEGER,next_offset INTEGER)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p.gmail_account_id,p.page_index,
   CASE WHEN jsonb_typeof(p.message_ids)='array' THEN jsonb_array_length(p.message_ids) ELSE NULL END,
   p.next_offset
 FROM public.sync_pages p WHERE p.user_id=p_user_id AND p.gmail_account_id=ANY(p_account_ids)
   AND p.status<>'complete' ORDER BY p.page_index;
$$;
CREATE OR REPLACE FUNCTION public.get_shared_college_progress()
RETURNS TABLE(gmail_account_id UUID,is_syncing BOOLEAN,phase TEXT,initial_scan_complete BOOLEAN,next_page_token TEXT,
 pending_message_count INTEGER,pending_offset INTEGER,updated_at TIMESTAMPTZ,lease_expires_at TIMESTAMPTZ,last_error TEXT)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT s.gmail_account_id,s.is_syncing,s.phase,s.initial_scan_complete,s.next_page_token,
   CASE WHEN jsonb_typeof(s.pending_message_ids)='array' THEN jsonb_array_length(s.pending_message_ids) ELSE 0 END,
   s.pending_offset,s.updated_at,s.lease_expires_at,s.last_error
 FROM public.shared_college_sync_state s ORDER BY s.updated_at DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.get_user_sync_page_progress(UUID,UUID[]),public.get_shared_college_progress() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_sync_page_progress(UUID,UUID[]),public.get_shared_college_progress() TO service_role;
COMMIT;
