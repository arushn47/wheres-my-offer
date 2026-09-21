-- Phase 4 Cleanup: Dropping Legacy Columns and Enforcing Drive Scoped Runtime

-- 1. applications table
ALTER TABLE public.applications DROP COLUMN IF EXISTS company_id CASCADE;
ALTER TABLE public.applications DROP COLUMN IF EXISTS identity_scope CASCADE;
-- Since "delete whatever you want" was provided and we're enforcing the new architecture:
-- We'll delete orphan applications before setting NOT NULL to avoid errors.
DELETE FROM public.applications WHERE placement_drive_id IS NULL;
ALTER TABLE public.applications ALTER COLUMN placement_drive_id SET NOT NULL;

-- 2. emails table
ALTER TABLE public.emails DROP COLUMN IF EXISTS company_id CASCADE;

-- 3. candidate_matches table
ALTER TABLE public.candidate_matches DROP COLUMN IF EXISTS application_id CASCADE;
DELETE FROM public.candidate_matches WHERE placement_drive_id IS NULL;
ALTER TABLE public.candidate_matches ALTER COLUMN placement_drive_id SET NOT NULL;

-- 4. events table
ALTER TABLE public.events DROP COLUMN IF EXISTS company_id CASCADE;
ALTER TABLE public.events DROP COLUMN IF EXISTS application_id CASCADE;
DELETE FROM public.events WHERE placement_drive_id IS NULL;
ALTER TABLE public.events ALTER COLUMN placement_drive_id SET NOT NULL;

-- 5. notifications table
ALTER TABLE public.notifications DROP COLUMN IF EXISTS company_id CASCADE;
ALTER TABLE public.notifications DROP COLUMN IF EXISTS application_id CASCADE;
-- (Note: notifications.placement_drive_id remains nullable because some notifications are system-wide)

-- 6. companies table
ALTER TABLE public.companies DROP COLUMN IF EXISTS drive_number CASCADE;
ALTER TABLE public.companies DROP COLUMN IF EXISTS drive_name CASCADE;
