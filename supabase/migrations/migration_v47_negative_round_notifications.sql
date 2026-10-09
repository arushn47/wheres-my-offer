-- Only notification gates change. No backfill, cursor, status, or event rewrite.
-- Apply before deploying the application fix. Requires existing v40 RPCs.
BEGIN;

CREATE OR REPLACE FUNCTION public.negative_round_notification_key(p_user_id UUID,p_drive_id UUID)
RETURNS TEXT LANGUAGE SQL IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT 'shortlist_absent:' || p_user_id::TEXT || ':' || p_drive_id::TEXT;
$$;

CREATE OR REPLACE FUNCTION public.is_confirmed_negative_round(p_verdict JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT COALESCE(p_verdict->>'eligible'='false' AND p_verdict->>'state'='verified_absent'
   AND p_verdict->>'finalNegative'='true' AND p_verdict->>'reason'='complete_list_absence'
   AND (p_verdict->>'outcome'='rejected' OR EXISTS (
     SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_verdict->'evaluations')='array' THEN p_verdict->'evaluations' ELSE '[]'::JSONB END) scan
     WHERE scan->>'state'='verified_absent'
   )),FALSE);
$$;

CREATE OR REPLACE FUNCTION public.has_negative_round_notification(p_user_id UUID,p_drive_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.notifications n WHERE n.user_id=p_user_id AND n.placement_drive_id=p_drive_id
   AND n.dedupe_key IN (public.negative_round_notification_key(p_user_id,p_drive_id),
     'status:'||p_user_id::TEXT||':'||p_drive_id::TEXT||':not_shortlisted',
     'status:'||p_user_id::TEXT||':'||p_drive_id::TEXT||':rejected',
     'status:'||p_user_id::TEXT||':'||p_drive_id::TEXT||':rejected_test',
     'status:'||p_user_id::TEXT||':'||p_drive_id::TEXT||':rejected_interview'));
$$;

