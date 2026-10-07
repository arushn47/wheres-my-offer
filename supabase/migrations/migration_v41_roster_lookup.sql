-- Additive cache only. Canonical rows remain authoritative; stale cache versions
-- are never used to infer presence or absence. No application/status rows change.
BEGIN;
ALTER TABLE public.college_attachments ADD COLUMN IF NOT EXISTS roster_revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE public.college_sheet_snapshots ADD COLUMN IF NOT EXISTS roster_revision BIGINT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS public.roster_lookup_indexes (
  source_kind TEXT NOT NULL CHECK(source_kind IN ('attachment','sheet')),
  source_key TEXT NOT NULL,
  source_revision BIGINT NOT NULL,
  policy_version INTEGER NOT NULL,
  usable BOOLEAN NOT NULL,
  legacy_roster_hash TEXT NOT NULL,
  token_locations JSONB NOT NULL,
  PRIMARY KEY(source_kind,source_key)
);
ALTER TABLE public.roster_lookup_indexes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.roster_lookup_indexes FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.roster_lookup_indexes TO service_role;

CREATE OR REPLACE FUNCTION public.bump_roster_revision() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  NEW.roster_revision := OLD.roster_revision + 1;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS roster_attachment_revision ON public.college_attachments;
CREATE TRIGGER roster_attachment_revision BEFORE UPDATE ON public.college_attachments
FOR EACH ROW WHEN (OLD.extracted_rows IS DISTINCT FROM NEW.extracted_rows OR OLD.parse_status IS DISTINCT FROM NEW.parse_status OR OLD.content_hash IS DISTINCT FROM NEW.content_hash OR OLD.filename IS DISTINCT FROM NEW.filename)
EXECUTE FUNCTION public.bump_roster_revision();
DROP TRIGGER IF EXISTS roster_sheet_revision ON public.college_sheet_snapshots;
CREATE TRIGGER roster_sheet_revision BEFORE UPDATE ON public.college_sheet_snapshots
FOR EACH ROW WHEN (OLD.extracted_rows IS DISTINCT FROM NEW.extracted_rows OR OLD.content_hash IS DISTINCT FROM NEW.content_hash)
EXECUTE FUNCTION public.bump_roster_revision();

CREATE OR REPLACE FUNCTION public.remove_roster_lookup() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='college_attachments' THEN
   DELETE FROM public.roster_lookup_indexes WHERE source_kind='attachment' AND source_key=OLD.id::TEXT;
 ELSE
   DELETE FROM public.roster_lookup_indexes WHERE source_kind='sheet' AND source_key=OLD.content_hash;
 END IF;
 RETURN OLD;
END; $$;
DROP TRIGGER IF EXISTS roster_attachment_cleanup ON public.college_attachments;
CREATE TRIGGER roster_attachment_cleanup AFTER DELETE ON public.college_attachments
FOR EACH ROW EXECUTE FUNCTION public.remove_roster_lookup();
DROP TRIGGER IF EXISTS roster_sheet_cleanup ON public.college_sheet_snapshots;
CREATE TRIGGER roster_sheet_cleanup AFTER DELETE ON public.college_sheet_snapshots
FOR EACH ROW EXECUTE FUNCTION public.remove_roster_lookup();
REVOKE ALL ON FUNCTION public.remove_roster_lookup() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.publish_roster_lookup(
 p_kind TEXT,p_key TEXT,p_revision BIGINT,p_policy INTEGER,p_usable BOOLEAN,p_hash TEXT,p_locations JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_revision BIGINT;
BEGIN
 IF p_kind='attachment' THEN
   SELECT roster_revision INTO current_revision FROM public.college_attachments WHERE id=p_key::UUID FOR SHARE;
 ELSIF p_kind='sheet' THEN
   SELECT roster_revision INTO current_revision FROM public.college_sheet_snapshots WHERE content_hash=p_key FOR SHARE;
 ELSE RAISE EXCEPTION 'Invalid roster kind'; END IF;
 IF current_revision IS NULL OR current_revision<>p_revision THEN RETURN FALSE; END IF;
 INSERT INTO public.roster_lookup_indexes(source_kind,source_key,source_revision,policy_version,usable,legacy_roster_hash,token_locations)
 VALUES(p_kind,p_key,p_revision,p_policy,p_usable,p_hash,p_locations)
 ON CONFLICT(source_kind,source_key) DO UPDATE SET source_revision=EXCLUDED.source_revision,policy_version=EXCLUDED.policy_version,
 usable=EXCLUDED.usable,legacy_roster_hash=EXCLUDED.legacy_roster_hash,token_locations=EXCLUDED.token_locations;
 RETURN TRUE;
END; $$;
REVOKE ALL ON FUNCTION public.publish_roster_lookup(TEXT,TEXT,BIGINT,INTEGER,BOOLEAN,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_roster_lookup(TEXT,TEXT,BIGINT,INTEGER,BOOLEAN,TEXT,JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.lookup_candidate_rosters(p_email_ids UUID[],p_token_hashes TEXT[],p_policy INTEGER)
RETURNS TABLE(source_kind TEXT,source_key TEXT,source_revision BIGINT,college_email_id UUID,filename TEXT,size_bytes BIGINT,
 content_hash TEXT,parse_status TEXT,index_ready BOOLEAN,usable BOOLEAN,legacy_roster_hash TEXT,match_location JSONB)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH sources AS (
   SELECT 'attachment'::TEXT AS kind,a.id::TEXT AS key,a.roster_revision AS revision,a.college_email_id AS email_id,
     a.filename,a.size_bytes::BIGINT,a.content_hash,a.parse_status
   FROM public.college_attachments a WHERE a.college_email_id=ANY(p_email_ids)
   UNION ALL
   SELECT 'sheet',s.content_hash,snap.roster_revision,s.college_email_id,'Google Sheet shortlist.csv',0::BIGINT,s.content_hash,s.parse_status
   FROM public.college_sheet_sources s LEFT JOIN public.college_sheet_snapshots snap ON snap.content_hash=s.content_hash
   WHERE s.college_email_id=ANY(p_email_ids)
 )
 SELECT s.kind,s.key,s.revision,s.email_id,s.filename,s.size_bytes,s.content_hash,s.parse_status,
   i.source_key IS NOT NULL,i.usable,i.legacy_roster_hash,m.location
 FROM sources s LEFT JOIN public.roster_lookup_indexes i ON i.source_kind=s.kind AND i.source_key=s.key
   AND i.source_revision=s.revision AND i.policy_version=p_policy
 LEFT JOIN LATERAL (
   SELECT i.token_locations->token AS location FROM unnest(p_token_hashes) token
   WHERE i.token_locations ? token
   ORDER BY ((i.token_locations->token)->>'sheetIndex')::INT,((i.token_locations->token)->>'rowNumber')::INT LIMIT 1
 ) m ON TRUE;
$$;
REVOKE ALL ON FUNCTION public.lookup_candidate_rosters(UUID[],TEXT[],INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_candidate_rosters(UUID[],TEXT[],INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.bump_roster_revision() FROM PUBLIC,anon,authenticated;
COMMIT;
