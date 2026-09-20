-- Phase 3 MATERIALIZATION + ASSIGNMENT + VALIDATION runtime.
--
-- This migration adds two Postgres functions and changes NO table structure. It is the only
-- place Phase 3 code writes to the database — everything upstream (discovery, resolution,
-- planning, materialization dedup, assignment payload building) lives in
-- src/lib/migration/phase3/*.ts and is pure/read-only.
--
-- phase3_preflight_report()
--   Read-only. Wraps the same invariant checks as preflight_v12_drive_migration.sql into a
--   callable function so both a human (SQL editor) and the TS orchestrator (`supabase.rpc(...)`)
--   can run it. Safe to call at any time, including during a live sync.
--
-- phase3_apply_user_actions(p_user_id uuid, p_actions jsonb)
--   The ONLY write path. Executes entirely inside the one implicit transaction of this function
--   call: acquires a per-user advisory lock, refuses to run while that user's live sync is in
--   progress, applies each action (idempotently — every UPDATE is guarded by
--   `placement_drive_id IS NULL`), re-validates the same duplicate/ownership invariants scoped
--   to this user, and RAISEs (rolling back everything it just did) if any invariant fails.
--
-- SECURITY: both functions accept/operate on an arbitrary user_id and therefore MUST NOT be
-- callable by `anon`/`authenticated` — only the service-role key (used by createAdminClient())
-- may invoke them. This mirrors this project's existing pattern of doing privileged, service-role
-- only, multi-table writes from the Next.js server (see docs/rules.md §3 "Database Access").
--
-- This file, like migration_v12, is NOT executed automatically by any application code path.

BEGIN;

CREATE OR REPLACE FUNCTION public.phase3_preflight_report()
RETURNS TABLE(check_name text, status text, details text)
LANGUAGE sql
STABLE
AS $$
  WITH checks AS (
    SELECT
      'applications.duplicate_drive_identity' AS check_name,
      CASE WHEN EXISTS (
        SELECT 1 FROM public.applications
        WHERE placement_drive_id IS NOT NULL
        GROUP BY user_id, placement_drive_id
        HAVING COUNT(*) > 1
      ) THEN 'BLOCKED' ELSE 'PASS' END AS status,
      'Duplicate (user_id, placement_drive_id) applications would block the unique index' AS details

    UNION ALL

    SELECT
      'applications.duplicate_legacy_identity',
      CASE WHEN EXISTS (
        SELECT 1 FROM public.applications
        WHERE placement_drive_id IS NULL
        GROUP BY user_id, company_id
        HAVING COUNT(*) > 1
      ) THEN 'BLOCKED' ELSE 'PASS' END,
      'Duplicate legacy (user_id, company_id) applications would block the legacy unique index'

    UNION ALL

    SELECT
      'applications.drive_ownership',
      CASE WHEN EXISTS (
        SELECT 1 FROM public.applications a
        JOIN public.placement_drives d ON d.id = a.placement_drive_id
        WHERE a.placement_drive_id IS NOT NULL
          AND (a.user_id <> d.user_id OR a.company_id <> d.company_id)
      ) THEN 'BLOCKED' ELSE 'PASS' END,
      'Drive-owned applications must agree with their drive''s user/company ownership'

    UNION ALL

    SELECT
      'placement_drives.orphans',
      CASE WHEN EXISTS (
        SELECT 1 FROM public.placement_drives d
        LEFT JOIN public.companies c ON c.id = d.company_id
        WHERE c.id IS NULL OR d.user_id <> c.user_id
      ) THEN 'BLOCKED' ELSE 'PASS' END,
      'Every placement_drives row must reference a company owned by the same user'

    UNION ALL

    SELECT
      'events.drive_ownership',
      CASE WHEN EXISTS (
        SELECT 1 FROM public.events e
        JOIN public.placement_drives d ON d.id = e.placement_drive_id
        WHERE e.placement_drive_id IS NOT NULL
          AND (e.user_id <> d.user_id OR e.company_id <> d.company_id)
      ) THEN 'BLOCKED' ELSE 'PASS' END,
      'Drive-owned events must agree with their drive''s user/company ownership'

    UNION ALL

    SELECT
      'events.proposed_unique_identity',
      CASE WHEN EXISTS (
        SELECT 1 FROM public.events
        WHERE placement_drive_id IS NOT NULL AND start_time IS NOT NULL
        GROUP BY user_id, placement_drive_id, event_type, start_time
        HAVING COUNT(*) > 1
      ) THEN 'BLOCKED' ELSE 'PASS' END,
      'Duplicate rows would block idx_events_drive_identity'

    UNION ALL

    SELECT
      'candidate_matches.proposed_unique_identity',
      CASE WHEN EXISTS (
        SELECT 1 FROM public.candidate_matches
        WHERE placement_drive_id IS NOT NULL
        GROUP BY user_id, email_id, placement_drive_id, neo_id, match_type
        HAVING COUNT(*) > 1
      ) THEN 'BLOCKED' ELSE 'PASS' END,
      'Duplicate rows would block idx_candidate_matches_drive_identity'

    UNION ALL

    SELECT
      'emails.assignment_metadata',
      CASE WHEN EXISTS (
        SELECT 1 FROM public.emails
        WHERE (assignment_state IN ('assigned', 'manually_assigned') AND placement_drive_id IS NULL)
           OR (placement_drive_id IS NOT NULL AND assignment_state IN ('ambiguous', 'conflict', 'unassigned', 'legacy'))
      ) THEN 'BLOCKED' ELSE 'PASS' END,
      'Email assignment_state must not contradict placement_drive_id ownership'

    UNION ALL

    SELECT
      'legacy_records',
      CASE WHEN EXISTS (SELECT 1 FROM public.applications WHERE placement_drive_id IS NULL)
        OR EXISTS (SELECT 1 FROM public.candidate_matches WHERE placement_drive_id IS NULL)
        THEN 'WARN' ELSE 'PASS' END,
      'Legacy company-scoped rows exist; expected until Phase 3 backfill runs for those users'
  )
  SELECT check_name, status, details FROM checks
  ORDER BY check_name;
$$;

-- Detailed, read-only readiness counts. This intentionally reports conflicts and
-- unresolved rows instead of repairing or assigning them.
CREATE OR REPLACE FUNCTION public.phase3_preflight_counts()
RETURNS TABLE(scope text, record_type text, state text, row_count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT 'tenant'::text, 'placement_drives'::text, 'drive_count'::text, COUNT(*) FROM public.placement_drives
  UNION ALL SELECT 'drive', 'emails', 'drive_owned', COUNT(*) FROM public.emails WHERE placement_drive_id IS NOT NULL
  UNION ALL SELECT 'legacy', 'emails', 'legacy', COUNT(*) FROM public.emails WHERE placement_drive_id IS NULL AND assignment_state = 'legacy'
  UNION ALL SELECT 'quarantine', 'emails', COALESCE(assignment_state, 'unassigned'), COUNT(*) FROM public.emails WHERE placement_drive_id IS NULL AND assignment_state IN ('ambiguous', 'conflict', 'unassigned') GROUP BY assignment_state
  UNION ALL SELECT 'drive', 'applications', 'drive_owned', COUNT(*) FROM public.applications WHERE placement_drive_id IS NOT NULL
  UNION ALL SELECT 'legacy', 'applications', 'legacy', COUNT(*) FROM public.applications WHERE placement_drive_id IS NULL
  UNION ALL SELECT 'drive', 'events', 'drive_owned', COUNT(*) FROM public.events WHERE placement_drive_id IS NOT NULL
  UNION ALL SELECT 'legacy', 'events', 'legacy', COUNT(*) FROM public.events WHERE placement_drive_id IS NULL
  UNION ALL SELECT 'drive', 'candidate_matches', 'drive_owned', COUNT(*) FROM public.candidate_matches WHERE placement_drive_id IS NOT NULL
  UNION ALL SELECT 'legacy', 'candidate_matches', 'legacy', COUNT(*) FROM public.candidate_matches WHERE placement_drive_id IS NULL
  UNION ALL SELECT 'drive', 'notifications', 'drive_owned', COUNT(*) FROM public.notifications WHERE placement_drive_id IS NOT NULL
  UNION ALL SELECT 'legacy', 'notifications', 'legacy', COUNT(*) FROM public.notifications WHERE placement_drive_id IS NULL
  UNION ALL SELECT 'conflict', 'events', 'application_drive_mismatch', COUNT(*)
    FROM public.events e JOIN public.applications a ON a.id = e.application_id
    WHERE e.placement_drive_id IS DISTINCT FROM a.placement_drive_id
  UNION ALL SELECT 'conflict', 'candidate_matches', 'application_drive_mismatch', COUNT(*)
    FROM public.candidate_matches cm JOIN public.applications a ON a.id = cm.application_id
    WHERE cm.placement_drive_id IS DISTINCT FROM a.placement_drive_id
  UNION ALL SELECT 'conflict', 'notifications', 'event_drive_mismatch', COUNT(*)
    FROM public.notifications n JOIN public.events e ON e.id = n.event_id
    WHERE n.placement_drive_id IS DISTINCT FROM e.placement_drive_id;
$$;

-- Tenant-scoped read-only preflight. The caller must pass the tenant explicitly;
-- no aggregate count here can accidentally hide a cross-user problem.
CREATE OR REPLACE FUNCTION public.phase3_preflight_user_counts(p_user_id uuid)
RETURNS TABLE(scope text, record_type text, state text, row_count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT 'tenant', 'companies', 'total', COUNT(*) FROM public.companies WHERE user_id = p_user_id
  UNION ALL SELECT 'tenant', 'placement_drives', 'total', COUNT(*) FROM public.placement_drives WHERE user_id = p_user_id
  UNION ALL SELECT 'drive', 'emails', 'drive_owned', COUNT(*) FROM public.emails WHERE user_id = p_user_id AND placement_drive_id IS NOT NULL
  UNION ALL SELECT 'legacy', 'emails', 'legacy', COUNT(*) FROM public.emails WHERE user_id = p_user_id AND placement_drive_id IS NULL AND assignment_state = 'legacy'
  UNION ALL SELECT 'quarantine', 'emails', COALESCE(assignment_state, 'unassigned'), COUNT(*) FROM public.emails WHERE user_id = p_user_id AND placement_drive_id IS NULL AND assignment_state IN ('ambiguous', 'conflict', 'unassigned') GROUP BY assignment_state
  UNION ALL SELECT 'drive', 'applications', 'drive_owned', COUNT(*) FROM public.applications WHERE user_id = p_user_id AND placement_drive_id IS NOT NULL
  UNION ALL SELECT 'legacy', 'applications', 'legacy', COUNT(*) FROM public.applications WHERE user_id = p_user_id AND placement_drive_id IS NULL
  UNION ALL SELECT 'drive', 'events', 'drive_owned', COUNT(*) FROM public.events WHERE user_id = p_user_id AND placement_drive_id IS NOT NULL
  UNION ALL SELECT 'legacy', 'events', 'legacy', COUNT(*) FROM public.events WHERE user_id = p_user_id AND placement_drive_id IS NULL
  UNION ALL SELECT 'drive', 'candidate_matches', 'drive_owned', COUNT(*) FROM public.candidate_matches WHERE user_id = p_user_id AND placement_drive_id IS NOT NULL
  UNION ALL SELECT 'legacy', 'candidate_matches', 'legacy', COUNT(*) FROM public.candidate_matches WHERE user_id = p_user_id AND placement_drive_id IS NULL
  UNION ALL SELECT 'drive', 'notifications', 'drive_owned', COUNT(*) FROM public.notifications WHERE user_id = p_user_id AND placement_drive_id IS NOT NULL
  UNION ALL SELECT 'legacy', 'notifications', 'legacy', COUNT(*) FROM public.notifications WHERE user_id = p_user_id AND placement_drive_id IS NULL
  UNION ALL SELECT 'conflict', 'applications', 'drive_company_mismatch', COUNT(*)
    FROM public.applications a JOIN public.placement_drives d ON d.id = a.placement_drive_id
    WHERE a.user_id = p_user_id AND (a.user_id IS DISTINCT FROM d.user_id OR a.company_id IS DISTINCT FROM d.company_id)
  UNION ALL SELECT 'conflict', 'events', 'drive_company_mismatch', COUNT(*)
    FROM public.events e JOIN public.placement_drives d ON d.id = e.placement_drive_id
    WHERE e.user_id = p_user_id AND (e.user_id IS DISTINCT FROM d.user_id OR e.company_id IS DISTINCT FROM d.company_id)
  UNION ALL SELECT 'conflict', 'events', 'application_drive_mismatch', COUNT(*)
    FROM public.events e JOIN public.applications a ON a.id = e.application_id
    WHERE e.user_id = p_user_id AND e.placement_drive_id IS DISTINCT FROM a.placement_drive_id
  UNION ALL SELECT 'conflict', 'candidate_matches', 'application_drive_mismatch', COUNT(*)
    FROM public.candidate_matches cm JOIN public.applications a ON a.id = cm.application_id
    WHERE cm.user_id = p_user_id AND cm.placement_drive_id IS DISTINCT FROM a.placement_drive_id
  UNION ALL SELECT 'warning', 'candidate_matches', 'legacy_email_drive_evidence', COUNT(*)
    FROM public.candidate_matches cm JOIN public.emails e ON e.id = cm.email_id
    WHERE cm.user_id = p_user_id
      AND cm.placement_drive_id IS NOT NULL
      AND e.placement_drive_id IS NULL
  UNION ALL SELECT 'conflict', 'candidate_matches', 'email_drive_mismatch', COUNT(*)
    FROM public.candidate_matches cm JOIN public.emails e ON e.id = cm.email_id
    WHERE cm.user_id = p_user_id
      AND cm.placement_drive_id IS NOT NULL
      AND e.placement_drive_id IS NOT NULL
      AND cm.placement_drive_id IS DISTINCT FROM e.placement_drive_id
  UNION ALL SELECT 'conflict', 'notifications', 'event_drive_mismatch', COUNT(*)
    FROM public.notifications n JOIN public.events e ON e.id = n.event_id
    WHERE n.user_id = p_user_id AND n.placement_drive_id IS DISTINCT FROM e.placement_drive_id
  UNION ALL SELECT 'conflict', 'notifications', 'application_drive_mismatch', COUNT(*)
    FROM public.notifications n JOIN public.applications a ON a.id = n.application_id
    WHERE n.user_id = p_user_id AND n.placement_drive_id IS DISTINCT FROM a.placement_drive_id
  UNION ALL SELECT 'error', 'placement_drives', 'orphaned_company', COUNT(*)
    FROM public.placement_drives d LEFT JOIN public.companies c ON c.id = d.company_id
    WHERE d.user_id = p_user_id AND (c.id IS NULL OR c.user_id IS DISTINCT FROM p_user_id)
  UNION ALL SELECT 'error', 'applications', 'orphaned_drive', COUNT(*)
    FROM public.applications a LEFT JOIN public.placement_drives d ON d.id = a.placement_drive_id
    WHERE a.user_id = p_user_id AND a.placement_drive_id IS NOT NULL AND d.id IS NULL
  UNION ALL SELECT 'error', 'emails', 'orphaned_drive', COUNT(*)
    FROM public.emails e LEFT JOIN public.placement_drives d ON d.id = e.placement_drive_id
    WHERE e.user_id = p_user_id AND e.placement_drive_id IS NOT NULL AND d.id IS NULL
  UNION ALL SELECT 'error', 'events', 'orphaned_drive', COUNT(*)
    FROM public.events e LEFT JOIN public.placement_drives d ON d.id = e.placement_drive_id
    WHERE e.user_id = p_user_id AND e.placement_drive_id IS NOT NULL AND d.id IS NULL
  UNION ALL SELECT 'error', 'candidate_matches', 'orphaned_drive', COUNT(*)
    FROM public.candidate_matches cm LEFT JOIN public.placement_drives d ON d.id = cm.placement_drive_id
    WHERE cm.user_id = p_user_id AND cm.placement_drive_id IS NOT NULL AND d.id IS NULL
  UNION ALL SELECT 'error', 'notifications', 'orphaned_drive', COUNT(*)
    FROM public.notifications n LEFT JOIN public.placement_drives d ON d.id = n.placement_drive_id
    WHERE n.user_id = p_user_id AND n.placement_drive_id IS NOT NULL AND d.id IS NULL;
$$;

-- Drive-specific read-only verification helper. Call once for each approved
-- drive number (including Whirlpool 1204 and 1317) and compare the counts.
CREATE OR REPLACE FUNCTION public.phase3_preflight_drive_counts(p_user_id uuid, p_normalized_drive_number text)
RETURNS TABLE(record_type text, row_count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT 'emails', COUNT(*) FROM public.emails e JOIN public.placement_drives d ON d.id = e.placement_drive_id
    WHERE e.user_id = p_user_id AND d.user_id = p_user_id AND d.normalized_drive_number = p_normalized_drive_number
  UNION ALL SELECT 'applications', COUNT(*) FROM public.applications a JOIN public.placement_drives d ON d.id = a.placement_drive_id
    WHERE a.user_id = p_user_id AND d.user_id = p_user_id AND d.normalized_drive_number = p_normalized_drive_number
  UNION ALL SELECT 'events', COUNT(*) FROM public.events e JOIN public.placement_drives d ON d.id = e.placement_drive_id
    WHERE e.user_id = p_user_id AND d.user_id = p_user_id AND d.normalized_drive_number = p_normalized_drive_number
  UNION ALL SELECT 'candidate_matches', COUNT(*) FROM public.candidate_matches cm JOIN public.placement_drives d ON d.id = cm.placement_drive_id
    WHERE cm.user_id = p_user_id AND d.user_id = p_user_id AND d.normalized_drive_number = p_normalized_drive_number
  UNION ALL SELECT 'notifications', COUNT(*) FROM public.notifications n JOIN public.placement_drives d ON d.id = n.placement_drive_id
    WHERE n.user_id = p_user_id AND d.user_id = p_user_id AND d.normalized_drive_number = p_normalized_drive_number;
$$;

-- Tenant-scoped preflight. Unlike phase3_preflight_report(), this never lets
-- another tenant block a one-user migration decision.
CREATE OR REPLACE FUNCTION public.phase3_preflight_user_report(p_user_id uuid)
RETURNS TABLE(check_name text, status text, details text)
LANGUAGE sql
STABLE
AS $$
  WITH checks AS (
    SELECT
      'applications.duplicate_drive_identity' AS check_name,
      CASE WHEN EXISTS (
      SELECT 1 FROM public.applications WHERE user_id = p_user_id AND placement_drive_id IS NOT NULL
      GROUP BY placement_drive_id HAVING COUNT(*) > 1
    ) THEN 'BLOCKED' ELSE 'PASS' END AS status,
      'Duplicate drive-owned applications for this tenant' AS details
    UNION ALL SELECT 'applications.duplicate_legacy_identity', CASE WHEN EXISTS (
      SELECT 1 FROM public.applications WHERE user_id = p_user_id AND placement_drive_id IS NULL
      GROUP BY company_id HAVING COUNT(*) > 1
    ) THEN 'BLOCKED' ELSE 'PASS' END, 'Duplicate legacy applications for this tenant'
    UNION ALL SELECT 'applications.drive_ownership', CASE WHEN EXISTS (
      SELECT 1 FROM public.applications a JOIN public.placement_drives d ON d.id = a.placement_drive_id
      WHERE a.user_id = p_user_id AND (a.user_id IS DISTINCT FROM d.user_id OR a.company_id IS DISTINCT FROM d.company_id)
    ) THEN 'BLOCKED' ELSE 'PASS' END, 'Application drive ownership mismatch'
    UNION ALL SELECT 'placement_drives.orphans', CASE WHEN EXISTS (
      SELECT 1 FROM public.placement_drives d LEFT JOIN public.companies c ON c.id = d.company_id
      WHERE d.user_id = p_user_id AND (c.id IS NULL OR c.user_id IS DISTINCT FROM p_user_id)
    ) THEN 'BLOCKED' ELSE 'PASS' END, 'Placement drive company ownership mismatch'
    UNION ALL SELECT 'events.drive_ownership', CASE WHEN EXISTS (
      SELECT 1 FROM public.events e JOIN public.placement_drives d ON d.id = e.placement_drive_id
      WHERE e.user_id = p_user_id AND (e.user_id IS DISTINCT FROM d.user_id OR e.company_id IS DISTINCT FROM d.company_id)
    ) THEN 'BLOCKED' ELSE 'PASS' END, 'Event drive ownership mismatch'
    UNION ALL SELECT 'events.application_drive_consistency', CASE WHEN EXISTS (
      SELECT 1 FROM public.events e JOIN public.applications a ON a.id = e.application_id
      WHERE e.user_id = p_user_id AND e.placement_drive_id IS DISTINCT FROM a.placement_drive_id
    ) THEN 'BLOCKED' ELSE 'PASS' END, 'Event/application drive mismatch'
    UNION ALL SELECT 'candidate_matches.application_drive_consistency', CASE WHEN EXISTS (
      SELECT 1 FROM public.candidate_matches cm JOIN public.applications a ON a.id = cm.application_id
      WHERE cm.user_id = p_user_id AND cm.placement_drive_id IS DISTINCT FROM a.placement_drive_id
    ) THEN 'BLOCKED' ELSE 'PASS' END, 'Candidate/application drive mismatch'
    UNION ALL SELECT 'candidate_matches.email_drive_consistency', CASE 
      WHEN EXISTS (
        SELECT 1 FROM public.candidate_matches cm 
        JOIN public.emails e ON e.id = cm.email_id
        WHERE cm.user_id = p_user_id
          AND cm.placement_drive_id IS NOT NULL
          AND e.placement_drive_id IS NOT NULL
          AND cm.placement_drive_id IS DISTINCT FROM e.placement_drive_id
      ) THEN 'BLOCKED'
      WHEN EXISTS (
        SELECT 1 FROM public.candidate_matches cm
        JOIN public.emails e ON e.id = cm.email_id
        JOIN public.placement_drives d ON d.id = cm.placement_drive_id
        WHERE cm.user_id = p_user_id
          AND cm.placement_drive_id IS NOT NULL
          AND e.placement_drive_id IS NULL
          AND (d.user_id IS DISTINCT FROM p_user_id OR d.company_id IS DISTINCT FROM e.company_id)
      ) THEN 'BLOCKED'
      WHEN EXISTS (
        SELECT 1 FROM public.candidate_matches cm 
        JOIN public.emails e ON e.id = cm.email_id
        JOIN public.placement_drives d ON d.id = cm.placement_drive_id
        WHERE cm.user_id = p_user_id
          AND cm.placement_drive_id IS NOT NULL
          AND e.placement_drive_id IS NULL
          AND d.user_id = p_user_id 
          AND d.company_id = e.company_id
      ) THEN 'WARN' 
      ELSE 'PASS' 
    END,
    'Candidate/source-email drive mismatch is BLOCKED only when both drives are non-null or cross-company; a valid candidate drive with a legacy null-drive source email is historical evidence and WARN'
    UNION ALL SELECT 'notifications.event_drive_consistency', CASE WHEN EXISTS (
      SELECT 1 FROM public.notifications n JOIN public.events e ON e.id = n.event_id
      WHERE n.user_id = p_user_id AND n.placement_drive_id IS DISTINCT FROM e.placement_drive_id
    ) THEN 'BLOCKED' ELSE 'PASS' END, 'Notification/event drive mismatch'
    UNION ALL SELECT 'notifications.application_drive_consistency', CASE WHEN EXISTS (
      SELECT 1 FROM public.notifications n JOIN public.applications a ON a.id = n.application_id
      WHERE n.user_id = p_user_id AND n.placement_drive_id IS DISTINCT FROM a.placement_drive_id
    ) THEN 'BLOCKED' ELSE 'PASS' END, 'Notification/application drive mismatch'
    UNION ALL SELECT 'emails.assignment_metadata', CASE WHEN EXISTS (
      SELECT 1 FROM public.emails
      WHERE user_id = p_user_id
        AND ((assignment_state IN ('assigned', 'manually_assigned') AND placement_drive_id IS NULL)
          OR (placement_drive_id IS NOT NULL AND assignment_state IN ('ambiguous', 'conflict', 'unassigned', 'legacy')))
    ) THEN 'BLOCKED' ELSE 'PASS' END, 'Email assignment metadata contradicts drive identity'
    UNION ALL SELECT 'sync_in_progress', CASE WHEN EXISTS (
      SELECT 1 FROM public.sync_state WHERE user_id = p_user_id AND is_syncing = TRUE
    ) THEN 'WARN' ELSE 'PASS' END, 'Tenant sync is active'
    UNION ALL SELECT 'legacy_records', CASE WHEN EXISTS (
      SELECT 1 FROM public.applications WHERE user_id = p_user_id AND placement_drive_id IS NULL
    ) OR EXISTS (SELECT 1 FROM public.emails WHERE user_id = p_user_id AND placement_drive_id IS NULL)
    THEN 'WARN' ELSE 'PASS' END, 'Legacy/quarantine records remain and will not be guessed'
  )
  SELECT * FROM checks ORDER BY check_name;
$$;

-- Read-only forensic payload for one tenant. Drive numbers are extracted from
-- each email independently; no sibling evidence is aggregated here.
CREATE OR REPLACE FUNCTION public.phase3_forensic_user_report(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'userId', p_user_id,
    'emails', COALESCE((SELECT jsonb_agg(to_jsonb(e) || jsonb_build_object(
      'extractedDriveNumbers', COALESCE((SELECT jsonb_agg(lower(m[1])) FROM regexp_matches(
        coalesce(e.subject, '') || E'\n' || coalesce(e.body_snippet, ''),
        '\m(pat-[a-z0-9]+-[0-9]{4}-[0-9]{1,6})\M', 'gi') m), '[]'::jsonb)
    ) ORDER BY e.received_at) FROM public.emails e WHERE e.user_id = p_user_id), '[]'::jsonb),
    'placementDrives', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.normalized_drive_number) FROM public.placement_drives d WHERE d.user_id = p_user_id), '[]'::jsonb),
    'applications', COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.applications a WHERE a.user_id = p_user_id), '[]'::jsonb),
    'events', COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.start_time) FROM public.events e WHERE e.user_id = p_user_id), '[]'::jsonb),
    'candidateMatches', COALESCE((SELECT jsonb_agg(to_jsonb(cm) ORDER BY cm.id) FROM public.candidate_matches cm WHERE cm.user_id = p_user_id), '[]'::jsonb),
    'notifications', COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.created_at) FROM public.notifications n WHERE n.user_id = p_user_id), '[]'::jsonb)
  );
$$;

-- Repairs only contradictory assignment metadata. It never assigns or changes
-- placement_drive_id, and it aborts if any existing drive reference is invalid.
CREATE OR REPLACE FUNCTION public.phase3_repair_user_email_metadata(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_drive_repaired integer := 0;
  v_legacy_repaired integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));
  IF EXISTS (
    SELECT 1 FROM public.emails e
    LEFT JOIN public.placement_drives d ON d.id = e.placement_drive_id
    WHERE e.user_id = p_user_id AND e.placement_drive_id IS NOT NULL
      AND (d.id IS NULL OR d.user_id IS DISTINCT FROM e.user_id OR d.company_id IS DISTINCT FROM e.company_id)
  ) THEN
    RAISE EXCEPTION 'phase3_repair_user_email_metadata: invalid existing drive reference';
  END IF;

  UPDATE public.emails
  SET assignment_state = 'assigned', assignment_confidence = 'high',
      assignment_source = COALESCE(assignment_source, 'phase3_metadata_repair')
  WHERE user_id = p_user_id AND placement_drive_id IS NOT NULL
    AND assignment_state IN ('ambiguous', 'conflict', 'unassigned', 'legacy');
  GET DIAGNOSTICS v_drive_repaired = ROW_COUNT;

  UPDATE public.emails
  SET assignment_state = 'legacy', assignment_confidence = 'low',
      assignment_source = COALESCE(assignment_source, 'phase3_metadata_repair')
  WHERE user_id = p_user_id AND placement_drive_id IS NULL
    AND assignment_state IN ('assigned', 'manually_assigned');
  GET DIAGNOSTICS v_legacy_repaired = ROW_COUNT;

  RETURN jsonb_build_object('driveMetadataRepaired', v_drive_repaired, 'legacyMetadataRepaired', v_legacy_repaired);
END;
$$;

REVOKE ALL ON FUNCTION public.phase3_preflight_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phase3_preflight_report() TO service_role;
REVOKE ALL ON FUNCTION public.phase3_preflight_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phase3_preflight_counts() TO service_role;
REVOKE ALL ON FUNCTION public.phase3_preflight_user_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phase3_preflight_user_counts(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.phase3_preflight_drive_counts(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phase3_preflight_drive_counts(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.phase3_preflight_user_report(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phase3_preflight_user_report(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.phase3_forensic_user_report(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phase3_forensic_user_report(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.phase3_repair_user_email_metadata(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phase3_repair_user_email_metadata(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.phase3_apply_user_actions(p_user_id uuid, p_actions jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_action jsonb;
  v_action_type text;
  v_record_type text;
  v_record_id uuid;
  v_row_user_id uuid;
  v_company_id uuid;
  v_drive_id uuid;
  v_metadata jsonb;
  v_normalized text;
  v_existing_company_id uuid;
  v_was_inserted boolean;
  v_rows_affected int;
  v_applied jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_drives_created jsonb := '[]'::jsonb;
  v_drives_reused jsonb := '[]'::jsonb;
BEGIN
  IF p_actions IS NULL OR jsonb_typeof(p_actions) <> 'array' THEN
    RAISE EXCEPTION 'phase3_apply_user_actions: p_actions must be a JSON array';
  END IF;

  -- Serializes concurrent phase3 runs for the same user. Auto-released when this
  -- function's transaction ends (commit or rollback) — no explicit unlock needed.
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  IF EXISTS (SELECT 1 FROM public.sync_state WHERE user_id = p_user_id AND is_syncing = TRUE) THEN
    RAISE EXCEPTION 'phase3_apply_user_actions: live sync in progress for user %; skip and retry later', p_user_id;
  END IF;

  FOR v_action IN SELECT * FROM jsonb_array_elements(p_actions)
  LOOP
    v_action_type := v_action->>'action';
    v_record_type := v_action->>'record_type';
    v_record_id := (v_action->>'record_id')::uuid;
    v_row_user_id := (v_action->>'user_id')::uuid;
    v_company_id := (v_action->>'company_id')::uuid;
    v_metadata := COALESCE(v_action->'metadata', '{}'::jsonb);
    v_rows_affected := 0;

    IF v_row_user_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'phase3_apply_user_actions: action for % % claims user %, does not match p_user_id %',
        v_record_type, v_record_id, v_row_user_id, p_user_id;
    END IF;

    -- Defense in depth: re-verify the company actually belongs to this user, even though the
    -- TS layer already asserted this before building the action.
    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = v_company_id AND user_id = p_user_id) THEN
      v_conflicts := v_conflicts || jsonb_build_object(
        'recordType', v_record_type, 'recordId', v_record_id,
        'reason', format('company %s does not belong to user %s', v_company_id, p_user_id)
      );
      CONTINUE;
    END IF;

    IF v_record_type = 'candidate_match' AND NOT EXISTS (
      SELECT 1
      FROM public.candidate_matches cm
      LEFT JOIN public.emails em ON em.id = cm.email_id
      LEFT JOIN public.applications ap ON ap.id = cm.application_id
      WHERE cm.id = v_record_id
        AND cm.user_id = p_user_id
        AND (
          (em.id IS NOT NULL AND em.user_id = p_user_id AND em.company_id = v_company_id)
          OR (ap.id IS NOT NULL AND ap.user_id = p_user_id AND ap.company_id = v_company_id)
        )
    ) THEN
      v_conflicts := v_conflicts || jsonb_build_object(
        'recordType', v_record_type, 'recordId', v_record_id,
        'reason', format('candidate_match %s does not belong to company %s through its email/application', v_record_id, v_company_id)
      );
      CONTINUE;
    END IF;

    IF v_record_type = 'notification' AND NOT EXISTS (
      SELECT 1
      FROM public.notifications n
      LEFT JOIN public.events ev ON ev.id = n.event_id
      LEFT JOIN public.applications ap ON ap.id = n.application_id
      WHERE n.id = v_record_id
        AND n.user_id = p_user_id
        AND (
          n.company_id = v_company_id
          OR (ev.id IS NOT NULL AND ev.company_id = v_company_id)
          OR (ap.id IS NOT NULL AND ap.company_id = v_company_id)
        )
    ) THEN
      v_conflicts := v_conflicts || jsonb_build_object(
        'recordType', v_record_type, 'recordId', v_record_id,
        'reason', format('notification %s does not belong to company %s', v_record_id, v_company_id)
      );
      CONTINUE;
    END IF;

    v_drive_id := NULL;

    IF v_action_type = 'create_drive_then_assign' THEN
      v_normalized := v_action->>'normalized_drive_number';

      SELECT d.id, d.company_id
      INTO v_drive_id, v_existing_company_id
      FROM public.placement_drives d
      WHERE d.user_id = p_user_id
        AND d.normalized_drive_number = v_normalized
      FOR UPDATE;

      IF v_drive_id IS NULL THEN
        INSERT INTO public.placement_drives (
          user_id, company_id, drive_number, normalized_drive_number,
          drive_name, role, category, ctc, stipend, location, registration_deadline,
          identity_state, identity_confidence, identity_source
        ) VALUES (
          p_user_id, v_company_id, v_normalized, v_normalized,
          NULLIF(v_metadata->>'driveName', ''),
          NULLIF(v_metadata->>'role', ''),
          NULLIF(v_metadata->>'category', ''),
          NULLIF(v_metadata->>'ctc', ''),
          NULLIF(v_metadata->>'stipend', ''),
          NULLIF(v_metadata->>'location', ''),
          NULLIF(v_metadata->>'registrationDeadline', '')::timestamptz,
          'assigned', 'high', 'phase3_backfill_explicit_drive_number'
        )
        RETURNING id, company_id INTO v_drive_id, v_existing_company_id;
        v_was_inserted := TRUE;
      ELSE
        v_was_inserted := FALSE;
      END IF;

      IF v_existing_company_id IS DISTINCT FROM v_company_id THEN
        v_conflicts := v_conflicts || jsonb_build_object(
          'recordType', v_record_type, 'recordId', v_record_id,
          'reason', format('drive number %s already belongs to company %s, not %s',
            v_normalized, v_existing_company_id, v_company_id)
        );
        CONTINUE;
      END IF;

      UPDATE public.placement_drives
      SET drive_name = COALESCE(NULLIF(v_metadata->>'driveName', ''), drive_name),
          role = COALESCE(NULLIF(v_metadata->>'role', ''), role),
          category = COALESCE(NULLIF(v_metadata->>'category', ''), category),
          ctc = COALESCE(NULLIF(v_metadata->>'ctc', ''), ctc),
          stipend = COALESCE(NULLIF(v_metadata->>'stipend', ''), stipend),
          location = COALESCE(NULLIF(v_metadata->>'location', ''), location),
          registration_deadline = COALESCE(NULLIF(v_metadata->>'registrationDeadline', '')::timestamptz, registration_deadline),
          updated_at = now()
      WHERE id = v_drive_id AND user_id = p_user_id AND company_id = v_company_id;

      IF v_was_inserted THEN
        v_drives_created := v_drives_created || to_jsonb(v_normalized);
      ELSE
        v_drives_reused := v_drives_reused || to_jsonb(v_normalized);
      END IF;

    ELSIF v_action_type = 'assign_existing_drive' THEN
      v_drive_id := (v_action->>'drive_id')::uuid;

      SELECT company_id INTO v_existing_company_id
      FROM public.placement_drives
      WHERE id = v_drive_id AND user_id = p_user_id;

      IF v_existing_company_id IS NULL THEN
        v_conflicts := v_conflicts || jsonb_build_object(
          'recordType', v_record_type, 'recordId', v_record_id,
          'reason', format('drive %s not found for user %s', v_drive_id, p_user_id)
        );
        CONTINUE;
      END IF;

      IF v_existing_company_id IS DISTINCT FROM v_company_id THEN
        v_conflicts := v_conflicts || jsonb_build_object(
          'recordType', v_record_type, 'recordId', v_record_id,
          'reason', format('drive %s belongs to company %s, not %s', v_drive_id, v_existing_company_id, v_company_id)
        );
        CONTINUE;
      END IF;

      v_drives_reused := v_drives_reused || to_jsonb(v_drive_id::text);
    ELSE
      RAISE EXCEPTION 'phase3_apply_user_actions: unknown action type %', v_action_type;
    END IF;

    -- Idempotent, guarded assignment. `placement_drive_id IS NULL` is what makes a rerun (or a
    -- race with another writer) safe: 0 rows affected is logged, never treated as an error.
    IF v_record_type = 'application' THEN
      UPDATE public.applications
         SET placement_drive_id = v_drive_id, identity_scope = 'drive', last_updated = now()
       WHERE id = v_record_id AND user_id = p_user_id AND company_id = v_company_id AND placement_drive_id IS NULL;
      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

    ELSIF v_record_type = 'event' THEN
      UPDATE public.events
         SET placement_drive_id = v_drive_id, updated_at = now()
       WHERE id = v_record_id AND user_id = p_user_id AND company_id = v_company_id AND placement_drive_id IS NULL;
      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

    ELSIF v_record_type = 'candidate_match' THEN
      UPDATE public.candidate_matches AS cm
         SET placement_drive_id = v_drive_id
       WHERE cm.id = v_record_id
         AND cm.user_id = p_user_id
         AND cm.placement_drive_id IS NULL
         AND (
           EXISTS (
             SELECT 1 FROM public.emails em
             WHERE em.id = cm.email_id
               AND em.user_id = p_user_id
               AND em.company_id = v_company_id
           )
           OR EXISTS (
             SELECT 1 FROM public.applications ap
             WHERE ap.id = cm.application_id
               AND ap.user_id = p_user_id
               AND ap.company_id = v_company_id
           )
         );
      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

    ELSIF v_record_type = 'notification' THEN
      UPDATE public.notifications
         SET placement_drive_id = v_drive_id
       WHERE id = v_record_id AND user_id = p_user_id AND company_id = v_company_id AND placement_drive_id IS NULL;
      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

    ELSIF v_record_type = 'email' THEN
      UPDATE public.emails
         SET placement_drive_id = v_drive_id,
             assignment_state = 'assigned',
             assignment_confidence = 'high',
             assignment_source = 'phase3_backfill'
       WHERE id = v_record_id AND user_id = p_user_id AND company_id = v_company_id AND placement_drive_id IS NULL;
      GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

      IF v_rows_affected = 1 THEN
        INSERT INTO public.email_drive_links (
          user_id, email_id, placement_drive_id, link_type, confidence, assignment_source, is_primary
        ) VALUES (
          p_user_id, v_record_id, v_drive_id, 'primary', 'high', 'phase3_backfill', TRUE
        )
        ON CONFLICT (email_id, placement_drive_id, link_type) DO NOTHING;
      END IF;

    ELSE
      RAISE EXCEPTION 'phase3_apply_user_actions: unknown record_type %', v_record_type;
    END IF;

    IF v_rows_affected = 1 THEN
      v_applied := v_applied || jsonb_build_object(
        'recordType', v_record_type, 'recordId', v_record_id, 'driveId', v_drive_id
      );
    ELSE
      v_skipped := v_skipped || jsonb_build_object(
        'recordType', v_record_type, 'recordId', v_record_id,
        'reason', 'already migrated concurrently (0 rows matched placement_drive_id IS NULL)'
      );
    END IF;
  END LOOP;

  -- Post-condition validation, scoped to this user, BEFORE returning/committing. Any failure
  -- here rolls back every write this call made (materialized drives included).
  IF EXISTS (
    SELECT 1 FROM public.applications
    WHERE user_id = p_user_id AND placement_drive_id IS NOT NULL
    GROUP BY placement_drive_id HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'phase3_apply_user_actions: post-condition failed for user % — duplicate drive-owned applications', p_user_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.events
    WHERE user_id = p_user_id AND placement_drive_id IS NOT NULL AND start_time IS NOT NULL
    GROUP BY placement_drive_id, event_type, start_time HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'phase3_apply_user_actions: post-condition failed for user % — duplicate drive-owned events', p_user_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.candidate_matches
    WHERE user_id = p_user_id AND placement_drive_id IS NOT NULL
    GROUP BY email_id, placement_drive_id, neo_id, match_type HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'phase3_apply_user_actions: post-condition failed for user % — duplicate drive-owned candidate_matches', p_user_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.applications a
    JOIN public.placement_drives d ON d.id = a.placement_drive_id
    WHERE a.user_id = p_user_id AND a.placement_drive_id IS NOT NULL
      AND (a.user_id <> d.user_id OR a.company_id <> d.company_id)
  ) THEN
    RAISE EXCEPTION 'phase3_apply_user_actions: post-condition failed for user % — application/drive ownership mismatch', p_user_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.events e
    JOIN public.applications a ON a.id = e.application_id
    WHERE e.user_id = p_user_id
      AND e.placement_drive_id IS NOT NULL
      AND a.placement_drive_id IS DISTINCT FROM e.placement_drive_id
  ) THEN
    RAISE EXCEPTION 'phase3_apply_user_actions: post-condition failed for user % — event/application drive mismatch', p_user_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.candidate_matches cm
    JOIN public.applications a ON a.id = cm.application_id
    WHERE cm.user_id = p_user_id
      AND cm.placement_drive_id IS NOT NULL
      AND a.placement_drive_id IS DISTINCT FROM cm.placement_drive_id
  ) THEN
    RAISE EXCEPTION 'phase3_apply_user_actions: post-condition failed for user % — candidate/application drive mismatch', p_user_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.notifications n
    JOIN public.events e ON e.id = n.event_id
    WHERE n.user_id = p_user_id
      AND n.placement_drive_id IS NOT NULL
      AND e.placement_drive_id IS DISTINCT FROM n.placement_drive_id
  ) THEN
    RAISE EXCEPTION 'phase3_apply_user_actions: post-condition failed for user % — notification/event drive mismatch', p_user_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.candidate_matches cm
    JOIN public.emails e ON e.id = cm.email_id
    WHERE cm.user_id = p_user_id
      AND cm.placement_drive_id IS NOT NULL
      AND e.placement_drive_id IS NOT NULL
      AND cm.placement_drive_id IS DISTINCT FROM e.placement_drive_id
  ) THEN
    RAISE EXCEPTION 'phase3_apply_user_actions: post-condition failed for user % — candidate/email drive mismatch', p_user_id;
  END IF;

  RETURN jsonb_build_object(
    'applied', v_applied,
    'skippedAlreadyMigratedConcurrently', v_skipped,
    'conflicts', v_conflicts,
    'drivesCreated', v_drives_created,
    'drivesReused', v_drives_reused
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phase3_apply_user_actions(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phase3_apply_user_actions(uuid, jsonb) TO service_role;

-- Database-level defense for cross-entity scope drift. Legacy rows remain valid
-- because NULL drive IDs are explicitly accepted. Drive-owned rows must agree
-- with their linked application/event and must remain in the same tenant.
CREATE OR REPLACE FUNCTION public.phase3_assert_drive_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_drive_user uuid;
  v_drive_company uuid;
  v_app_drive uuid;
  v_app_user uuid;
  v_app_company uuid;
  v_event_drive uuid;
  v_event_user uuid;
  v_event_company uuid;
BEGIN
  IF TG_TABLE_NAME = 'applications' AND NEW.placement_drive_id IS NOT NULL THEN
    SELECT user_id, company_id INTO v_drive_user, v_drive_company
      FROM public.placement_drives WHERE id = NEW.placement_drive_id;
    IF v_drive_user IS NULL OR NEW.user_id IS DISTINCT FROM v_drive_user OR NEW.company_id IS DISTINCT FROM v_drive_company THEN
      RAISE EXCEPTION 'drive/application ownership mismatch for application %', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'events' THEN
    IF NEW.placement_drive_id IS NOT NULL THEN
      SELECT user_id, company_id INTO v_drive_user, v_drive_company
        FROM public.placement_drives WHERE id = NEW.placement_drive_id;
      IF v_drive_user IS NULL OR NEW.user_id IS DISTINCT FROM v_drive_user OR NEW.company_id IS DISTINCT FROM v_drive_company THEN
        RAISE EXCEPTION 'drive/event ownership mismatch for event %', NEW.id;
      END IF;
    END IF;
    IF NEW.application_id IS NOT NULL THEN
      SELECT placement_drive_id, user_id, company_id INTO v_app_drive, v_app_user, v_app_company
        FROM public.applications WHERE id = NEW.application_id;
      IF v_app_drive IS DISTINCT FROM NEW.placement_drive_id
         OR v_app_user IS DISTINCT FROM NEW.user_id
         OR v_app_company IS DISTINCT FROM NEW.company_id THEN
        RAISE EXCEPTION 'event/application scope mismatch for event %', NEW.id;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'candidate_matches' THEN
    IF NEW.placement_drive_id IS NOT NULL THEN
      SELECT user_id, company_id INTO v_drive_user, v_drive_company
        FROM public.placement_drives WHERE id = NEW.placement_drive_id;
      IF v_drive_user IS NULL OR NEW.user_id IS DISTINCT FROM v_drive_user THEN
        RAISE EXCEPTION 'drive/candidate_match ownership mismatch for candidate_match %', NEW.id;
      END IF;
    END IF;
    IF NEW.application_id IS NOT NULL THEN
    SELECT placement_drive_id, user_id, company_id INTO v_app_drive, v_app_user, v_app_company
      FROM public.applications WHERE id = NEW.application_id;
      IF v_app_user IS DISTINCT FROM NEW.user_id THEN
        RAISE EXCEPTION 'candidate_match/application scope mismatch for candidate_match %', NEW.id;
      END IF;
      IF v_app_drive IS NOT NULL AND v_app_drive IS DISTINCT FROM NEW.placement_drive_id THEN
        RAISE EXCEPTION 'candidate_match/application drive mismatch for candidate_match %', NEW.id;
      END IF;
    END IF;
    IF NEW.email_id IS NOT NULL THEN
      SELECT placement_drive_id, user_id INTO v_app_drive, v_app_user
        FROM public.emails WHERE id = NEW.email_id;
      IF v_app_user IS DISTINCT FROM NEW.user_id THEN
        RAISE EXCEPTION 'candidate_match/email scope mismatch for candidate_match %', NEW.id;
      END IF;
      IF v_app_drive IS NOT NULL AND v_app_drive IS DISTINCT FROM NEW.placement_drive_id THEN
        RAISE EXCEPTION 'candidate_match/email drive mismatch for candidate_match %', NEW.id;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'notifications' THEN
    IF NEW.placement_drive_id IS NOT NULL THEN
      SELECT user_id, company_id INTO v_drive_user, v_drive_company
        FROM public.placement_drives WHERE id = NEW.placement_drive_id;
      IF v_drive_user IS NULL OR NEW.user_id IS DISTINCT FROM v_drive_user OR NEW.company_id IS DISTINCT FROM v_drive_company THEN
        RAISE EXCEPTION 'drive/notification ownership mismatch for notification %', NEW.id;
      END IF;
    END IF;
    IF NEW.event_id IS NOT NULL THEN
      SELECT placement_drive_id, user_id, company_id INTO v_event_drive, v_event_user, v_event_company
        FROM public.events WHERE id = NEW.event_id;
      IF v_event_drive IS DISTINCT FROM NEW.placement_drive_id
         OR v_event_user IS DISTINCT FROM NEW.user_id
         OR v_event_company IS DISTINCT FROM NEW.company_id THEN
        RAISE EXCEPTION 'notification/event scope mismatch for notification %', NEW.id;
      END IF;
    END IF;
    IF NEW.application_id IS NOT NULL THEN
      SELECT placement_drive_id, user_id, company_id INTO v_app_drive, v_app_user, v_app_company
        FROM public.applications WHERE id = NEW.application_id;
      IF v_app_drive IS DISTINCT FROM NEW.placement_drive_id
         OR v_app_user IS DISTINCT FROM NEW.user_id
         OR v_app_company IS DISTINCT FROM NEW.company_id THEN
        RAISE EXCEPTION 'notification/application scope mismatch for notification %', NEW.id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS phase3_assert_application_drive ON public.applications;
CREATE TRIGGER phase3_assert_application_drive
  BEFORE INSERT OR UPDATE OF user_id, company_id, placement_drive_id ON public.applications
  FOR EACH ROW EXECUTE FUNCTION public.phase3_assert_drive_consistency();

DROP TRIGGER IF EXISTS phase3_assert_event_drive ON public.events;
CREATE TRIGGER phase3_assert_event_drive
  BEFORE INSERT OR UPDATE OF user_id, company_id, placement_drive_id, application_id ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.phase3_assert_drive_consistency();

DROP TRIGGER IF EXISTS phase3_assert_candidate_match_drive ON public.candidate_matches;
CREATE TRIGGER phase3_assert_candidate_match_drive
  BEFORE INSERT OR UPDATE OF user_id, placement_drive_id, application_id, email_id ON public.candidate_matches
  FOR EACH ROW EXECUTE FUNCTION public.phase3_assert_drive_consistency();

DROP TRIGGER IF EXISTS phase3_assert_notification_drive ON public.notifications;
CREATE TRIGGER phase3_assert_notification_drive
  BEFORE INSERT OR UPDATE OF user_id, company_id, placement_drive_id, event_id, application_id ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.phase3_assert_drive_consistency();

COMMIT;
