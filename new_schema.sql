-- ============================================================================
-- MIGRATION: Globalize companies, placement_drives, events
-- ============================================================================
-- Converts companies / placement_drives / events from per-user-scoped rows
-- to shared global rows (one row per real-world company / drive / event),
-- since students never edit these directly and every eligible student sees
-- the same drive details and event timings.
--
-- Scope confirmed final:
--   - companies, placement_drives -> globalize (this script)
--   - canonical_emails, canonical_attachments, drive_resolutions -> already
--     global (no user_id column exists on any of them today; no action)
--   - candidate_matches -> stays per-user (each sync only ever inserts a
--     row for the syncing user's own neo_id, so there is no cross-user
--     duplication to collapse); left untouched by this script.
--   - events -> stays per-user (gcal_event_id is inherently per-user --
--     each student pushes the event to their own Google Calendar and gets
--     back their own calendar event id, so a single canonical events row
--     cannot hold every student's gcal_event_id. Also, a hard
--     UNIQUE(placement_drive_id, event_type) would break multi-round
--     drives that legitimately have two events of the same event_type.
--     events.placement_drive_id still gets repointed to the surviving
--     canonical drive id below, since placement_drives itself is still
--     being deduped -- only the events-internal dedup/globalization is
--     skipped). The read-path duplication this leaves in place (same
--     event, N rows, one per student) is intended to be solved at the
--     dashboard/materialized-view layer, not by collapsing storage.
--
-- ============================================================================
-- PRE-FLIGHT CHECKS -- run these BEFORE the migration, separately, not
-- inside this transaction. Not blockers to running the script itself, but
-- worth knowing the answers before you treat "events stays per-user" as
-- settled long-term.
-- ============================================================================
-- Does the same user already have >1 event of the same type for the same
-- drive today? If this returns rows, your parser has already produced
-- same-user/same-drive/same-event_type ambiguity independent of this
-- migration -- worth understanding before deciding how "round 2 interview"
-- vs "round 1 interview" should be distinguished going forward:
--   SELECT user_id, placement_drive_id, event_type, count(*)
--   FROM events GROUP BY 1,2,3 HAVING count(*) > 1;
--
-- How many placement_drives rows have neither normalized_drive_number nor
-- drive_number at all? These are the ones Phase 2 cannot merge
-- automatically and will need manual review after this migration:
--   SELECT count(*) FROM placement_drives
--   WHERE normalized_drive_number IS NULL AND drive_number IS NULL;
-- ============================================================================
-- BEFORE RUNNING:
--   1. Take a full pg_dump backup of production.
--   2. Run this on a staging copy first and check the verification queries
--      at the bottom return zero rows.
--   3. Pause the Gmail Pub/Sub sync workers (or expect a brief backlog).
--      NOTE: reads to companies/placement_drives will ALSO briefly queue,
--      not just writes -- ALTER TABLE ... DROP COLUMN takes an ACCESS
--      EXCLUSIVE lock, and since this is one transaction, that lock is
--      held until COMMIT. In practice this is seconds at your current
--      data volume, but it is not the read-only-stays-live guarantee an
--      earlier version of this note implied. Run during low-traffic
--      hours regardless.
--   4. This is one transaction. If anything fails, the whole thing rolls
--      back and production is untouched. A lock_timeout is set below so
--      that if some other session is mid-query and blocking the ACCESS
--      EXCLUSIVE lock, this fails fast and rolls back cleanly instead of
--      hanging indefinitely and piling up blocked queries behind it.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ============================================================================
-- PHASE 0: Temporary merge-tracking columns
-- ============================================================================
ALTER TABLE public.companies        ADD COLUMN IF NOT EXISTS _canonical_id UUID;
ALTER TABLE public.placement_drives ADD COLUMN IF NOT EXISTS _canonical_id UUID;

-- ============================================================================
-- PHASE 1: Dedup companies
-- ============================================================================
-- Merge key: case-insensitive, trimmed name. Companies with genuinely
-- different names ("TCS" vs "Tata Consultancy Services") will NOT merge
-- here -- that needs the alias-matching admin review discussed separately
-- (exact match -> alias match -> no match found -> flag for admin review).
-- This phase only fixes the "same name, N rows because N users" case.

