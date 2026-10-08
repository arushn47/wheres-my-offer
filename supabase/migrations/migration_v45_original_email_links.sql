BEGIN;
CREATE TABLE IF NOT EXISTS public.original_email_links (
 user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 gmail_account_id UUID NOT NULL REFERENCES public.gmail_accounts(id) ON DELETE CASCADE,
 source_key TEXT NOT NULL CHECK (length(source_key)<60), connection_version TEXT NOT NULL,
 thread_id TEXT, claim UUID, last_lookup_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(gmail_account_id,source_key)
);
CREATE INDEX IF NOT EXISTS original_email_lookup_rate ON public.original_email_links(gmail_account_id,last_lookup_at);
ALTER TABLE public.original_email_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.original_email_links FROM anon,authenticated;
GRANT ALL ON public.original_email_links TO service_role;

CREATE OR REPLACE FUNCTION public.claim_original_email_lookup(p_user_id UUID,p_account_id UUID,p_source_key TEXT,p_connection_version TEXT,p_claim UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cached public.original_email_links;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.gmail_accounts WHERE id=p_account_id AND user_id=p_user_id AND is_connected) THEN
   RAISE EXCEPTION 'Connected account not owned';
 END IF;
 -- Cross-instance single-flight and rate bound; unrelated sync leases are untouched.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_account_id::text,0));
 SELECT * INTO cached FROM public.original_email_links WHERE gmail_account_id=p_account_id AND source_key=p_source_key;
 IF FOUND AND cached.connection_version=p_connection_version AND cached.expires_at>now() THEN
   RETURN jsonb_build_object('state',CASE WHEN cached.thread_id IS NULL THEN 'wait' ELSE 'ready' END,'threadId',cached.thread_id);
 END IF;
 IF (SELECT count(*) FROM public.original_email_links WHERE gmail_account_id=p_account_id AND last_lookup_at>now()-interval '1 minute')>=20 THEN
   RETURN jsonb_build_object('state','wait');
 END IF;
 INSERT INTO public.original_email_links(user_id,gmail_account_id,source_key,connection_version,claim,expires_at)
 VALUES(p_user_id,p_account_id,p_source_key,p_connection_version,p_claim,now()+interval '1 minute')
 ON CONFLICT(gmail_account_id,source_key) DO UPDATE SET connection_version=EXCLUDED.connection_version,thread_id=NULL,
   claim=EXCLUDED.claim,last_lookup_at=now(),expires_at=EXCLUDED.expires_at;
 RETURN jsonb_build_object('state','lookup');
END;
$$;
CREATE OR REPLACE FUNCTION public.complete_original_email_lookup(p_account_id UUID,p_source_key TEXT,p_claim UUID,p_thread_id TEXT)
RETURNS VOID LANGUAGE SQL SECURITY DEFINER SET search_path=public,pg_temp AS $$
 UPDATE public.original_email_links SET thread_id=p_thread_id,claim=NULL,
   expires_at=now()+CASE WHEN p_thread_id IS NULL THEN interval '5 minutes' ELSE interval '30 days' END
 WHERE gmail_account_id=p_account_id AND source_key=p_source_key AND claim=p_claim;
$$;
REVOKE ALL ON FUNCTION public.claim_original_email_lookup(UUID,UUID,TEXT,TEXT,UUID),public.complete_original_email_lookup(UUID,TEXT,UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_original_email_lookup(UUID,UUID,TEXT,TEXT,UUID),public.complete_original_email_lookup(UUID,TEXT,UUID,TEXT) TO service_role;
COMMIT;
