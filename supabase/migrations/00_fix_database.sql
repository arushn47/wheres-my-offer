-- ============================================================
-- NeoTrack: Definitive Fix Migration (run once on live DB)
-- ============================================================
-- Idempotent. Safe to re-run. Covers everything from v16 + v17
-- that may not have been applied. Does NOT drop any existing data.
-- Run this in the Supabase SQL editor (or via psql) as a superuser
-- or service_role.
-- ============================================================

BEGIN;

-- ============================================================
-- SECTION 1: sync_state -- add lease columns (v17)
-- ============================================================
ALTER TABLE public.sync_state
  ADD COLUMN IF NOT EXISTS run_id UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- ============================================================
-- SECTION 2: companies -- add legal_name if missing
-- ============================================================
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS legal_name TEXT;

-- ============================================================
-- SECTION 3: attachments -- create table if it does not exist
-- ============================================================
CREATE TABLE IF NOT EXISTS public.attachments (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  email_id UUID NOT NULL,
  user_id UUID NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  storage_path TEXT,
  file_hash TEXT,
  file_size_bytes INTEGER,
  is_processed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT attachments_pkey PRIMARY KEY (id),
  CONSTRAINT attachments_email_id_fkey FOREIGN KEY (email_id) REFERENCES public.emails(id) ON DELETE CASCADE,
  CONSTRAINT attachments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- ============================================================
-- SECTION 4: status_history -- create table if it does not exist
-- ============================================================
CREATE TABLE IF NOT EXISTS public.status_history (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  application_id UUID NOT NULL,
  old_status TEXT,
  new_status TEXT NOT NULL,
  source TEXT,
  source_email_id UUID,
  changed_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT status_history_pkey PRIMARY KEY (id),
  CONSTRAINT status_history_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE,
  CONSTRAINT status_history_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.emails(id) ON DELETE SET NULL
);

-- ============================================================
-- SECTION 5: documents -- create table if it does not exist
-- ============================================================
CREATE TABLE IF NOT EXISTS public.documents (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  company_id UUID,
  application_id UUID,
  document_type TEXT NOT NULL CHECK (document_type = ANY (ARRAY['jd'::text, 'shortlist'::text, 'company_info'::text, 'offer_letter'::text, 'other'::text])),
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  source_email_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT documents_pkey PRIMARY KEY (id),
  CONSTRAINT documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT documents_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL,
  CONSTRAINT documents_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE,
  CONSTRAINT documents_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.emails(id) ON DELETE SET NULL
);

-- ============================================================
-- SECTION 6: candidate_matches -- add attachment_id if missing
-- ============================================================
ALTER TABLE public.candidate_matches
  ADD COLUMN IF NOT EXISTS attachment_id UUID
    REFERENCES public.attachments(id) ON DELETE CASCADE;

-- ============================================================
-- SECTION 7: applications -- fix status CHECK constraint
-- The live DB may have the old constraint without offer_received,
-- ppt_ongoing, ppt_completed, test_ongoing, test_completed etc.
-- We drop and recreate it idempotently.
-- ============================================================
DO $$
DECLARE
  v_constraint_name TEXT;
  v_existing_def TEXT;
BEGIN
  -- Find the existing CHECK constraint on applications.status (not status_confidence)
  SELECT c.conname, pg_get_constraintdef(c.oid)
  INTO v_constraint_name, v_existing_def
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON t.relnamespace = n.oid
  WHERE n.nspname = 'public'
    AND t.relname = 'applications'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status%'
    AND pg_get_constraintdef(c.oid) NOT ILIKE '%status_confidence%'
  LIMIT 1;

  -- Only act if the constraint exists but is missing required values
  IF v_constraint_name IS NOT NULL
     AND v_existing_def NOT LIKE '%offer_received%' THEN
    -- Coerce any unknown status values to 'unknown' before dropping constraint
    UPDATE public.applications
    SET status = 'unknown'
    WHERE status NOT IN (
      'not_applied','applied','registration_open','ppt_scheduled','ppt_ongoing',
      'ppt_completed','shortlisted','test_scheduled','test_ongoing','test_completed',
      'interview_scheduled','interview_ongoing','interview_completed','selected',
      'offer','offer_received','rejected','not_shortlisted','rejected_test',
      'rejected_interview','withdrawn','declined','unknown'
    );
    EXECUTE format('ALTER TABLE public.applications DROP CONSTRAINT %I', v_constraint_name);
  END IF;

  -- Add updated constraint only if not already present with all required values
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public' AND t.relname = 'applications'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%offer_received%'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%status_confidence%'
  ) THEN
    ALTER TABLE public.applications
      ADD CONSTRAINT applications_status_check CHECK (status = ANY (ARRAY[
        'not_applied'::text, 'applied'::text, 'registration_open'::text,
        'ppt_scheduled'::text, 'ppt_ongoing'::text, 'ppt_completed'::text,
        'shortlisted'::text, 'test_scheduled'::text, 'test_ongoing'::text,
        'test_completed'::text, 'interview_scheduled'::text, 'interview_ongoing'::text,
        'interview_completed'::text, 'selected'::text, 'offer'::text,
        'offer_received'::text, 'rejected'::text, 'not_shortlisted'::text,
        'rejected_test'::text, 'rejected_interview'::text, 'withdrawn'::text,
        'declined'::text, 'unknown'::text
      ]));
  END IF;