WITH ranked AS (
  SELECT id, name,
         row_number() OVER (
           PARTITION BY lower(trim(name))
           ORDER BY created_at ASC, id ASC   -- id ASC: deterministic tiebreak
         ) AS rn
  FROM public.companies
),
winners AS (
  SELECT lower(trim(name)) AS key, id AS canonical_id
  FROM ranked WHERE rn = 1
)
UPDATE public.companies c
SET _canonical_id = w.canonical_id
FROM winners w
WHERE lower(trim(c.name)) = w.key;

-- Merge every duplicate's name + aliases into the canonical row's aliases,
-- so no alias information is lost when duplicates are deleted.
WITH dupes AS (
  SELECT _canonical_id AS canonical_id, name, aliases
  FROM public.companies
  WHERE id <> _canonical_id
)
UPDATE public.companies canon
SET aliases = (
  SELECT array_agg(DISTINCT a) FROM (
    SELECT unnest(canon.aliases) AS a
    UNION SELECT d.name FROM dupes d WHERE d.canonical_id = canon.id
    UNION SELECT unnest(d.aliases) FROM dupes d WHERE d.canonical_id = canon.id
  ) merged
)
WHERE EXISTS (SELECT 1 FROM dupes d WHERE d.canonical_id = canon.id);

-- Repoint placement_drives.company_id to the canonical company
UPDATE public.placement_drives pd
SET company_id = c._canonical_id
FROM public.companies c
WHERE pd.company_id = c.id AND c.id <> c._canonical_id;

-- Delete duplicate company rows
DELETE FROM public.companies WHERE id <> _canonical_id;

-- Clean up companies: drop temp column, drop old policies, drop user_id, rebuild indexes
ALTER TABLE public.companies DROP COLUMN _canonical_id;
DROP POLICY IF EXISTS companies_own_data ON public.companies;
DROP POLICY IF EXISTS companies_tenant_isolation ON public.companies;
DROP INDEX IF EXISTS idx_companies_name;
DROP INDEX IF EXISTS idx_companies_user;
DROP INDEX IF EXISTS idx_companies_user_id;
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_user_id_fkey;
ALTER TABLE public.companies DROP COLUMN IF EXISTS user_id CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_name_ci ON public.companies (lower(trim(name)));

-- ============================================================================
-- PHASE 2: Dedup placement_drives
-- ============================================================================
-- Merge key: normalized_drive_number, falling back to lower(trim(drive_number))
-- if normalization was never populated. Rows with BOTH null can't be merged
-- automatically -- they're left as-is (canonical = self) for manual review.

WITH keyed AS (
  SELECT id, COALESCE(normalized_drive_number, lower(trim(drive_number))) AS merge_key
  FROM public.placement_drives
),
ranked AS (
  SELECT k.id, k.merge_key,
         row_number() OVER (
           PARTITION BY k.merge_key
           ORDER BY
             CASE pd.identity_confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
             (pd.drive_name IS NOT NULL)::int DESC,
             (pd.role IS NOT NULL)::int DESC,
             (pd.ctc IS NOT NULL)::int DESC,
             pd.updated_at DESC,
             pd.id ASC                      -- deterministic tiebreak
         ) AS rn
  FROM keyed k
  JOIN public.placement_drives pd ON pd.id = k.id
  WHERE k.merge_key IS NOT NULL
),
winners AS (
  SELECT merge_key, id AS canonical_id FROM ranked WHERE rn = 1
)
UPDATE public.placement_drives pd
SET _canonical_id = w.canonical_id
FROM winners w, keyed k
WHERE k.id = pd.id AND k.merge_key = w.merge_key;

-- Rows with no usable merge key: canonical = self (left alone, flagged below)
UPDATE public.placement_drives SET _canonical_id = id WHERE _canonical_id IS NULL;

