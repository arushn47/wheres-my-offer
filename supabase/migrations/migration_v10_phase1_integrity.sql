-- ============================================
-- Migration v10: Phase 1 integrity constraints
-- ============================================
-- Prerequisite: run migration_v10_phase1_preflight.sql first.
-- This migration intentionally performs no DELETE, UPDATE, or merge.
-- It will fail rather than alter existing duplicate data.

BEGIN;

-- Applied-list evidence is an intentional match type used by the live
-- status engine and reprocess logic. Preserve that semantic distinction.
DO $$
DECLARE
  existing_constraint_name TEXT;
BEGIN
  SELECT c.conname
  INTO existing_constraint_name
  FROM pg_constraint c
  WHERE c.conrelid = 'public.candidate_matches'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%match_type%';

  IF existing_constraint_name IS NULL THEN
    RAISE EXCEPTION 'Expected candidate_matches match_type check constraint was not found';
  END IF;

  IF existing_constraint_name <> 'candidate_matches_match_type_check' THEN
    RAISE EXCEPTION 'Unexpected candidate_matches match_type constraint name: %', existing_constraint_name;
  END IF;
END $$;

ALTER TABLE public.candidate_matches
  DROP CONSTRAINT candidate_matches_match_type_check;

ALTER TABLE public.candidate_matches
  ADD CONSTRAINT candidate_matches_match_type_check
  CHECK (match_type IN (
    'xlsx_cell',
    'xlsx_applied_list',
    'pdf_text',
    'docx_text',
    'email_body',
    'email_subject'
  ));

-- email_id remains nullable for legacy/future evidence without a source
-- email. PostgreSQL permits multiple NULL values in this unique constraint.
ALTER TABLE public.candidate_matches
  ADD CONSTRAINT candidate_matches_logical_identity_unique
  UNIQUE (user_id, email_id, neo_id, match_type);

COMMIT;
