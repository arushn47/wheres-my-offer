-- V26: Body Snippet Auto-Truncation Trigger
-- ==========================================
-- Purpose:
--   V25 incorrectly applied the 500-char limit to every email receipt, including personal
--   NeoPAT emails and college emails that have no canonical body. Those rows rely on
--   emails.body_snippet as their only copy of the message body.
--
-- Fix:
--   1. Keep the full body for non-canonical emails; truncate only receipts backed by
--      canonical_emails.body_text.
--   2. Limit canonicalized receipt snippets to 500 chars.
--   3. Add a BEFORE INSERT OR UPDATE trigger that applies the limit only to canonicalized
--      receipts, leaving personal and non-canonical email bodies intact.
--
-- Safe to re-run (idempotent).

-- 1. Only canonicalized receipts have a separate authoritative full-body copy.
UPDATE public.emails
SET body_snippet = substring(body_snippet FROM 1 FOR 500)
WHERE canonical_email_id IS NOT NULL
  AND body_snippet IS NOT NULL
  AND length(body_snippet) > 500;

-- 2. A full-body snippet is valid when there is no canonical full-body copy.
ALTER TABLE public.emails
  DROP CONSTRAINT IF EXISTS chk_emails_body_snippet_max_500;

ALTER TABLE public.emails
  ADD CONSTRAINT chk_emails_body_snippet_max_500
  CHECK (
    canonical_email_id IS NULL
    OR body_snippet IS NULL
    OR length(body_snippet) <= 500
  );

-- 3. Create (or replace) a BEFORE trigger that auto-truncates body_snippet.
--    This runs BEFORE the constraint check on every INSERT and UPDATE, so the
--    constraint can never be violated regardless of what the application sends.
CREATE OR REPLACE FUNCTION public.trg_emails_truncate_body_snippet()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
BEGIN
  IF NEW.canonical_email_id IS NOT NULL
     AND NEW.body_snippet IS NOT NULL
     AND length(NEW.body_snippet) > 500 THEN
    NEW.body_snippet := substring(NEW.body_snippet FROM 1 FOR 500);
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS trg_emails_truncate_body_snippet ON public.emails;

CREATE TRIGGER trg_emails_truncate_body_snippet
  BEFORE INSERT OR UPDATE ON public.emails
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_emails_truncate_body_snippet();