-- Coalesce field values from duplicates onto each canonical row. Fixed to be
-- deterministic even with 3+ duplicates per canonical row: for each field
-- independently, take the first non-null value in priority order (highest
-- identity_confidence, then most recently updated, then lowest id), instead
-- of relying on a single "best" row via UPDATE...FROM with multiple matches
-- (which Postgres does not guarantee resolves consistently).
WITH ranked_all AS (
  SELECT *,
         row_number() OVER (
           PARTITION BY _canonical_id
           ORDER BY
             CASE identity_confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
             updated_at DESC,
             id ASC
         ) AS priority_rank
  FROM public.placement_drives
),
merged AS (
  SELECT
    r._canonical_id,
    (array_agg(r.drive_name              ORDER BY r.priority_rank) FILTER (WHERE r.drive_name              IS NOT NULL))[1] AS drive_name,
    (array_agg(r.role                    ORDER BY r.priority_rank) FILTER (WHERE r.role                    IS NOT NULL))[1] AS role,
    (array_agg(r.category                ORDER BY r.priority_rank) FILTER (WHERE r.category                IS NOT NULL))[1] AS category,
    (array_agg(r.ctc                     ORDER BY r.priority_rank) FILTER (WHERE r.ctc                     IS NOT NULL))[1] AS ctc,
    (array_agg(r.stipend                 ORDER BY r.priority_rank) FILTER (WHERE r.stipend                 IS NOT NULL))[1] AS stipend,
    (array_agg(r.location                ORDER BY r.priority_rank) FILTER (WHERE r.location                IS NOT NULL))[1] AS location,
    (array_agg(r.eligibility             ORDER BY r.priority_rank) FILTER (WHERE r.eligibility             IS NOT NULL))[1] AS eligibility,
    (SELECT b.branches FROM ranked_all b WHERE b._canonical_id = r._canonical_id AND b.branches IS NOT NULL ORDER BY b.priority_rank LIMIT 1) AS branches,
    (array_agg(r.cgpa_requirement        ORDER BY r.priority_rank) FILTER (WHERE r.cgpa_requirement        IS NOT NULL))[1] AS cgpa_requirement,
    (array_agg(r.backlog_requirement     ORDER BY r.priority_rank) FILTER (WHERE r.backlog_requirement     IS NOT NULL))[1] AS backlog_requirement,
    (array_agg(r.registration_deadline   ORDER BY r.priority_rank) FILTER (WHERE r.registration_deadline   IS NOT NULL))[1] AS registration_deadline,
    (array_agg(r.drive_number            ORDER BY r.priority_rank) FILTER (WHERE r.drive_number            IS NOT NULL))[1] AS drive_number,
    (array_agg(r.normalized_drive_number ORDER BY r.priority_rank) FILTER (WHERE r.normalized_drive_number IS NOT NULL))[1] AS normalized_drive_number
  FROM ranked_all r
  GROUP BY r._canonical_id
)
UPDATE public.placement_drives canon
SET drive_name              = COALESCE(canon.drive_name, merged.drive_name),
    role                    = COALESCE(canon.role, merged.role),
    category                = COALESCE(canon.category, merged.category),
    ctc                     = COALESCE(canon.ctc, merged.ctc),
    stipend                 = COALESCE(canon.stipend, merged.stipend),
    location                = COALESCE(canon.location, merged.location),
    eligibility             = COALESCE(canon.eligibility, merged.eligibility),
    branches                = COALESCE(canon.branches, merged.branches),
    cgpa_requirement        = COALESCE(canon.cgpa_requirement, merged.cgpa_requirement),
    backlog_requirement     = COALESCE(canon.backlog_requirement, merged.backlog_requirement),
    registration_deadline   = COALESCE(canon.registration_deadline, merged.registration_deadline),
    drive_number            = COALESCE(canon.drive_number, merged.drive_number),
    normalized_drive_number = COALESCE(canon.normalized_drive_number, merged.normalized_drive_number)
FROM merged
WHERE canon.id = merged._canonical_id;

-- --- Pre-cleanup: remove rows that WOULD collide against unique indexes
-- --- once their placement_drive_id gets repointed to the canonical id.

-- applications: UNIQUE(user_id, placement_drive_id)
WITH mapped AS (
  SELECT a.id, a.user_id, pd._canonical_id AS new_drive_id,
         row_number() OVER (
           PARTITION BY a.user_id, pd._canonical_id
           ORDER BY a.manual_override DESC, a.last_updated DESC, a.id ASC
         ) AS rn
  FROM public.applications a
  JOIN public.placement_drives pd ON pd.id = a.placement_drive_id
)
DELETE FROM public.applications a
USING mapped m
WHERE a.id = m.id AND m.rn > 1;

