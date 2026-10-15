-- Preserve every source revision and candidate match. Store identical derived
-- lookup payloads once; the public RPC signatures remain compatible.
BEGIN;
SET LOCAL lock_timeout='3s';
LOCK TABLE public.sync_state,public.shared_college_sync_state,public.gmail_pubsub_inbox,
  public.college_archive_refresh_lease,public.roster_lookup_indexes IN SHARE ROW EXCLUSIVE MODE NOWAIT;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.sync_state WHERE is_syncing AND (lease_expires_at>now() OR lease_expires_at IS NULL AND updated_at>now()-interval '3 minutes'))
 OR EXISTS(SELECT 1 FROM public.shared_college_sync_state WHERE is_syncing AND lease_expires_at>now())
 OR EXISTS(SELECT 1 FROM public.gmail_pubsub_inbox WHERE status='processing' AND locked_until>now())
 OR EXISTS(SELECT 1 FROM public.college_archive_refresh_lease WHERE locked_until>now()) THEN
  RAISE EXCEPTION 'Active sync; retry roster migration after it finishes';
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.roster_lookup_payloads(
 payload_hash TEXT PRIMARY KEY,
 token_locations JSONB NOT NULL
);
ALTER TABLE public.roster_lookup_payloads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.roster_lookup_payloads FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.roster_lookup_payloads TO service_role;
ALTER TABLE public.roster_lookup_indexes ADD COLUMN IF NOT EXISTS payload_hash TEXT;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='roster_lookup_indexes' AND column_name='token_locations') THEN
  INSERT INTO public.roster_lookup_payloads(payload_hash,token_locations)
   SELECT DISTINCT encode(sha256(convert_to(token_locations::text,'UTF8')),'hex'),token_locations
   FROM public.roster_lookup_indexes ON CONFLICT DO NOTHING;
  UPDATE public.roster_lookup_indexes SET payload_hash=encode(sha256(convert_to(token_locations::text,'UTF8')),'hex');
  IF EXISTS(SELECT 1 FROM public.roster_lookup_indexes i LEFT JOIN public.roster_lookup_payloads p USING(payload_hash)
    WHERE p.token_locations IS DISTINCT FROM i.token_locations) THEN RAISE EXCEPTION 'Roster payload preservation failed'; END IF;
  ALTER TABLE public.roster_lookup_indexes DROP COLUMN token_locations;
 END IF;
END $$;
ALTER TABLE public.roster_lookup_indexes ALTER COLUMN payload_hash SET NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.roster_lookup_indexes'::regclass AND conname='roster_lookup_payload_fk') THEN
  ALTER TABLE public.roster_lookup_indexes ADD CONSTRAINT roster_lookup_payload_fk FOREIGN KEY(payload_hash) REFERENCES public.roster_lookup_payloads(payload_hash);
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS roster_lookup_payload_reference ON public.roster_lookup_indexes(payload_hash);

