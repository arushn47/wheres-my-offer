-- ============================================================================
-- MIGRATION v29: Add received_at to college_emails
-- ============================================================================
-- Ensures college broadcast circulars have their actual arrival timestamp from Gmail,
-- rather than database row insertion timestamp (created_at).
-- ============================================================================

ALTER TABLE public.college_emails 
  ADD COLUMN IF NOT EXISTS received_at timestamp with time zone;

-- Default existing rows to created_at temporarily until backfilled from Gmail metadata
UPDATE public.college_emails
SET received_at = created_at
WHERE received_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_college_emails_received_at 
  ON public.college_emails (received_at DESC);