-- candidate_matches: UNIQUE(user_id, placement_drive_id, neo_id, match_type, matched_round_type) WHERE email_id IS NULL
-- (candidate_matches itself stays per-user -- this cleanup only exists
-- because the unique index is keyed on placement_drive_id, which is about
-- to change after the repoint below.)
WITH mapped AS (
  SELECT cm.id,
         row_number() OVER (
           PARTITION BY cm.user_id, pd._canonical_id, cm.neo_id, cm.match_type, cm.matched_round_type
           ORDER BY CASE cm.confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, cm.created_at DESC, cm.id ASC
         ) AS rn
  FROM public.candidate_matches cm
  JOIN public.placement_drives pd ON pd.id = cm.placement_drive_id
  WHERE cm.email_id IS NULL
)
DELETE FROM public.candidate_matches cm
USING mapped m
WHERE cm.id = m.id AND m.rn > 1;

-- --- Now safe to repoint every FK that points at a duplicate drive ---
UPDATE public.applications a SET placement_drive_id = pd._canonical_id
FROM public.placement_drives pd WHERE a.placement_drive_id = pd.id AND pd.id <> pd._canonical_id;

UPDATE public.events e SET placement_drive_id = pd._canonical_id
FROM public.placement_drives pd WHERE e.placement_drive_id = pd.id AND pd.id <> pd._canonical_id;

UPDATE public.candidate_matches cm SET placement_drive_id = pd._canonical_id
FROM public.placement_drives pd WHERE cm.placement_drive_id = pd.id AND pd.id <> pd._canonical_id;

UPDATE public.email_drive_links edl SET placement_drive_id = pd._canonical_id
FROM public.placement_drives pd WHERE edl.placement_drive_id = pd.id AND pd.id <> pd._canonical_id;

UPDATE public.emails em SET placement_drive_id = pd._canonical_id
FROM public.placement_drives pd WHERE em.placement_drive_id = pd.id AND pd.id <> pd._canonical_id;

UPDATE public.notifications n SET placement_drive_id = pd._canonical_id
FROM public.placement_drives pd WHERE n.placement_drive_id = pd.id AND pd.id <> pd._canonical_id;

-- Delete duplicate placement_drives rows
DELETE FROM public.placement_drives WHERE id <> _canonical_id;

-- Clean up placement_drives: drop temp column, drop old policies, drop user_id, rebuild constraints/indexes
ALTER TABLE public.placement_drives DROP COLUMN _canonical_id;
DROP POLICY IF EXISTS placement_drives_own_data ON public.placement_drives;
DROP POLICY IF EXISTS placement_drives_tenant_isolation ON public.placement_drives;
DROP INDEX IF EXISTS idx_placement_drives_user_drive_number;
DROP INDEX IF EXISTS idx_placement_drives_user;
DROP INDEX IF EXISTS idx_placement_drives_user_id;
DROP INDEX IF EXISTS idx_placement_drives_state;
ALTER TABLE public.placement_drives DROP CONSTRAINT IF EXISTS placement_drives_user_id_id_key;
ALTER TABLE public.placement_drives DROP CONSTRAINT IF EXISTS placement_drives_user_id_fkey;
ALTER TABLE public.placement_drives DROP COLUMN IF EXISTS user_id CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_placement_drives_drive_number
  ON public.placement_drives (normalized_drive_number)
  WHERE normalized_drive_number IS NOT NULL;
-- Fallback protection: rows with no normalized_drive_number (identity
-- resolution never populated it) still shouldn't be able to re-duplicate
-- going forward via the raw drive_number. Without this, only the
-- normalized path is protected and the fallback merge key used above
-- (COALESCE(normalized_drive_number, lower(trim(drive_number)))) has no
-- DB-level guarantee after this migration completes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_placement_drives_drive_number_fallback
  ON public.placement_drives (lower(trim(drive_number)))
  WHERE normalized_drive_number IS NULL AND drive_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_placement_drives_state ON public.placement_drives (identity_state);

