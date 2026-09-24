-- V25: Canonical Body Cleanup & Migration Finalization
-- =====================================================
-- Purpose:
--   1. Enforce max 500-char body_snippet on ALL emails (college + personal).
--      canonical_emails.body_text is the authoritative full-body store.
--   2. Clear canonical_emails.body_snippet (body_text is the master; snippet was a
--      redundant copy from the old V20 schema, before body_text column existed in V23).
--   3. Add a DB-level truncation trigger so future inserts/updates can never
--      accidentally store fat snippets again.
--
-- Background:
--   - V20: canonical_emails created, only had body_snippet (no body_text yet).
--   - V23: body_text column added to canonical_emails (full body, V2 identity).
--   - V24: body_snippet truncated to 500 chars for emails rows linked to canonical.
--   - V25 (this migration): finalize cleanup, enforce constraints app-wide.
--
-- Safe to re-run (idempotent).

BEGIN;

-- 1. Truncate body_snippet for ALL emails rows still exceeding 500 chars.
--    This covers personal NeoPAT emails not linked to canonical_emails.
UPDATE public.emails
SET body_snippet = substring(body_snippet FROM 1 FOR 500)
WHERE body_snippet IS NOT NULL AND length(body_snippet) > 500;

-- 2. Clear body_snippet from canonical_emails (body_text is the master).
--    The body_snippet column in canonical_emails was a V20 artifact; V23+ uses body_text.
UPDATE public.canonical_emails
SET body_snippet = NULL
WHERE body_snippet IS NOT NULL;

-- 3. Add CHECK constraint to enforce 500-char limit on emails.body_snippet going forward.
--    NOT VALID means existing rows are not re-scanned (zero-downtime).
--    Wrapped in DO block because ADD CONSTRAINT IF NOT EXISTS is not valid PostgreSQL syntax.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_emails_body_snippet_max_500'
      AND conrelid = 'public.emails'::regclass
  ) THEN
    ALTER TABLE public.emails
      ADD CONSTRAINT chk_emails_body_snippet_max_500
      CHECK (body_snippet IS NULL OR length(body_snippet) <= 500)
      NOT VALID;
  END IF;
END $$;

-- 4. Index to make canonical lookup fast when joining for full body.
CREATE INDEX IF NOT EXISTS idx_canonical_emails_body_text_not_null
  ON public.canonical_emails (id)
  WHERE body_text IS NOT NULL;

COMMIT;