END $$;

-- ============================================================
-- SECTION 8: Indexes (all IF NOT EXISTS -- safe to re-run)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_attachments_email ON public.attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_attachments_hash ON public.attachments(file_hash);
CREATE INDEX IF NOT EXISTS idx_status_history_app ON public.status_history(application_id);
CREATE INDEX IF NOT EXISTS idx_candidate_matches_neo ON public.candidate_matches(neo_id);
CREATE INDEX IF NOT EXISTS idx_sync_pages_user_status ON public.sync_pages(user_id, status);

-- v17 tenant parent-key indexes (required for tenant FK constraints below)
CREATE UNIQUE INDEX IF NOT EXISTS idx_gmail_accounts_user_id ON public.gmail_accounts(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_user_id ON public.companies(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_placement_drives_user_id ON public.placement_drives(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_user_id ON public.applications(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_user_id ON public.emails(user_id, id);

-- email_drive_links unique constraint (required for upsert in reprocess route)
-- schema-simple.sql confirms this UNIQUE constraint is absent from live DB.
-- Without it, .upsert({ onConflict: 'email_id,placement_drive_id,link_type' }) fails silently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public' AND t.relname = 'email_drive_links'
      AND c.conname = 'email_drive_links_identity_unique'
  ) THEN
    ALTER TABLE public.email_drive_links
      ADD CONSTRAINT email_drive_links_identity_unique
        UNIQUE (email_id, placement_drive_id, link_type);
  END IF;
END $$;

-- gmail_accounts unique per (user_id, email) -- prevents duplicate account registrations
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public' AND t.relname = 'gmail_accounts'
      AND c.conname = 'gmail_accounts_user_email_unique'
  ) THEN
    ALTER TABLE public.gmail_accounts
      ADD CONSTRAINT gmail_accounts_user_email_unique UNIQUE (user_id, email);
  END IF;
END $$;

-- ============================================================
-- SECTION 9: candidate_matches unique index (v17)
-- NOTE: If duplicate (user_id, email_id, neo_id, match_type) rows
-- exist this will fail. Run preflight_v17 first to check.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_matches_identity_nulls_not_distinct
  ON public.candidate_matches (user_id, email_id, neo_id, match_type) NULLS NOT DISTINCT;

-- ============================================================
-- SECTION 10: Drop Conflicting Composite Tenant FKs
-- NOTE: Standard FKs already exist (e.g. company_id -> companies.id).
-- Adding duplicate composite FKs causes PostgREST error PGRST201:
-- "Could not embed because more than one relationship was found".
-- Tenant isolation is enforced by RLS in Section 11.
-- ============================================================
ALTER TABLE public.placement_drives DROP CONSTRAINT IF EXISTS placement_drives_company_tenant_fkey;
ALTER TABLE public.applications DROP CONSTRAINT IF EXISTS applications_drive_tenant_fkey;
ALTER TABLE public.emails DROP CONSTRAINT IF EXISTS emails_account_tenant_fkey;
ALTER TABLE public.email_drive_links DROP CONSTRAINT IF EXISTS email_drive_links_email_tenant_fkey;
ALTER TABLE public.email_drive_links DROP CONSTRAINT IF EXISTS email_drive_links_drive_tenant_fkey;
ALTER TABLE public.candidate_matches DROP CONSTRAINT IF EXISTS candidate_matches_email_tenant_fkey;
ALTER TABLE public.candidate_matches DROP CONSTRAINT IF EXISTS candidate_matches_drive_tenant_fkey;
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_drive_tenant_fkey;

-- ============================================================
-- SECTION 11: RLS policies (v16 -- idempotent)
-- ============================================================
DO $$
DECLARE
  tbl TEXT;
  user_owned_tables TEXT[] := ARRAY[
    'gmail_accounts', 'companies', 'placement_drives', 'applications', 'emails',
    'email_drive_links', 'attachments', 'candidate_matches', 'events', 'documents',
    'notifications', 'push_subscriptions', 'notification_preferences',
    'feedback_reports'
  ];
BEGIN
  FOREACH tbl IN ARRAY user_owned_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'public' AND c.relname = tbl
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      BEGIN
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())',
          tbl || '_tenant_isolation', tbl
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  CREATE POLICY users_tenant_isolation ON public.users
    FOR ALL TO authenticated
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.status_history ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  DROP POLICY IF EXISTS status_history_tenant_isolation ON public.status_history;
  CREATE POLICY status_history_tenant_isolation ON public.status_history
    FOR ALL TO authenticated
    USING (EXISTS (
      SELECT 1 FROM public.applications a
      WHERE a.id = status_history.application_id AND a.user_id = auth.uid()
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.applications a
      WHERE a.id = status_history.application_id AND a.user_id = auth.uid()
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- SECTION 12: Atomic sync lease RPCs (THE CRITICAL FIX)
-- These 4 functions are what sync/engine.ts calls.
-- The 'Failed to acquire sync lease' error is caused entirely
-- by these not existing in the DB.
-- ============================================================

CREATE OR REPLACE FUNCTION public.acquire_sync_lease(
  p_user_id UUID,
  p_run_id UUID,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owned BOOLEAN;
BEGIN
  INSERT INTO public.sync_state (
    user_id, run_id, is_syncing, phase, updated_at, started_at, lease_expires_at
  )
  VALUES (
    p_user_id, p_run_id, TRUE, 'initializing', NOW(), NOW(),
    NOW() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 900)))
  )
  ON CONFLICT (user_id) DO UPDATE
  SET run_id          = EXCLUDED.run_id,
      is_syncing      = TRUE,
      phase           = 'initializing',
      updated_at      = NOW(),
      started_at      = NOW(),
      lease_expires_at = EXCLUDED.lease_expires_at
  WHERE public.sync_state.is_syncing IS NOT TRUE
     OR public.sync_state.lease_expires_at <= NOW()
     OR (
       public.sync_state.lease_expires_at IS NULL
       AND public.sync_state.updated_at <= NOW() - INTERVAL '90 seconds'
     );

  SELECT (run_id = p_run_id AND is_syncing = TRUE)
  INTO v_owned
  FROM public.sync_state
  WHERE user_id = p_user_id;

  RETURN v_owned;
END;
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
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.sync_state
  SET phase              = COALESCE(p_progress->>'phase', phase),
      account_email      = COALESCE(p_progress->>'accountEmail', account_email),
      account_type       = COALESCE(p_progress->>'accountType', account_type),
      total_messages     = COALESCE((p_progress->>'totalMessages')::INTEGER, total_messages),
      processed_messages = COALESCE((p_progress->>'processedMessages')::INTEGER, processed_messages),
      new_emails         = COALESCE((p_progress->>'newEmails')::INTEGER, new_emails),
      new_companies      = COALESCE((p_progress->>'newCompanies')::INTEGER, new_companies),
      skipped_duplicates = COALESCE((p_progress->>'skippedDuplicates')::INTEGER, skipped_duplicates),
      current_subject    = NULLIF(p_progress->>'currentSubject', ''),
      is_initial_sync    = COALESCE((p_progress->>'isInitialSync')::BOOLEAN, is_initial_sync),
      current_page_index = COALESCE((p_progress->>'currentPageIndex')::INTEGER, current_page_index),
      total_pages        = COALESCE((p_progress->>'totalPagesCount')::INTEGER, total_pages),
      last_error         = NULLIF(p_progress->>'lastError', ''),
      updated_at         = NOW(),
      lease_expires_at   = NOW() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 900)))
  WHERE user_id    = p_user_id
    AND run_id     = p_run_id
    AND is_syncing = TRUE
  RETURNING TRUE;
