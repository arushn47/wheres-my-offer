-- ============================================================
-- NeoTrack: Drop Conflicting Composite Tenant Foreign Keys
-- ============================================================
-- WHY THIS IS NEEDED:
-- Adding composite FKs (e.g. (user_id, company_id) REFERENCES companies(user_id, id))
-- when standard FKs already exist (company_id REFERENCES companies(id)) causes
-- PostgREST (Supabase) to throw PGRST201:
-- "Could not embed because more than one relationship was found for 'placement_drives' and 'companies'".
-- This broke all relation joins in the dashboard, making company names display as "Company"
-- and event headers as "Campus Drive".
--
-- Tenant isolation is ALREADY enforced by Row Level Security (RLS) policies.
-- Dropping these duplicate constraints restores PostgREST introspection immediately.
-- ============================================================

ALTER TABLE public.placement_drives DROP CONSTRAINT IF EXISTS placement_drives_company_tenant_fkey;
ALTER TABLE public.applications DROP CONSTRAINT IF EXISTS applications_drive_tenant_fkey;
ALTER TABLE public.emails DROP CONSTRAINT IF EXISTS emails_account_tenant_fkey;
ALTER TABLE public.email_drive_links DROP CONSTRAINT IF EXISTS email_drive_links_email_tenant_fkey;
ALTER TABLE public.email_drive_links DROP CONSTRAINT IF EXISTS email_drive_links_drive_tenant_fkey;
ALTER TABLE public.candidate_matches DROP CONSTRAINT IF EXISTS candidate_matches_email_tenant_fkey;
ALTER TABLE public.candidate_matches DROP CONSTRAINT IF EXISTS candidate_matches_drive_tenant_fkey;
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_drive_tenant_fkey;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
