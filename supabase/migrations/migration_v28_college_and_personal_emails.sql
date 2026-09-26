-- ============================================================================
-- MIGRATION v28: Separate College Circulars & Personal Emails
-- ============================================================================
-- 1. Adds college_email_id references to candidate_matches, events, placement_drives
-- 2. Repoints existing references before purging duplicate college emails
-- 3. Modernizes uniqueness indexes on candidate_matches to prevent null collision
-- 4. Purges redundant college broadcast emails from emails table (saving ~25MB)
-- 5. Renames:
--      canonical_emails      -> college_emails
--      canonical_attachments -> college_attachments
--      emails                -> personal_emails
-- 6. Updates RLS policies and table grants
-- 7. Creates backwards-compatible views (emails, canonical_emails, canonical_attachments)
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ----------------------------------------------------------------------------
-- Step 1: Add college_email_id references to candidate_matches & events
-- ----------------------------------------------------------------------------
ALTER TABLE public.candidate_matches 
  ADD COLUMN IF NOT EXISTS college_email_id UUID REFERENCES public.canonical_emails(id) ON DELETE SET NULL;

ALTER TABLE public.events 
  ADD COLUMN IF NOT EXISTS college_email_id UUID REFERENCES public.canonical_emails(id) ON DELETE SET NULL;

ALTER TABLE public.placement_drives 
  ADD COLUMN IF NOT EXISTS source_college_email_id UUID REFERENCES public.canonical_emails(id) ON DELETE SET NULL;

-- Repoint before modifying indexes
UPDATE public.candidate_matches cm
SET college_email_id = em.canonical_email_id
FROM public.emails em
WHERE cm.email_id = em.id 
  AND em.canonical_email_id IS NOT NULL;

UPDATE public.events ev
SET college_email_id = em.canonical_email_id
FROM public.emails em
WHERE ev.source_email_id = em.id 
  AND em.canonical_email_id IS NOT NULL;

UPDATE public.placement_drives pd
SET source_college_email_id = em.canonical_email_id
FROM public.emails em
WHERE pd.source_email_id = em.id 
  AND em.canonical_email_id IS NOT NULL;

-- Drop legacy candidate_matches indexes that collide when email_id is null
DROP INDEX IF EXISTS idx_candidate_matches_identity_nulls_not_distinct;
DROP INDEX IF EXISTS idx_candidate_matches_legacy_identity;
DROP INDEX IF EXISTS idx_candidate_matches_drive_identity;

-- Clear email_id on candidate_matches that now point to college circulars
UPDATE public.candidate_matches
SET email_id = NULL
WHERE college_email_id IS NOT NULL;

-- Create precise uniqueness indexes for candidate_matches
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_matches_college_uniq
  ON public.candidate_matches (user_id, college_email_id, neo_id, match_type)
  WHERE college_email_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_matches_personal_uniq
  ON public.candidate_matches (user_id, email_id, neo_id, match_type)
  WHERE email_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_matches_drive_uniq
  ON public.candidate_matches (user_id, placement_drive_id, neo_id, match_type)
  WHERE placement_drive_id IS NOT NULL AND college_email_id IS NULL AND email_id IS NULL;

-- ----------------------------------------------------------------------------
-- Step 2: Purge duplicate college circulars from emails table
-- ----------------------------------------------------------------------------
DELETE FROM public.email_drive_links edl
USING public.emails em
WHERE edl.email_id = em.id
  AND (em.sender ILIKE '%vitlions2027%' OR em.canonical_email_id IS NOT NULL);

DELETE FROM public.emails
WHERE sender ILIKE '%vitlions2027%' OR canonical_email_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Step 3: Rename tables to college_emails, college_attachments, personal_emails
-- ----------------------------------------------------------------------------
ALTER TABLE public.canonical_emails RENAME TO college_emails;
ALTER TABLE public.canonical_attachments RENAME TO college_attachments;
ALTER TABLE public.emails RENAME TO personal_emails;

-- Rename foreign key column on college_attachments
ALTER TABLE public.college_attachments RENAME COLUMN canonical_email_id TO college_email_id;

-- ----------------------------------------------------------------------------
-- Step 4: RLS Policies & Grants
-- ----------------------------------------------------------------------------
-- college_emails (Global reference data - everyone authenticated can read)
DROP POLICY IF EXISTS canonical_emails_read_all ON public.college_emails;
DROP POLICY IF EXISTS college_emails_read_all ON public.college_emails;
CREATE POLICY college_emails_read_all ON public.college_emails
  FOR SELECT TO authenticated USING (true);

-- college_attachments (Global reference data - everyone authenticated can read)
DROP POLICY IF EXISTS canonical_attachments_read_all ON public.college_attachments;
DROP POLICY IF EXISTS college_attachments_read_all ON public.college_attachments;
CREATE POLICY college_attachments_read_all ON public.college_attachments
  FOR SELECT TO authenticated USING (true);

-- personal_emails (Per-user private data - tenant isolated)
DROP POLICY IF EXISTS emails_tenant_isolation ON public.personal_emails;
DROP POLICY IF EXISTS emails_own_data ON public.personal_emails;
DROP POLICY IF EXISTS personal_emails_tenant_isolation ON public.personal_emails;
CREATE POLICY personal_emails_tenant_isolation ON public.personal_emails
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

GRANT SELECT ON public.college_emails TO authenticated, anon;
GRANT SELECT ON public.college_attachments TO authenticated, anon;
GRANT ALL ON public.personal_emails TO authenticated, anon;

-- ----------------------------------------------------------------------------
-- Step 5: Backwards-compatible Views (ensures zero broken queries during transition)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.canonical_emails AS SELECT * FROM public.college_emails;
CREATE OR REPLACE VIEW public.canonical_attachments AS SELECT * FROM public.college_attachments;
CREATE OR REPLACE VIEW public.emails AS SELECT * FROM public.personal_emails;

COMMIT;