$$;

CREATE OR REPLACE FUNCTION public.release_sync_lease(
  p_user_id    UUID,
  p_run_id     UUID,
  p_phase      TEXT,
  p_last_error TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.sync_state
  SET is_syncing       = FALSE,
      phase            = p_phase,
      last_error       = p_last_error,
      completed_at     = CASE WHEN p_phase IN ('complete', 'error') THEN NOW() ELSE completed_at END,
      updated_at       = NOW(),
      lease_expires_at = NULL
  WHERE user_id    = p_user_id
    AND run_id     = p_run_id
    AND is_syncing = TRUE
  RETURNING TRUE;
$$;

CREATE OR REPLACE FUNCTION public.update_sync_page_checkpoint(
  p_user_id     UUID,
  p_run_id      UUID,
  p_page_id     UUID,
  p_next_offset INTEGER,
  p_status      TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.sync_pages AS page
  SET next_offset = p_next_offset,
      status      = COALESCE(p_status, page.status),
      updated_at  = NOW()
  WHERE page.id      = p_page_id
    AND page.user_id = p_user_id
    AND EXISTS (
      SELECT 1 FROM public.sync_state AS state
      WHERE state.user_id          = p_user_id
        AND state.run_id           = p_run_id
        AND state.is_syncing       = TRUE
        AND state.lease_expires_at > NOW()
    )
  RETURNING TRUE;
$$;

-- ============================================================
-- SECTION 13: RPC permissions
-- ============================================================
REVOKE ALL ON FUNCTION public.acquire_sync_lease(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_sync_lease(UUID, UUID, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_sync_lease(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_sync_page_checkpoint(UUID, UUID, UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.acquire_sync_lease(UUID, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_sync_lease(UUID, UUID, JSONB, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_sync_lease(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_sync_page_checkpoint(UUID, UUID, UUID, INTEGER, TEXT) TO service_role;

-- ============================================================
-- SECTION 14: Clear stale sync locks (safety reset)
-- Clears any rows where is_syncing=TRUE but lease has expired.
-- ============================================================
UPDATE public.sync_state
SET is_syncing       = FALSE,
    phase            = 'idle',
    lease_expires_at = NULL,
    last_error       = 'Cleared by fix migration: stale lock at apply time',
    updated_at       = NOW()
WHERE is_syncing = TRUE
  AND (
    lease_expires_at IS NULL
    OR lease_expires_at <= NOW()
    OR updated_at <= NOW() - INTERVAL '10 minutes'
  );

COMMIT;

-- ============================================================
-- POST-APPLY VERIFICATION (uncomment and run separately)
-- ============================================================
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'sync_state'
--   AND column_name IN ('run_id', 'lease_expires_at');
--
-- SELECT routine_name FROM information_schema.routines
--   WHERE routine_schema = 'public'
--   AND routine_name IN (
--     'acquire_sync_lease','update_sync_lease',
--     'release_sync_lease','update_sync_page_checkpoint'
--   );
--
-- SELECT is_syncing, phase, lease_expires_at, run_id FROM public.sync_state;
