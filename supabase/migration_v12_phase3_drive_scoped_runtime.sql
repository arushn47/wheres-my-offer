-- Phase 3: make drive identity authoritative for new operational records.
-- This migration is intentionally not executed automatically.
-- Existing company-only applications remain legacy records.

BEGIN;

-- SAFETY CONTRACT
-- This migration must be run only after the following preflight queries return
-- zero rows. It intentionally raises instead of dropping constraints when
-- existing data cannot satisfy the new identity model.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.applications
    WHERE placement_drive_id IS NOT NULL
    GROUP BY user_id, placement_drive_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Phase 3 blocked: duplicate drive-owned applications exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.applications
    WHERE placement_drive_id IS NULL
    GROUP BY user_id, company_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Phase 3 blocked: duplicate legacy applications exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.applications a
    JOIN public.placement_drives d ON d.id = a.placement_drive_id
    WHERE a.placement_drive_id IS NOT NULL
      AND (a.user_id <> d.user_id OR a.company_id <> d.company_id)
  ) THEN
    RAISE EXCEPTION 'Phase 3 blocked: application drive/company ownership mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.candidate_matches
    WHERE placement_drive_id IS NOT NULL
    GROUP BY user_id, email_id, placement_drive_id, neo_id, match_type
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Phase 3 blocked: duplicate drive-owned candidate matches exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.candidate_matches
    WHERE placement_drive_id IS NULL
    GROUP BY user_id, email_id, neo_id, match_type
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Phase 3 blocked: duplicate legacy candidate matches exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.events
    WHERE placement_drive_id IS NOT NULL AND start_time IS NOT NULL
    GROUP BY user_id, placement_drive_id, event_type, start_time
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Phase 3 blocked: duplicate drive-owned events exist';
  END IF;
END $$;

ALTER TABLE public.applications
  ADD COLUMN IF NOT EXISTS identity_scope TEXT
  CHECK (identity_scope IN ('drive', 'legacy_company'));

-- Classifying the existing key shape is not a business-data backfill: rows with
-- a drive key are already drive-owned, while null-drive rows remain legacy.
UPDATE public.applications
SET identity_scope = CASE
  WHEN placement_drive_id IS NULL THEN 'legacy_company'
  ELSE 'drive'
END
WHERE identity_scope IS NULL;

ALTER TABLE public.applications
  ALTER COLUMN identity_scope SET DEFAULT 'legacy_company',
  ALTER COLUMN identity_scope SET NOT NULL;

DROP INDEX IF EXISTS public.idx_applications_user_drive;
ALTER TABLE public.applications
  DROP CONSTRAINT IF EXISTS applications_user_company_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_user_drive
  ON public.applications (user_id, placement_drive_id)
  WHERE placement_drive_id IS NOT NULL AND identity_scope = 'drive';

CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_user_legacy_company
  ON public.applications (user_id, company_id)
  WHERE placement_drive_id IS NULL AND identity_scope = 'legacy_company';

ALTER TABLE public.applications
  ADD CONSTRAINT applications_identity_scope_consistency
  CHECK (
    (identity_scope = 'drive' AND placement_drive_id IS NOT NULL)
    OR (identity_scope = 'legacy_company' AND placement_drive_id IS NULL)
  );

ALTER TABLE public.candidate_matches
  DROP CONSTRAINT IF EXISTS candidate_matches_logical_identity_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_matches_drive_identity
  ON public.candidate_matches (user_id, email_id, placement_drive_id, neo_id, match_type)
  WHERE placement_drive_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_matches_legacy_identity
  ON public.candidate_matches (user_id, email_id, neo_id, match_type)
  WHERE placement_drive_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_events_user_drive_type_date
  ON public.events (user_id, placement_drive_id, event_type, start_time)
  WHERE placement_drive_id IS NOT NULL;

-- Database-level protection against concurrent duplicate drive events. Event
-- type normalization remains an application concern for now; this protects
-- exact event identities without touching legacy rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_drive_identity
  ON public.events (user_id, placement_drive_id, event_type, start_time)
  WHERE placement_drive_id IS NOT NULL AND start_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_candidate_matches_user_drive
  ON public.candidate_matches (user_id, placement_drive_id, email_id)
  WHERE placement_drive_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_user_drive
  ON public.notifications (user_id, placement_drive_id, type)
  WHERE placement_drive_id IS NOT NULL;

COMMIT;
