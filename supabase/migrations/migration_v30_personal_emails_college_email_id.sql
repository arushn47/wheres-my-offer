-- ============================================================================
-- MIGRATION v30: Add college_email_id to personal_emails
-- ============================================================================
-- 1. Adds college_email_id to public.personal_emails referencing public.college_emails(id)
-- 2. Backfills college_email_id from canonical_email_id
-- 3. Adds index on college_email_id
-- 4. Creates sync trigger between college_email_id and canonical_email_id
-- 5. Re-creates public.emails view to expose college_email_id
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. Add column if not exists
ALTER TABLE public.personal_emails 
  ADD COLUMN IF NOT EXISTS college_email_id UUID REFERENCES public.college_emails(id) ON DELETE SET NULL;

-- 2. Backfill existing references
UPDATE public.personal_emails 
SET college_email_id = canonical_email_id 
WHERE college_email_id IS NULL AND canonical_email_id IS NOT NULL;

-- 3. Create index for fast lookups and joins
CREATE INDEX IF NOT EXISTS idx_personal_emails_college_email_id 
  ON public.personal_emails (college_email_id) 
  WHERE college_email_id IS NOT NULL;

-- 4. Bi-directional sync trigger between college_email_id and canonical_email_id
CREATE OR REPLACE FUNCTION sync_personal_emails_college_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.college_email_id IS NOT NULL AND NEW.canonical_email_id IS NULL THEN
    NEW.canonical_email_id := NEW.college_email_id;
  ELSIF NEW.canonical_email_id IS NOT NULL AND NEW.college_email_id IS NULL THEN
    NEW.college_email_id := NEW.canonical_email_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_personal_emails_college_id ON public.personal_emails;
CREATE TRIGGER trg_sync_personal_emails_college_id
  BEFORE INSERT OR UPDATE ON public.personal_emails
  FOR EACH ROW
  EXECUTE FUNCTION sync_personal_emails_college_id();

-- 5. Refresh backwards-compatible view
CREATE OR REPLACE VIEW public.emails AS SELECT * FROM public.personal_emails;

COMMIT;
