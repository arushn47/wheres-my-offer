-- ============================================
-- Migration v11: Placement-drive identity foundation
-- ============================================
-- Phase 1 only: creates the drive domain model and nullable relationships.
-- Existing company-scoped runtime behavior is intentionally preserved.
-- No historical rows are assigned, split, merged, or deleted.

BEGIN;

CREATE TABLE IF NOT EXISTS public.placement_drives (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  company_id UUID NOT NULL,
  drive_number TEXT,
  normalized_drive_number TEXT,
  drive_name TEXT,
  role TEXT,
  category TEXT,
  ctc TEXT,
  stipend TEXT,
  location TEXT,
  eligibility TEXT,
  branches TEXT[],
  cgpa_requirement TEXT,
  backlog_requirement TEXT,
  registration_deadline TIMESTAMPTZ,
  identity_state TEXT NOT NULL DEFAULT 'unassigned'
    CHECK (identity_state IN ('assigned', 'ambiguous', 'unassigned', 'legacy', 'conflict', 'manually_assigned')),
  identity_confidence TEXT NOT NULL DEFAULT 'low'
    CHECK (identity_confidence IN ('high', 'medium', 'low')),
  identity_source TEXT,
  source_email_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT placement_drives_pkey PRIMARY KEY (id),
  CONSTRAINT placement_drives_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT placement_drives_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE
);

ALTER TABLE public.applications
  ADD COLUMN IF NOT EXISTS placement_drive_id UUID;

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS placement_drive_id UUID,
  ADD COLUMN IF NOT EXISTS assignment_state TEXT DEFAULT 'unassigned',
  ADD COLUMN IF NOT EXISTS assignment_confidence TEXT DEFAULT 'low',
  ADD COLUMN IF NOT EXISTS assignment_source TEXT;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS placement_drive_id UUID;

ALTER TABLE public.candidate_matches
  ADD COLUMN IF NOT EXISTS placement_drive_id UUID,
  ADD COLUMN IF NOT EXISTS application_id UUID;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS placement_drive_id UUID;

CREATE TABLE IF NOT EXISTS public.email_drive_links (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  email_id UUID NOT NULL,
  placement_drive_id UUID NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'candidate'
    CHECK (link_type IN ('primary', 'secondary', 'pooled', 'reference_only', 'ambiguous_candidate')),
  confidence TEXT NOT NULL DEFAULT 'low'
    CHECK (confidence IN ('high', 'medium', 'low')),
  assignment_source TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT email_drive_links_pkey PRIMARY KEY (id),
  CONSTRAINT email_drive_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT email_drive_links_email_id_fkey FOREIGN KEY (email_id) REFERENCES public.emails(id) ON DELETE CASCADE,
  CONSTRAINT email_drive_links_drive_id_fkey FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE CASCADE,
  CONSTRAINT email_drive_links_identity_unique UNIQUE (email_id, placement_drive_id, link_type)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_placement_drives_user_drive_number
  ON public.placement_drives (user_id, normalized_drive_number)
  WHERE normalized_drive_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_user_drive
  ON public.applications (user_id, placement_drive_id)
  WHERE placement_drive_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_placement_drives_user ON public.placement_drives(user_id);
CREATE INDEX IF NOT EXISTS idx_placement_drives_company ON public.placement_drives(company_id);
CREATE INDEX IF NOT EXISTS idx_placement_drives_state ON public.placement_drives(user_id, identity_state);
CREATE INDEX IF NOT EXISTS idx_applications_drive ON public.applications(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_emails_drive ON public.emails(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_emails_assignment ON public.emails(user_id, assignment_state);
CREATE INDEX IF NOT EXISTS idx_events_drive ON public.events(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_candidate_matches_drive ON public.candidate_matches(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_candidate_matches_application ON public.candidate_matches(application_id);
CREATE INDEX IF NOT EXISTS idx_notifications_drive ON public.notifications(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_email_drive_links_email ON public.email_drive_links(email_id);
CREATE INDEX IF NOT EXISTS idx_email_drive_links_drive ON public.email_drive_links(placement_drive_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'applications_placement_drive_id_fkey') THEN
    ALTER TABLE public.applications
      ADD CONSTRAINT applications_placement_drive_id_fkey
      FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emails_placement_drive_id_fkey') THEN
    ALTER TABLE public.emails
      ADD CONSTRAINT emails_placement_drive_id_fkey
      FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_placement_drive_id_fkey') THEN
    ALTER TABLE public.events
      ADD CONSTRAINT events_placement_drive_id_fkey
      FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'candidate_matches_placement_drive_id_fkey') THEN
    ALTER TABLE public.candidate_matches
      ADD CONSTRAINT candidate_matches_placement_drive_id_fkey
      FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'candidate_matches_application_id_fkey') THEN
    ALTER TABLE public.candidate_matches
      ADD CONSTRAINT candidate_matches_application_id_fkey
      FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_placement_drive_id_fkey') THEN
    ALTER TABLE public.notifications
      ADD CONSTRAINT notifications_placement_drive_id_fkey
      FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;
