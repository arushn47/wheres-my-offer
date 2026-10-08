BEGIN;
ALTER TABLE public.placement_drives ADD COLUMN IF NOT EXISTS recruitment_venues JSONB;
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.placement_drives'::regclass AND conname='placement_drives_venues_bounded') THEN
ALTER TABLE public.placement_drives ADD CONSTRAINT placement_drives_venues_bounded
 CHECK (recruitment_venues IS NULL OR (jsonb_typeof(recruitment_venues)='object'
 AND octet_length(recruitment_venues::text)<=12000));
END IF;
END $$;

-- Row lock serializes same-drive ingestion; never changes activity timestamps.
CREATE OR REPLACE FUNCTION public.merge_drive_recruitment_venues(
 p_drive_id UUID,p_source_id UUID,p_received_at TIMESTAMPTZ,p_entries JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE previous JSONB; merged JSONB; drive public.placement_drives; source public.college_emails; numbers JSONB;
BEGIN
 IF p_received_at IS NULL OR jsonb_typeof(p_entries)<>'array' OR jsonb_array_length(p_entries)>12 THEN
   RAISE EXCEPTION 'Invalid venue projection';
 END IF;
 SELECT * INTO source FROM public.college_emails WHERE id=p_source_id;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'Canonical venue source missing';
 END IF;
 SELECT * INTO drive FROM public.placement_drives WHERE id=p_drive_id FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 IF source.classification='irrelevant' OR p_source_id::text=ANY(COALESCE(drive.excluded_email_ids,'{}'::text[])) THEN RETURN; END IF;
 numbers := CASE WHEN jsonb_typeof(source.parsed_drive_numbers)='array' THEN source.parsed_drive_numbers ELSE '[]'::jsonb END;
 -- Reject pooled/conflicting numbers, even on a stale primary anchor. A fuzzy role/company
 -- assignment alone is insufficient: require the exact canonical anchor or explicit number.
 IF jsonb_array_length(numbers)>0 THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(numbers) n WHERE lower(trim(n)) NOT IN (
     COALESCE(lower(drive.drive_number),''),COALESCE(lower(drive.normalized_drive_number),''),
     COALESCE(substring(drive.normalized_drive_number FROM '[0-9]+$'),'')
   )) THEN RETURN; END IF;
 ELSIF drive.source_college_email_id IS DISTINCT FROM p_source_id THEN RETURN;
 END IF;
 previous := drive.recruitment_venues;
 SELECT jsonb_build_object('version',1,'entries',COALESCE(jsonb_agg(entry ORDER BY entry->>'stage',entry->>'audience'),'[]'::jsonb)) INTO merged
 FROM (SELECT DISTINCT ON (entry->>'stage',COALESCE(entry->>'audience','')) entry FROM (
   SELECT value AS entry,0 AS priority FROM jsonb_array_elements(COALESCE(previous->'entries','[]'::jsonb))
   UNION ALL
   SELECT value || jsonb_build_object('sourceId',p_source_id,'receivedAt',p_received_at),1 FROM jsonb_array_elements(p_entries)
 ) all_entries ORDER BY entry->>'stage',COALESCE(entry->>'audience',''),(entry->>'receivedAt')::timestamptz DESC,entry->>'sourceId' DESC,priority DESC LIMIT 12) current_entries;
 UPDATE public.placement_drives SET recruitment_venues=merged WHERE id=p_drive_id AND recruitment_venues IS DISTINCT FROM merged;
END;
$$;
REVOKE ALL ON FUNCTION public.merge_drive_recruitment_venues(UUID,UUID,TIMESTAMPTZ,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.merge_drive_recruitment_venues(UUID,UUID,TIMESTAMPTZ,JSONB) TO service_role;
COMMIT;