CREATE OR REPLACE FUNCTION public.publish_roster_lookup(
 p_kind TEXT,p_key TEXT,p_revision BIGINT,p_policy INTEGER,p_usable BOOLEAN,p_hash TEXT,p_locations JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_revision BIGINT; payload TEXT;
BEGIN
 IF p_kind='attachment' THEN
  SELECT roster_revision INTO current_revision FROM public.college_attachments WHERE id=p_key::UUID FOR SHARE;
 ELSIF p_kind='sheet' THEN
  SELECT roster_revision INTO current_revision FROM public.college_sheet_snapshots WHERE content_hash=p_key FOR SHARE;
 ELSE RAISE EXCEPTION 'Invalid roster kind'; END IF;
 IF current_revision IS NULL OR current_revision<>p_revision THEN RETURN FALSE; END IF;
 payload:=encode(sha256(convert_to(p_locations::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('roster-payload:'||payload,0));
 INSERT INTO public.roster_lookup_payloads VALUES(payload,p_locations) ON CONFLICT DO NOTHING;
 INSERT INTO public.roster_lookup_indexes AS stored(source_kind,source_key,source_revision,policy_version,usable,legacy_roster_hash,payload_hash)
 VALUES(p_kind,p_key,p_revision,p_policy,p_usable,p_hash,payload)
 ON CONFLICT(source_kind,source_key) DO UPDATE SET source_revision=EXCLUDED.source_revision,policy_version=EXCLUDED.policy_version,
  usable=EXCLUDED.usable,legacy_roster_hash=EXCLUDED.legacy_roster_hash,payload_hash=EXCLUDED.payload_hash
 WHERE (stored.source_revision,stored.policy_version,stored.usable,stored.legacy_roster_hash,stored.payload_hash)
  IS DISTINCT FROM (EXCLUDED.source_revision,EXCLUDED.policy_version,EXCLUDED.usable,EXCLUDED.legacy_roster_hash,EXCLUDED.payload_hash);
 RETURN TRUE;
END; $$;

CREATE OR REPLACE FUNCTION public.lookup_candidate_rosters(p_email_ids UUID[],p_token_hashes TEXT[],p_policy INTEGER)
RETURNS TABLE(source_kind TEXT,source_key TEXT,source_revision BIGINT,college_email_id UUID,filename TEXT,size_bytes BIGINT,
 content_hash TEXT,parse_status TEXT,index_ready BOOLEAN,usable BOOLEAN,legacy_roster_hash TEXT,match_location JSONB)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH sources AS MATERIALIZED (
  SELECT 'attachment'::TEXT kind,a.id::TEXT key,a.roster_revision revision,a.college_email_id email_id,
   a.filename,a.size_bytes::BIGINT,a.content_hash,a.parse_status FROM public.college_attachments a WHERE a.college_email_id=ANY(p_email_ids)
  UNION ALL
  SELECT 'sheet',s.content_hash,snap.roster_revision,s.college_email_id,'Google Sheet shortlist.csv',0::BIGINT,s.content_hash,s.parse_status
   FROM public.college_sheet_sources s LEFT JOIN public.college_sheet_snapshots snap ON snap.content_hash=s.content_hash WHERE s.college_email_id=ANY(p_email_ids)
 ), indexed AS MATERIALIZED (
  SELECT s.*,i.source_key IS NOT NULL ready,i.usable,i.legacy_roster_hash,i.payload_hash
   FROM sources s LEFT JOIN public.roster_lookup_indexes i ON i.source_kind=s.kind AND i.source_key=s.key AND i.source_revision=s.revision AND i.policy_version=p_policy
 ), wanted AS (SELECT DISTINCT payload_hash FROM indexed WHERE payload_hash IS NOT NULL),
 matches AS MATERIALIZED (
  SELECT p.payload_hash,(SELECT p.token_locations->token FROM unnest(p_token_hashes) token WHERE p.token_locations ? token
   ORDER BY ((p.token_locations->token)->>'sheetIndex')::INT,((p.token_locations->token)->>'rowNumber')::INT LIMIT 1) location
   FROM public.roster_lookup_payloads p JOIN wanted w USING(payload_hash)
 )
 SELECT i.kind,i.key,i.revision,i.email_id,i.filename,i.size_bytes,i.content_hash,i.parse_status,i.ready,i.usable,i.legacy_roster_hash,m.location
  FROM indexed i LEFT JOIN matches m USING(payload_hash);
$$;

-- Only unreferenced derived payloads are disposable. Source rows and the
-- currently referenced lookup versions never enter this bounded cleanup.
CREATE OR REPLACE FUNCTION public.prune_roster_lookup_payloads(p_limit INTEGER DEFAULT 100)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate TEXT; removed INTEGER:=0; affected INTEGER;
BEGIN
 FOR candidate IN SELECT p.payload_hash FROM public.roster_lookup_payloads p
   WHERE NOT EXISTS(SELECT 1 FROM public.roster_lookup_indexes i WHERE i.payload_hash=p.payload_hash)
   ORDER BY p.payload_hash LIMIT least(greatest(p_limit,0),500) LOOP
  IF pg_try_advisory_xact_lock(hashtextextended('roster-payload:'||candidate,0)) THEN
   DELETE FROM public.roster_lookup_payloads p WHERE p.payload_hash=candidate
    AND NOT EXISTS(SELECT 1 FROM public.roster_lookup_indexes i WHERE i.payload_hash=p.payload_hash);
   GET DIAGNOSTICS affected=ROW_COUNT; removed:=removed+affected;
  END IF;
 END LOOP;
 RETURN removed;
END; $$;
REVOKE ALL ON FUNCTION public.prune_roster_lookup_payloads(INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prune_roster_lookup_payloads(INTEGER) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
-- Reclaim the old duplicate TOAST storage in a separate, guarded maintenance
-- step after commit: VACUUM (FULL,ANALYZE) public.roster_lookup_indexes;