-- ============================================================================
-- events.placement_drive_id is already repointed to the canonical drive id
-- above (in the "Now safe to repoint every FK" block in Phase 2). events
-- itself is NOT globalized -- it keeps user_id, its own indexes
-- (idx_events_user, idx_events_user_drive_type_date), and its own RLS
-- policy (events_tenant_isolation) exactly as they are today. See the
-- header note above for why.
-- ============================================================================

-- ============================================================================
-- PHASE 4: RLS policy updates for the now-global tables
-- ============================================================================
-- companies and placement_drives no longer have a user_id column, so the
-- generic "user_id = auth.uid()" tenant-isolation policy no longer applies
-- to them. Everyone can READ them (they're shared reference data); only
-- your backend (via the service_role key, which bypasses RLS) can write
-- to them. events is untouched here -- its existing tenant_isolation
-- policy still applies since it's still user-scoped.

DROP POLICY IF EXISTS companies_own_data ON public.companies;
DROP POLICY IF EXISTS companies_tenant_isolation ON public.companies;
DROP POLICY IF EXISTS companies_read_all ON public.companies;

DROP POLICY IF EXISTS placement_drives_own_data ON public.placement_drives;
DROP POLICY IF EXISTS placement_drives_tenant_isolation ON public.placement_drives;
DROP POLICY IF EXISTS placement_drives_read_all ON public.placement_drives;

CREATE POLICY companies_read_all ON public.companies
  FOR SELECT TO authenticated USING (true);
CREATE POLICY placement_drives_read_all ON public.placement_drives
  FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.companies TO authenticated, anon;
GRANT SELECT ON public.placement_drives TO authenticated, anon;

COMMIT;

-- ============================================================================
-- VERIFICATION -- run these AFTER the migration and confirm all return 0 rows
-- ============================================================================
-- No duplicate companies remain:
--   SELECT lower(trim(name)), count(*) FROM companies GROUP BY 1 HAVING count(*) > 1;
--
-- No duplicate placement_drives remain (excluding rows with no drive number,
-- which were intentionally left unmerged):
--   SELECT normalized_drive_number, count(*) FROM placement_drives
--   WHERE normalized_drive_number IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
--
-- No duplicate events remain:
--   SELECT placement_drive_id, event_type, count(*) FROM events
--   GROUP BY 1,2 HAVING count(*) > 1;
--
-- Drives still needing manual identification (no drive number at all --
-- these were left as individual rows and won't have merged):
--   SELECT id, drive_name, company_id, created_at FROM placement_drives
--   WHERE normalized_drive_number IS NULL AND drive_number IS NULL;
--
-- Nothing is left pointing at a placement_drives id that no longer exists:
--   SELECT 'applications' t, a.id FROM applications a
--     LEFT JOIN placement_drives pd ON pd.id = a.placement_drive_id WHERE pd.id IS NULL
--   UNION ALL
--   SELECT 'events', e.id FROM events e
--     LEFT JOIN placement_drives pd ON pd.id = e.placement_drive_id WHERE pd.id IS NULL
--   UNION ALL
--   SELECT 'candidate_matches', cm.id FROM candidate_matches cm
--     LEFT JOIN placement_drives pd ON pd.id = cm.placement_drive_id WHERE pd.id IS NULL;

-- ============================================================================
-- APPLICATION CODE THAT MUST CHANGE AFTER THIS RUNS
-- ============================================================================
-- 1. Sync engine's get-or-create for drives: drop the `.eq('user_id', ...)`
--    scope -- lookup by normalized_drive_number alone, globally.
-- 2. Same for companies: lookup by lower(trim(name)) globally before insert.
-- 3. Admin drive-edit endpoint: single `UPDATE ... WHERE id = :id` instead
--    of `.in('id', driveIds)` batch update.
-- 4. Dashboard queries: replace
--      supabase.from('placement_drives').select('*').eq('user_id', user.id)
--    with
--      supabase.from('applications').select('*, placement_drives(*)').eq('user_id', user.id)
-- 5. events and candidate_matches are UNCHANGED -- both stay per-user,
--    keep inserting with user_id as before on both. Only their
--    placement_drive_id values shift to canonical ids after this
--    migration runs (already handled above). Do NOT drop events.user_id
--    from insert code -- gcal_event_id per student still depends on it.
-- 6. If you build the dashboard materialized view discussed separately,
--    that's the right layer to dedupe "same event, N rows" for display --
--    not this migration.