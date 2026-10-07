-- Preserve verdict history and JSON value types while omitting roster provenance
-- from page reads. Only the server's service role can choose a private user ID.
BEGIN;
CREATE OR REPLACE FUNCTION public.get_user_round_status_rows(
 p_user_id UUID, p_drive_ids UUID[] DEFAULT NULL, p_include_evaluations BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(placement_drive_id UUID, verdict JSONB, is_current BOOLEAN)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT v.placement_drive_id,
   COALESCE((SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(v.verdict) e
     WHERE e.key IN ('roundKey','roundType','state','outcome','eligible','finalNegative',
       'sourceReceivedAt','parserVersion','pptIncluded')), '{}'::jsonb)
   || CASE WHEN p_include_evaluations AND jsonb_typeof(v.verdict->'evaluations')='array'
     THEN jsonb_build_object('evaluations', COALESCE((SELECT jsonb_agg(
       COALESCE((SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(item) e
         WHERE e.key IN ('emailId','state')), '{}'::jsonb))
       FROM jsonb_array_elements(v.verdict->'evaluations') item), '[]'::jsonb))
     ELSE '{}'::jsonb END,
   v.is_current
 FROM public.round_verdicts v WHERE v.user_id=p_user_id
   AND (p_drive_ids IS NULL OR v.placement_drive_id=ANY(p_drive_ids));
$$;

-- The company list reduces these two histories to a latest timestamp per drive.
-- Do that reduction in SQL; keep the existing recent-circular and event logic.
CREATE OR REPLACE FUNCTION public.get_user_drive_activity(p_user_id UUID)
RETURNS TABLE(placement_drive_id UUID, received_at TIMESTAMPTZ)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT activity.placement_drive_id, max(activity.received_at)
 FROM (
   SELECT p.placement_drive_id,p.received_at FROM public.personal_emails p
     WHERE p.user_id=p_user_id AND p.placement_drive_id IS NOT NULL
   UNION ALL
   SELECT l.placement_drive_id,COALESCE(c.received_at,p.received_at) FROM public.email_drive_links l
     JOIN public.personal_emails p ON p.id=l.email_id AND p.user_id=p_user_id
     LEFT JOIN public.college_emails c ON c.id=COALESCE(p.college_email_id,p.canonical_email_id)
     WHERE l.user_id=p_user_id
 ) activity GROUP BY activity.placement_drive_id;
$$;
-- Search displays/searches only the first 500 JavaScript code units. PostgreSQL
-- returns at most 500 code points; the existing JS slice still gives the exact
-- original prefix even when astral characters occupy two UTF-16 code units.
CREATE OR REPLACE FUNCTION public.get_recent_college_search_rows()
RETURNS TABLE(id UUID,subject TEXT,sender_email TEXT,received_at TIMESTAMPTZ,created_at TIMESTAMPTZ,
 body_text TEXT,parsed_company_name TEXT,parsed_drive_numbers JSONB)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT c.id,c.subject,c.sender_email,c.received_at,c.created_at,left(c.body_text,500),
   c.parsed_company_name,c.parsed_drive_numbers FROM public.college_emails c
 ORDER BY c.received_at DESC LIMIT 40;
$$;
REVOKE ALL ON FUNCTION public.get_user_round_status_rows(UUID,UUID[],BOOLEAN),public.get_user_drive_activity(UUID),public.get_recent_college_search_rows() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_round_status_rows(UUID,UUID[],BOOLEAN),public.get_user_drive_activity(UUID),public.get_recent_college_search_rows() TO service_role;
COMMIT;
