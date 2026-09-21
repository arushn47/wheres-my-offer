-- Phase 1 follow-up: atomic sync leases and tenant/identity invariants.
-- This migration is forward-only and must be reviewed/executed separately.

BEGIN;

ALTER TABLE public.sync_state
  ADD COLUMN IF NOT EXISTS run_id UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.acquire_sync_lease(
  p_user_id UUID,
  p_run_id UUID,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.sync_state (
    user_id, run_id, is_syncing, phase, updated_at, lease_expires_at
  )
  VALUES (
    p_user_id, p_run_id, TRUE, 'initializing', NOW(),
    NOW() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 900)))
  )
  ON CONFLICT (user_id) DO UPDATE
  SET run_id = EXCLUDED.run_id,
      is_syncing = TRUE,
      phase = 'initializing',
      updated_at = NOW(),
      lease_expires_at = EXCLUDED.lease_expires_at
  WHERE public.sync_state.is_syncing IS NOT TRUE
     OR public.sync_state.lease_expires_at <= NOW()
     OR (
       public.sync_state.lease_expires_at IS NULL
       AND public.sync_state.updated_at <= NOW() - INTERVAL '90 seconds'
     )
  RETURNING TRUE;
$$;

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
  RETURNING TRUE;
$$;

CREATE OR REPLACE FUNCTION public.release_sync_lease(
  p_user_id UUID,
  p_run_id UUID,
  p_phase TEXT,
  p_last_error TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SET search_path = public, pg_temp
AS $$
  UPDATE public.sync_state
  SET is_syncing = FALSE,
      phase = p_phase,
      last_error = p_last_error,
      completed_at = CASE WHEN p_phase IN ('complete', 'error') THEN NOW() ELSE completed_at END,
      updated_at = NOW(),
      lease_expires_at = NULL
  WHERE user_id = p_user_id
    AND run_id = p_run_id
    AND is_syncing = TRUE
  RETURNING TRUE;
$$;

CREATE OR REPLACE FUNCTION public.update_sync_page_checkpoint(
  p_user_id UUID,
  p_run_id UUID,
  p_page_id UUID,
  p_next_offset INTEGER,
  p_status TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SET search_path = public, pg_temp
AS $$
  UPDATE public.sync_pages AS page
  SET next_offset = p_next_offset,
      status = COALESCE(p_status, page.status),
      updated_at = NOW()
  WHERE page.id = p_page_id
    AND page.user_id = p_user_id
    AND EXISTS (
      SELECT 1
      FROM public.sync_state AS state
      WHERE state.user_id = p_user_id
        AND state.run_id = p_run_id
        AND state.is_syncing = TRUE
        AND state.lease_expires_at > NOW()
    )
  RETURNING TRUE;
$$;

REVOKE ALL ON FUNCTION public.acquire_sync_lease(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_sync_lease(UUID, UUID, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_sync_lease(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_sync_page_checkpoint(UUID, UUID, UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_sync_lease(UUID, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_sync_lease(UUID, UUID, JSONB, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_sync_lease(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_sync_page_checkpoint(UUID, UUID, UUID, INTEGER, TEXT) TO service_role;

-- Prevent duplicate logical evidence when email_id is NULL while preserving
-- legitimate historical rows. The migration intentionally fails if duplicates
-- already exist and therefore requires review rather than deleting data.
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_matches_identity_nulls_not_distinct
  ON public.candidate_matches (user_id, email_id, neo_id, match_type) NULLS NOT DISTINCT;

-- Parent keys used by tenant-aware foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gmail_accounts_user_id ON public.gmail_accounts(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_user_id ON public.companies(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_placement_drives_user_id ON public.placement_drives(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_user_id ON public.applications(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_user_id ON public.emails(user_id, id);

-- New writes are tenant-consistent immediately. Existing violations remain
-- visible through NOT VALID constraints and can be validated separately.
-- PostgreSQL has no ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS. Reuse an
-- exact existing constraint; fail rather than silently accepting a conflicting
-- same-named constraint.
DO $$
DECLARE
  expected RECORD;
  existing_definition TEXT;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('public.placement_drives'::regclass, 'placement_drives_company_tenant_fkey', 'FOREIGN KEY (user_id, company_id) REFERENCES public.companies(user_id, id) NOT VALID'),
      ('public.applications'::regclass, 'applications_drive_tenant_fkey', 'FOREIGN KEY (user_id, placement_drive_id) REFERENCES public.placement_drives(user_id, id) NOT VALID'),
      ('public.emails'::regclass, 'emails_account_tenant_fkey', 'FOREIGN KEY (user_id, gmail_account_id) REFERENCES public.gmail_accounts(user_id, id) NOT VALID'),
      ('public.email_drive_links'::regclass, 'email_drive_links_email_tenant_fkey', 'FOREIGN KEY (user_id, email_id) REFERENCES public.emails(user_id, id) NOT VALID'),
      ('public.email_drive_links'::regclass, 'email_drive_links_drive_tenant_fkey', 'FOREIGN KEY (user_id, placement_drive_id) REFERENCES public.placement_drives(user_id, id) NOT VALID'),
      ('public.candidate_matches'::regclass, 'candidate_matches_email_tenant_fkey', 'FOREIGN KEY (user_id, email_id) REFERENCES public.emails(user_id, id) NOT VALID'),
      ('public.candidate_matches'::regclass, 'candidate_matches_drive_tenant_fkey', 'FOREIGN KEY (user_id, placement_drive_id) REFERENCES public.placement_drives(user_id, id) NOT VALID'),
      ('public.events'::regclass, 'events_drive_tenant_fkey', 'FOREIGN KEY (user_id, placement_drive_id) REFERENCES public.placement_drives(user_id, id) NOT VALID')
    ) AS definitions(table_ref, constraint_name, constraint_definition)
  LOOP
    SELECT pg_get_constraintdef(c.oid, false)
    INTO existing_definition
    FROM pg_constraint c
    WHERE c.conrelid = expected.table_ref
      AND c.conname = expected.constraint_name;

    IF existing_definition IS NULL THEN
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I %s',
        expected.table_ref,
        expected.constraint_name,
        expected.constraint_definition
      );
    ELSIF replace(existing_definition, ' NOT VALID', '') <> replace(expected.constraint_definition, ' NOT VALID', '') THEN
      RAISE EXCEPTION 'Existing constraint %.% has incompatible definition: %',
        expected.table_ref, expected.constraint_name, existing_definition;
    END IF;
  END LOOP;
END $$;

COMMIT;
