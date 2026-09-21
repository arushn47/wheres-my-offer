-- ============================================
-- Migration v9: Unique Index on Drive Number per User
-- ============================================
-- Enforces that a single user cannot have multiple company records for the same drive number.
-- If concurrent syncs or race conditions attempt to insert a duplicate, PostgreSQL rejects with 23505.

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_user_drive_unique 
ON public.companies (user_id, drive_number) 
WHERE drive_number IS NOT NULL;
