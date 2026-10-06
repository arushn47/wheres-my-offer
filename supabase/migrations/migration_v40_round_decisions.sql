BEGIN;

CREATE TABLE IF NOT EXISTS public.round_verdicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  placement_drive_id UUID NOT NULL REFERENCES public.placement_drives(id) ON DELETE CASCADE,
  round_key TEXT NOT NULL,
  verdict JSONB NOT NULL,
  source_received_at TIMESTAMPTZ NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, placement_drive_id, round_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS round_verdicts_current ON public.round_verdicts(user_id, placement_drive_id) WHERE is_current;
ALTER TABLE public.round_verdicts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS round_verdicts_own_read ON public.round_verdicts;
CREATE POLICY round_verdicts_own_read ON public.round_verdicts FOR SELECT TO authenticated USING (user_id = auth.uid());
GRANT SELECT ON public.round_verdicts TO authenticated;
GRANT ALL ON public.round_verdicts TO service_role;

ALTER TABLE public.events ADD COLUMN IF NOT EXISTS round_key TEXT;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS extraction_evidence JSONB;
ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS extraction_evidence JSONB;
ALTER TABLE public.placement_drives ADD COLUMN IF NOT EXISTS extraction_evidence JSONB;
ALTER TABLE public.candidate_matches ADD COLUMN IF NOT EXISTS evidence JSONB;
ALTER TABLE public.candidate_matches ADD COLUMN IF NOT EXISTS roster_key TEXT;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS eligibility_decision_id UUID REFERENCES public.round_verdicts(id) ON DELETE SET NULL;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS decision_id UUID REFERENCES public.round_verdicts(id) ON DELETE SET NULL;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS push_delivered_at TIMESTAMPTZ;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS push_claimed_at TIMESTAMPTZ;
ALTER TABLE public.candidate_matches DROP CONSTRAINT IF EXISTS candidate_matches_matched_round_type_check;
ALTER TABLE public.candidate_matches ADD CONSTRAINT candidate_matches_matched_round_type_check CHECK (matched_round_type IS NULL OR matched_round_type IN ('test','test_r2','game','gd','ppt','post_ppt','interview','interview_r2','selected'));

CREATE OR REPLACE FUNCTION public.claim_notification_push(p_notification_id UUID) RETURNS BOOLEAN
LANGUAGE SQL VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 UPDATE public.notifications n SET push_claimed_at=NOW()
 WHERE n.id=p_notification_id AND n.push_delivered_at IS NULL AND n.superseded_at IS NULL
 AND (n.push_claimed_at IS NULL OR n.push_claimed_at<NOW()-INTERVAL '2 minutes')
 AND (n.decision_id IS NULL OR EXISTS(SELECT 1 FROM public.round_verdicts d WHERE d.id=n.decision_id AND d.is_current AND (d.verdict->>'eligible')::BOOLEAN))
 RETURNING TRUE;