-- Shared by ordinary commits and explicit, bounded recovery. Requires the same
-- persisted user lease; reads saved verdicts only and never recalculates a drive.
CREATE OR REPLACE FUNCTION public.enqueue_negative_round_notification(
 p_user_id UUID,p_run_id UUID,p_decision_id UUID,p_notification JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.round_verdicts; app_status TEXT; overridden BOOLEAN; inserted_id UUID;
BEGIN
 PERFORM 1 FROM public.sync_state WHERE user_id=p_user_id AND run_id=p_run_id AND is_syncing AND lease_expires_at>NOW() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Sync lease lost'; END IF;
 SELECT * INTO d FROM public.round_verdicts WHERE id=p_decision_id AND user_id=p_user_id;
 IF NOT FOUND THEN RETURN FALSE; END IF;
 -- Match normal commit lock order: lease, application, verdict.
 SELECT status,manual_override INTO app_status,overridden FROM public.applications
   WHERE user_id=p_user_id AND placement_drive_id=d.placement_drive_id FOR UPDATE;
 IF NOT FOUND OR overridden IS TRUE OR app_status IS NULL OR app_status IN ('withdrawn','declined','not_applied','registration_open','unknown') THEN RETURN FALSE; END IF;
 SELECT * INTO d FROM public.round_verdicts WHERE id=p_decision_id AND user_id=p_user_id FOR UPDATE;
 IF NOT d.is_current OR NOT public.is_confirmed_negative_round(d.verdict)
   OR d.source_received_at<NOW()-INTERVAL '48 hours' OR d.source_received_at>NOW()
   OR public.has_negative_round_notification(p_user_id,d.placement_drive_id) THEN RETURN FALSE; END IF;
 IF p_notification->>'userId' IS DISTINCT FROM p_user_id::TEXT
   OR p_notification->>'placementDriveId' IS DISTINCT FROM d.placement_drive_id::TEXT
   OR p_notification->>'dedupeKey' IS DISTINCT FROM public.negative_round_notification_key(p_user_id,d.placement_drive_id)
   OR p_notification->>'type' IS DISTINCT FROM 'shortlist_match' THEN RETURN FALSE; END IF;
 INSERT INTO public.decision_notification_outbox(user_id,decision_id,dedupe_key,payload)
 VALUES(p_user_id,d.id,p_notification->>'dedupeKey',p_notification)
 ON CONFLICT(dedupe_key) DO UPDATE SET decision_id=EXCLUDED.decision_id,payload=EXCLUDED.payload
 WHERE decision_notification_outbox.delivered_at IS NULL
 RETURNING id INTO inserted_id;
 RETURN inserted_id IS NOT NULL;
END; $$;

CREATE OR REPLACE FUNCTION public.claim_notification_push(p_notification_id UUID) RETURNS BOOLEAN
LANGUAGE SQL VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 UPDATE public.notifications n SET push_claimed_at=NOW()
 WHERE n.id=p_notification_id AND n.push_delivered_at IS NULL AND n.superseded_at IS NULL
 AND (n.push_claimed_at IS NULL OR n.push_claimed_at<NOW()-INTERVAL '2 minutes')
 AND (n.decision_id IS NULL OR EXISTS(SELECT 1 FROM public.round_verdicts d
   WHERE d.id=n.decision_id AND d.user_id=n.user_id AND d.placement_drive_id=n.placement_drive_id AND d.is_current
   AND (((d.verdict->>'eligible')::BOOLEAN AND n.dedupe_key<>public.negative_round_notification_key(n.user_id,n.placement_drive_id))
     OR (n.dedupe_key=public.negative_round_notification_key(n.user_id,n.placement_drive_id)
       AND public.is_confirmed_negative_round(d.verdict) AND EXISTS(SELECT 1 FROM public.applications a
         WHERE a.user_id=n.user_id AND a.placement_drive_id=n.placement_drive_id AND NOT a.manual_override
         AND a.status NOT IN ('withdrawn','declined','not_applied','registration_open','unknown'))))))
 RETURNING TRUE;
$$;

CREATE OR REPLACE FUNCTION public.commit_round_verdict(
 p_user_id UUID, p_run_id UUID, p_drive_id UUID, p_verdict JSONB,
 p_status TEXT, p_is_current BOOLEAN DEFAULT TRUE, p_notification JSONB DEFAULT NULL, p_events JSONB DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_decision_id UUID; existing_source TIMESTAMPTZ; existing_version INTEGER; overridden BOOLEAN; application_status TEXT;
BEGIN
 -- Row lock prevents lease reclamation until the entire commit finishes.
 PERFORM 1 FROM public.sync_state WHERE user_id=p_user_id AND run_id=p_run_id AND is_syncing AND lease_expires_at>NOW() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Sync lease lost'; END IF;
 SELECT manual_override,status INTO overridden,application_status FROM public.applications WHERE user_id=p_user_id AND placement_drive_id=p_drive_id FOR UPDATE;
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
     WHERE user_id=p_user_id AND placement_drive_id=p_drive_id AND (type IN ('shortlist_match','test_scheduled','interview_scheduled') OR (type='status_change' AND (title ILIKE '%shortlisted%' OR dedupe_key LIKE '%:shortlisted'))) AND superseded_at IS NULL
       AND dedupe_key<>public.negative_round_notification_key(p_user_id,p_drive_id);
   ELSE
     UPDATE public.notifications SET superseded_at=COALESCE(superseded_at,NOW()),is_read=TRUE
     WHERE user_id=p_user_id AND placement_drive_id=p_drive_id AND superseded_at IS NULL AND ((type='shortlist_match' AND decision_id IS NOT NULL AND decision_id<>v_decision_id)
       OR dedupe_key=public.negative_round_notification_key(p_user_id,p_drive_id));
   END IF;
 END IF;
 IF p_notification IS NOT NULL AND p_is_current THEN
   IF (p_verdict->>'eligible')::BOOLEAN AND p_notification->>'dedupeKey'<>public.negative_round_notification_key(p_user_id,p_drive_id) THEN
   INSERT INTO public.decision_notification_outbox(user_id,decision_id,dedupe_key,payload)
   VALUES(p_user_id,v_decision_id,p_notification->>'dedupeKey',p_notification) ON CONFLICT(dedupe_key) DO NOTHING;
   ELSIF application_status IS NOT NULL AND application_status NOT IN ('withdrawn','declined','not_applied','registration_open','unknown') THEN
     PERFORM public.enqueue_negative_round_notification(p_user_id,p_run_id,v_decision_id,p_notification);
   END IF;
 END IF;
 RETURN v_decision_id;
END; $$;
REVOKE ALL ON FUNCTION public.commit_round_verdict(UUID,UUID,UUID,JSONB,TEXT,BOOLEAN,JSONB,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commit_round_verdict(UUID,UUID,UUID,JSONB,TEXT,BOOLEAN,JSONB,JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.negative_round_notification_key(UUID,UUID),public.is_confirmed_negative_round(JSONB),public.has_negative_round_notification(UUID,UUID),public.enqueue_negative_round_notification(UUID,UUID,UUID,JSONB),public.claim_notification_push(UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.negative_round_notification_key(UUID,UUID),public.is_confirmed_negative_round(JSONB),public.has_negative_round_notification(UUID,UUID),public.enqueue_negative_round_notification(UUID,UUID,UUID,JSONB),public.claim_notification_push(UUID) TO service_role;
COMMIT;
