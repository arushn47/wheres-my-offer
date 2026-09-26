-- ============================================================================
-- MIGRATION v31: Add excluded_email_ids to placement_drives
-- ============================================================================
-- Tracks email IDs and college circular IDs that have been explicitly unlinked
-- from a specific placement drive by an admin, ensuring they are permanently
-- excluded from timeline queries, admin email queries, and reprocess sync runs.
-- ============================================================================

ALTER TABLE public.placement_drives
  ADD COLUMN IF NOT EXISTS excluded_email_ids TEXT[] DEFAULT '{}'::TEXT[];

-- Create an index to support fast array containment checks if needed
CREATE INDEX IF NOT EXISTS idx_placement_drives_excluded_emails
  ON public.placement_drives USING GIN (excluded_email_ids);