$$;
REVOKE ALL ON FUNCTION public.claim_notification_push(UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_push(UUID) TO service_role;

CREATE TABLE IF NOT EXISTS public.decision_notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  decision_id UUID NOT NULL REFERENCES public.round_verdicts(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.decision_notification_outbox ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.decision_notification_outbox TO service_role;

CREATE TABLE IF NOT EXISTS public.calendar_removal_outbox (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 gcal_event_id TEXT NOT NULL, completed_at TIMESTAMPTZ, UNIQUE(user_id,gcal_event_id)
);
ALTER TABLE public.calendar_removal_outbox ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.calendar_removal_outbox TO service_role;

CREATE TABLE IF NOT EXISTS public.pending_drive_recalculations (
 user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 placement_drive_id UUID NOT NULL REFERENCES public.placement_drives(id) ON DELETE CASCADE,
 source_received_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(user_id,placement_drive_id)
);
ALTER TABLE public.pending_drive_recalculations ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.pending_drive_recalculations TO service_role;

CREATE TABLE IF NOT EXISTS public.college_sheet_snapshots (
 content_hash TEXT PRIMARY KEY, source_url TEXT NOT NULL, extracted_rows JSONB NOT NULL, fetched_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS public.college_sheet_sources (
 college_email_id UUID NOT NULL REFERENCES public.college_emails(id) ON DELETE CASCADE,
 source_url TEXT NOT NULL, content_hash TEXT REFERENCES public.college_sheet_snapshots(content_hash),
 parse_status TEXT NOT NULL CHECK(parse_status IN ('complete','deferred')), fetched_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(college_email_id,source_url)
);
ALTER TABLE public.college_sheet_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.college_sheet_sources ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.college_sheet_snapshots,public.college_sheet_sources TO service_role;

CREATE OR REPLACE FUNCTION public.assert_sync_lease(p_user_id UUID, p_run_id UUID) RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM public.sync_state WHERE user_id=p_user_id AND run_id=p_run_id AND is_syncing AND lease_expires_at>NOW());
$$;
REVOKE ALL ON FUNCTION public.assert_sync_lease(UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.assert_sync_lease(UUID,UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.fence_sync_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE owner TEXT; row_user UUID;
BEGIN
 owner := NULLIF(current_setting('request.headers',TRUE),'')::JSONB->>'x-sync-run-id';
 row_user := CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
 IF owner IS NOT NULL AND NOT public.assert_sync_lease(row_user,owner::UUID) THEN RAISE EXCEPTION 'Sync lease lost; write rejected'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS fence_sync_mutation ON public.applications;
CREATE TRIGGER fence_sync_mutation BEFORE INSERT OR UPDATE OR DELETE ON public.applications FOR EACH ROW EXECUTE FUNCTION public.fence_sync_mutation();
DROP TRIGGER IF EXISTS fence_sync_mutation ON public.events;
CREATE TRIGGER fence_sync_mutation BEFORE INSERT OR UPDATE OR DELETE ON public.events FOR EACH ROW EXECUTE FUNCTION public.fence_sync_mutation();
DROP TRIGGER IF EXISTS fence_sync_mutation ON public.candidate_matches;
CREATE TRIGGER fence_sync_mutation BEFORE INSERT OR UPDATE OR DELETE ON public.candidate_matches FOR EACH ROW EXECUTE FUNCTION public.fence_sync_mutation();

CREATE OR REPLACE FUNCTION public.reconcile_drive_events(p_user_id UUID,p_run_id UUID,p_drive_id UUID,p_events JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM public.sync_state WHERE user_id=p_user_id AND run_id=p_run_id AND is_syncing AND lease_expires_at>NOW() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Sync lease lost'; END IF;
 INSERT INTO public.calendar_removal_outbox(user_id,gcal_event_id)
 SELECT p_user_id,e.gcal_event_id FROM public.events e WHERE e.user_id=p_user_id AND e.placement_drive_id=p_drive_id AND NOT e.manual_override AND e.gcal_event_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_events) j WHERE j->>'event_type'=e.event_type AND ((j->>'round_number')::INTEGER=e.round_number OR (j->>'start_time')::TIMESTAMPTZ=e.start_time))
 ON CONFLICT(user_id,gcal_event_id) DO NOTHING;
 DELETE FROM public.events e WHERE e.user_id=p_user_id AND e.placement_drive_id=p_drive_id AND NOT e.manual_override
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_events) j WHERE j->>'event_type'=e.event_type AND ((j->>'round_number')::INTEGER=e.round_number OR (j->>'start_time')::TIMESTAMPTZ=e.start_time));
 WITH desired AS (
   SELECT DISTINCT ON (j->>'event_type',(j->>'start_time')::TIMESTAMPTZ) j
   FROM jsonb_array_elements(p_events) WITH ORDINALITY AS x(j,ordinality)
   WHERE j->>'event_type' IS NOT NULL AND j->>'start_time' IS NOT NULL
   ORDER BY j->>'event_type',(j->>'start_time')::TIMESTAMPTZ,ordinality DESC
 )
 INSERT INTO public.calendar_removal_outbox(user_id,gcal_event_id)
 SELECT p_user_id,e.gcal_event_id
 FROM public.events e
 JOIN desired d ON d.j->>'event_type'=e.event_type AND (d.j->>'round_number')::INTEGER=e.round_number
 WHERE e.user_id=p_user_id AND e.placement_drive_id=p_drive_id AND NOT e.manual_override
   AND e.gcal_event_id IS NOT NULL AND e.start_time IS DISTINCT FROM (d.j->>'start_time')::TIMESTAMPTZ
 ON CONFLICT(user_id,gcal_event_id) DO NOTHING;
 WITH desired AS (
   SELECT DISTINCT ON (j->>'event_type',(j->>'start_time')::TIMESTAMPTZ) j
   FROM jsonb_array_elements(p_events) WITH ORDINALITY AS x(j,ordinality)
   WHERE j->>'event_type' IS NOT NULL AND j->>'start_time' IS NOT NULL
   ORDER BY j->>'event_type',(j->>'start_time')::TIMESTAMPTZ,ordinality DESC
 )
 DELETE FROM public.events e USING desired d
 WHERE e.user_id=p_user_id AND e.placement_drive_id=p_drive_id AND NOT e.manual_override
   AND d.j->>'event_type'=e.event_type AND (d.j->>'round_number')::INTEGER=e.round_number
   AND e.start_time IS DISTINCT FROM (d.j->>'start_time')::TIMESTAMPTZ;
 WITH desired AS (
   SELECT DISTINCT ON (j->>'event_type',(j->>'start_time')::TIMESTAMPTZ) j
   FROM jsonb_array_elements(p_events) WITH ORDINALITY AS x(j,ordinality)
   WHERE j->>'event_type' IS NOT NULL AND j->>'start_time' IS NOT NULL
   ORDER BY j->>'event_type',(j->>'start_time')::TIMESTAMPTZ,ordinality DESC
 )
 UPDATE public.events e SET title=d.j->>'title',end_time=(d.j->>'end_time')::TIMESTAMPTZ,venue=d.j->>'venue',mode=d.j->>'mode',confidence=d.j->>'confidence',
   round_number=(d.j->>'round_number')::INTEGER,round_label=d.j->>'round_label',round_key=d.j->>'round_key',college_email_id=(d.j->>'college_email_id')::UUID,
   source_email_received_at=(d.j->>'source_email_received_at')::TIMESTAMPTZ,extraction_evidence=d.j->'extraction_evidence',
   eligibility_decision_id=(SELECT rv.id FROM public.round_verdicts rv WHERE rv.user_id=p_user_id AND rv.placement_drive_id=p_drive_id AND rv.round_key=d.j->>'round_key'),updated_at=NOW()
 FROM desired d
 WHERE e.user_id=p_user_id AND e.placement_drive_id=p_drive_id AND NOT e.manual_override
   AND e.event_type=d.j->>'event_type' AND e.start_time=(d.j->>'start_time')::TIMESTAMPTZ;
 WITH desired AS (
   SELECT DISTINCT ON (j->>'event_type',(j->>'start_time')::TIMESTAMPTZ) j
   FROM jsonb_array_elements(p_events) WITH ORDINALITY AS x(j,ordinality)
   WHERE j->>'event_type' IS NOT NULL AND j->>'start_time' IS NOT NULL
   ORDER BY j->>'event_type',(j->>'start_time')::TIMESTAMPTZ,ordinality DESC
 )
 INSERT INTO public.events(user_id,placement_drive_id,event_type,title,start_time,end_time,venue,mode,confidence,manual_override,round_number,round_label,round_key,college_email_id,source_email_received_at,extraction_evidence,eligibility_decision_id)
 SELECT p_user_id,p_drive_id,j->>'event_type',j->>'title',(j->>'start_time')::TIMESTAMPTZ,(j->>'end_time')::TIMESTAMPTZ,
 j->>'venue',j->>'mode',j->>'confidence',FALSE,(j->>'round_number')::INTEGER,j->>'round_label',j->>'round_key',(j->>'college_email_id')::UUID,(j->>'source_email_received_at')::TIMESTAMPTZ,j->'extraction_evidence',(SELECT d.id FROM public.round_verdicts d WHERE d.user_id=p_user_id AND d.placement_drive_id=p_drive_id AND d.round_key=j->>'round_key')
 FROM desired
 WHERE NOT EXISTS (SELECT 1 FROM public.events e WHERE e.user_id=p_user_id AND e.placement_drive_id=p_drive_id AND e.event_type=desired.j->>'event_type' AND e.start_time=(desired.j->>'start_time')::TIMESTAMPTZ)
 ON CONFLICT(user_id,placement_drive_id,event_type,round_number) DO UPDATE SET title=EXCLUDED.title,start_time=EXCLUDED.start_time,end_time=EXCLUDED.end_time,venue=EXCLUDED.venue,mode=EXCLUDED.mode,confidence=EXCLUDED.confidence,
 round_label=EXCLUDED.round_label,round_key=EXCLUDED.round_key,college_email_id=EXCLUDED.college_email_id,source_email_received_at=EXCLUDED.source_email_received_at,extraction_evidence=EXCLUDED.extraction_evidence,eligibility_decision_id=EXCLUDED.eligibility_decision_id,updated_at=NOW()
 WHERE NOT public.events.manual_override;
END; $$;
REVOKE ALL ON FUNCTION public.reconcile_drive_events(UUID,UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_drive_events(UUID,UUID,UUID,JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.commit_round_verdict(
 p_user_id UUID, p_run_id UUID, p_drive_id UUID, p_verdict JSONB,
 p_status TEXT, p_is_current BOOLEAN DEFAULT TRUE, p_notification JSONB DEFAULT NULL, p_events JSONB DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_decision_id UUID; existing_source TIMESTAMPTZ; existing_version INTEGER; overridden BOOLEAN;
BEGIN
 -- Row lock prevents lease reclamation until the entire commit finishes.
 PERFORM 1 FROM public.sync_state WHERE user_id=p_user_id AND run_id=p_run_id AND is_syncing AND lease_expires_at>NOW() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Sync lease lost'; END IF;
 SELECT manual_override INTO overridden FROM public.applications WHERE user_id=p_user_id AND placement_drive_id=p_drive_id FOR UPDATE;
 IF overridden IS TRUE THEN RETURN NULL; END IF;
 SELECT source_received_at,COALESCE((verdict->>'parserVersion')::INTEGER,0) INTO existing_source,existing_version FROM public.round_verdicts WHERE user_id=p_user_id AND placement_drive_id=p_drive_id AND is_current;
 SELECT id INTO v_decision_id FROM public.round_verdicts WHERE user_id=p_user_id AND placement_drive_id=p_drive_id AND round_key=p_verdict->>'roundKey'
 AND COALESCE((verdict->>'parserVersion')::INTEGER,0)>=COALESCE((p_verdict->>'parserVersion')::INTEGER,0)
 AND (source_received_at>(p_verdict->>'sourceReceivedAt')::TIMESTAMPTZ OR (is_current AND NOT p_is_current));
 IF FOUND THEN RETURN v_decision_id; END IF;
 IF p_is_current AND existing_version>=COALESCE((p_verdict->>'parserVersion')::INTEGER,0) AND existing_source > (p_verdict->>'sourceReceivedAt')::TIMESTAMPTZ THEN RETURN NULL; END IF;
 IF p_is_current THEN UPDATE public.round_verdicts SET is_current=FALSE WHERE user_id=p_user_id AND placement_drive_id=p_drive_id AND is_current; END IF;
 INSERT INTO public.round_verdicts(user_id,placement_drive_id,round_key,verdict,source_received_at,is_current)
 VALUES(p_user_id,p_drive_id,p_verdict->>'roundKey',p_verdict,(p_verdict->>'sourceReceivedAt')::TIMESTAMPTZ,p_is_current)
 ON CONFLICT(user_id,placement_drive_id,round_key) DO UPDATE SET verdict=EXCLUDED.verdict, source_received_at=EXCLUDED.source_received_at,is_current=EXCLUDED.is_current,updated_at=NOW()
 RETURNING id INTO v_decision_id;
 IF p_is_current THEN
   IF NOT (p_verdict->>'eligible')::BOOLEAN AND p_status IN ('shortlisted','test_scheduled','interview_scheduled','selected','offer','offer_received')
     AND NOT (p_verdict->>'state'='deferred' AND EXISTS (
       SELECT 1 FROM public.round_verdicts previous WHERE previous.user_id=p_user_id AND previous.placement_drive_id=p_drive_id
       AND (previous.verdict->>'eligible')::BOOLEAN
       AND COALESCE((previous.verdict->>'parserVersion')::INTEGER,0)>=COALESCE((p_verdict->>'parserVersion')::INTEGER,0)
       AND previous.source_received_at<=(p_verdict->>'sourceReceivedAt')::TIMESTAMPTZ
       AND (p_status NOT IN ('selected','offer','offer_received') OR previous.verdict->>'outcome'='selected' OR previous.verdict->>'roundType'='selected')
     )) THEN RAISE EXCEPTION 'Positive status requires current or previously verified round eligibility'; END IF;
   IF p_events IS NOT NULL THEN PERFORM public.reconcile_drive_events(p_user_id,p_run_id,p_drive_id,p_events); END IF;
   UPDATE public.applications SET status=p_status,status_source='round_verdict',status_confidence=CASE WHEN (p_verdict->>'eligible')::BOOLEAN OR (p_verdict->>'finalNegative')::BOOLEAN THEN 'high' ELSE 'low' END,
    status_source_email_at=(p_verdict->>'sourceReceivedAt')::TIMESTAMPTZ,last_updated=NOW()
    WHERE user_id=p_user_id AND placement_drive_id=p_drive_id AND NOT manual_override;
   IF NOT (p_verdict->>'eligible')::BOOLEAN THEN
     UPDATE public.notifications SET superseded_at=COALESCE(superseded_at,NOW()),is_read=TRUE
     WHERE user_id=p_user_id AND placement_drive_id=p_drive_id AND (type IN ('shortlist_match','test_scheduled','interview_scheduled') OR (type='status_change' AND (title ILIKE '%shortlisted%' OR dedupe_key LIKE '%:shortlisted'))) AND superseded_at IS NULL;
   ELSE
     UPDATE public.notifications SET superseded_at=COALESCE(superseded_at,NOW()),is_read=TRUE
     WHERE user_id=p_user_id AND placement_drive_id=p_drive_id AND type='shortlist_match' AND decision_id IS NOT NULL AND decision_id<>v_decision_id AND superseded_at IS NULL;
   END IF;
 END IF;
 IF p_notification IS NOT NULL AND (p_verdict->>'eligible')::BOOLEAN AND p_is_current THEN
   INSERT INTO public.decision_notification_outbox(user_id,decision_id,dedupe_key,payload)
   VALUES(p_user_id,v_decision_id,p_notification->>'dedupeKey',p_notification) ON CONFLICT(dedupe_key) DO NOTHING;
 END IF;
 RETURN v_decision_id;
END; $$;
REVOKE ALL ON FUNCTION public.commit_round_verdict(UUID,UUID,UUID,JSONB,TEXT,BOOLEAN,JSONB,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commit_round_verdict(UUID,UUID,UUID,JSONB,TEXT,BOOLEAN,JSONB,JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.update_sync_lease(
  p_user_id UUID,
  p_run_id UUID,
  p_progress JSONB,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SET search_path = public, pg_temp
AS $$
  UPDATE public.sync_state
  SET phase = COALESCE(p_progress->>'phase', phase),
      account_email = COALESCE(p_progress->>'accountEmail', account_email),
      account_type = COALESCE(p_progress->>'accountType', account_type),
      total_messages = COALESCE((p_progress->>'totalMessages')::INTEGER, total_messages),
      processed_messages = COALESCE((p_progress->>'processedMessages')::INTEGER, processed_messages),
      new_emails = COALESCE((p_progress->>'newEmails')::INTEGER, new_emails),
      new_companies = COALESCE((p_progress->>'newCompanies')::INTEGER, new_companies),
      skipped_duplicates = COALESCE((p_progress->>'skippedDuplicates')::INTEGER, skipped_duplicates),
      current_subject = NULLIF(p_progress->>'currentSubject', ''),
      is_initial_sync = COALESCE((p_progress->>'isInitialSync')::BOOLEAN, is_initial_sync),
      current_page_index = COALESCE((p_progress->>'currentPageIndex')::INTEGER, current_page_index),
      total_pages = COALESCE((p_progress->>'totalPagesCount')::INTEGER, total_pages),
      last_error = NULLIF(p_progress->>'lastError', ''),
      updated_at = NOW(),
      lease_expires_at = NOW() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 900)))
  WHERE user_id = p_user_id
    AND run_id = p_run_id
    AND is_syncing = TRUE
    AND lease_expires_at > NOW()
  RETURNING TRUE;
$$;


COMMIT;
