-- ============================================
-- NeoPAT Placement Tracker — Consolidated Live Schema
-- ============================================
-- Authoritative schema snapshot from production Supabase instance.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 1. users
-- ============================================
CREATE TABLE IF NOT EXISTS public.users (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  google_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  neo_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT users_pkey PRIMARY KEY (id)
);

-- ============================================
-- 2. gmail_accounts
-- ============================================
CREATE TABLE IF NOT EXISTS public.gmail_accounts (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  email TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type = ANY (ARRAY['personal'::text, 'college'::text])),
  google_account_id TEXT,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expiry TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  last_history_id TEXT,
  is_connected BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT gmail_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT gmail_accounts_user_email_unique UNIQUE (user_id, email),
  CONSTRAINT gmail_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- ============================================
-- 3. companies
-- ============================================
CREATE TABLE IF NOT EXISTS public.companies (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  legal_name TEXT,
  aliases TEXT[] DEFAULT '{}'::text[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT companies_pkey PRIMARY KEY (id),
  CONSTRAINT companies_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- ============================================
-- 4. placement_drives
-- ============================================
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
  identity_state TEXT NOT NULL DEFAULT 'unassigned' CHECK (identity_state = ANY (ARRAY['assigned'::text, 'ambiguous'::text, 'unassigned'::text, 'legacy'::text, 'conflict'::text, 'manually_assigned'::text])),
  identity_confidence TEXT NOT NULL DEFAULT 'low' CHECK (identity_confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])),
  identity_source TEXT,
  source_email_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT placement_drives_pkey PRIMARY KEY (id),
  CONSTRAINT placement_drives_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT placement_drives_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE
);

-- ============================================
-- 5. applications
-- ============================================
CREATE TABLE IF NOT EXISTS public.applications (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  placement_drive_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown'::text CHECK (status = ANY (ARRAY[
    'not_applied'::text, 'applied'::text, 'shortlisted'::text, 'ppt_scheduled'::text,
    'test_scheduled'::text, 'interview_scheduled'::text, 'selected'::text, 'rejected'::text,
    'not_shortlisted'::text, 'withdrawn'::text, 'declined'::text, 'offer_received'::text, 'unknown'::text
  ])),
  status_source TEXT,
  status_confidence TEXT DEFAULT 'low'::text CHECK (status_confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text, 'ai'::text, 'manual'::text])),
  role TEXT,
  ctc TEXT,
  stipend TEXT,
  location TEXT,
  eligibility TEXT,
  branches TEXT[],
  cgpa_requirement TEXT,
  backlog_requirement TEXT,
  registration_deadline TIMESTAMPTZ,
  job_description TEXT,
  manual_override BOOLEAN DEFAULT FALSE,
  notes TEXT,
  applied_at TIMESTAMPTZ,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  category TEXT,
  status_source_email_at TIMESTAMPTZ,
  CONSTRAINT applications_pkey PRIMARY KEY (id),
  CONSTRAINT applications_user_drive_unique UNIQUE (user_id, placement_drive_id),
  CONSTRAINT applications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT applications_placement_drive_id_fkey FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE CASCADE
);

-- ============================================
-- 6. emails
-- ============================================
CREATE TABLE IF NOT EXISTS public.emails (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  gmail_account_id UUID NOT NULL,
  user_id UUID NOT NULL,
  gmail_message_id TEXT NOT NULL,
  thread_id TEXT,
  sender TEXT,
  subject TEXT,
  received_at TIMESTAMPTZ,
  body_snippet TEXT,
  classification TEXT CHECK (classification = ANY (ARRAY[
    'registration'::text, 'registration_confirmation'::text, 'application_status'::text,
    'withdrawal'::text, 'decline'::text, 'shortlist'::text, 'ppt'::text, 'test'::text,
    'interview'::text, 'jd'::text, 'venue_update'::text, 'result'::text, 'general'::text,
    'unclassified_placement_notice'::text, 'irrelevant'::text, 'unclassified'::text
  ])),
  is_processed BOOLEAN DEFAULT FALSE,
  is_relevant BOOLEAN DEFAULT TRUE,
  processed_at TIMESTAMPTZ,
  placement_drive_id UUID,
  assignment_state TEXT DEFAULT 'unassigned',
  assignment_confidence TEXT DEFAULT 'low',
  assignment_source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT emails_pkey PRIMARY KEY (id),
  CONSTRAINT emails_gmail_account_id_fkey FOREIGN KEY (gmail_account_id) REFERENCES public.gmail_accounts(id) ON DELETE CASCADE,
  CONSTRAINT emails_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT emails_placement_drive_id_fkey FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE SET NULL
);

-- ============================================
-- 7. email_drive_links
-- ============================================
CREATE TABLE IF NOT EXISTS public.email_drive_links (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  email_id UUID NOT NULL,
  placement_drive_id UUID NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'candidate' CHECK (link_type = ANY (ARRAY['primary'::text, 'secondary'::text, 'pooled'::text, 'reference_only'::text, 'ambiguous_candidate'::text])),
  confidence TEXT NOT NULL DEFAULT 'low' CHECK (confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])),
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

-- ============================================
-- 8. attachments
-- ============================================
CREATE TABLE IF NOT EXISTS public.attachments (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  email_id UUID NOT NULL,
  user_id UUID NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  storage_path TEXT,
  file_hash TEXT,
  file_size_bytes INTEGER,
  is_processed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT attachments_pkey PRIMARY KEY (id),
  CONSTRAINT attachments_email_id_fkey FOREIGN KEY (email_id) REFERENCES public.emails(id) ON DELETE CASCADE,
  CONSTRAINT attachments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- ============================================
-- 8. candidate_matches
-- ============================================
CREATE TABLE IF NOT EXISTS public.candidate_matches (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  attachment_id UUID,
  email_id UUID,
  placement_drive_id UUID NOT NULL,
  neo_id TEXT NOT NULL,
  match_type TEXT NOT NULL CHECK (match_type = ANY (ARRAY['xlsx_cell'::text, 'xlsx_applied_list'::text, 'pdf_text'::text, 'docx_text'::text, 'email_body'::text, 'email_subject'::text])),
  matched_value TEXT,
  match_location TEXT,
  confidence TEXT DEFAULT 'high'::text CHECK (confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT candidate_matches_pkey PRIMARY KEY (id),
  CONSTRAINT candidate_matches_logical_identity_unique UNIQUE (user_id, email_id, neo_id, match_type),
  CONSTRAINT candidate_matches_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT candidate_matches_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.attachments(id) ON DELETE CASCADE,
  CONSTRAINT candidate_matches_email_id_fkey FOREIGN KEY (email_id) REFERENCES public.emails(id) ON DELETE CASCADE,
  CONSTRAINT candidate_matches_placement_drive_id_fkey FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE CASCADE
);

-- ============================================
-- 9. events
-- ============================================
CREATE TABLE IF NOT EXISTS public.events (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  placement_drive_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = ANY (ARRAY[
    'registration_deadline'::text, 'ppt'::text, 'online_test'::text, 'coding_test'::text,
    'technical_interview'::text, 'hr_interview'::text, 'final_interview'::text,
    'result'::text, 'joining_date'::text, 'other'::text
  ])),
  title TEXT,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  venue TEXT,
  mode TEXT CHECK (mode = ANY (ARRAY['online'::text, 'offline'::text, 'hybrid'::text, 'unknown'::text])),
  source_email_id UUID,
  confidence TEXT DEFAULT 'high'::text CHECK (confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text, 'ai'::text])),
  manual_override BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  gcal_event_id TEXT,
  CONSTRAINT events_pkey PRIMARY KEY (id),
  CONSTRAINT events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT events_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.emails(id) ON DELETE SET NULL,
  CONSTRAINT events_placement_drive_id_fkey FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE CASCADE
);

-- ============================================
-- 9. documents
-- ============================================
CREATE TABLE IF NOT EXISTS public.documents (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  company_id UUID,
  application_id UUID,
  document_type TEXT NOT NULL CHECK (document_type = ANY (ARRAY['jd'::text, 'shortlist'::text, 'company_info'::text, 'offer_letter'::text, 'other'::text])),
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  source_email_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT documents_pkey PRIMARY KEY (id),
  CONSTRAINT documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT documents_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL,
  CONSTRAINT documents_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE,
  CONSTRAINT documents_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.emails(id) ON DELETE SET NULL
);

-- ============================================
-- 10. status_history (for audit trail)
-- ============================================
CREATE TABLE IF NOT EXISTS public.status_history (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  application_id UUID NOT NULL,
  old_status TEXT,
  new_status TEXT NOT NULL,
  source TEXT,
  source_email_id UUID,
  changed_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT status_history_pkey PRIMARY KEY (id),
  CONSTRAINT status_history_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE,
  CONSTRAINT status_history_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.emails(id) ON DELETE SET NULL
);

-- ============================================
-- 11. notifications
-- ============================================
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type = ANY (ARRAY[
    'new_company'::text, 'shortlist_match'::text, 'test_scheduled'::text,
    'interview_scheduled'::text, 'ppt_scheduled'::text, 'deadline_approaching'::text,
    'status_change'::text, 'sync_complete'::text, 'general'::text
  ])),
  title TEXT NOT NULL,
  message TEXT,
  placement_drive_id UUID,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  body TEXT,
  link TEXT,
  event_id UUID,
  dedupe_key TEXT UNIQUE,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_placement_drive_id_fkey FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE SET NULL,
  CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT notifications_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL
);

-- ============================================
-- 12. push_subscriptions
-- ============================================
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- ============================================
-- 13. notification_preferences
-- ============================================
CREATE TABLE IF NOT EXISTS public.notification_preferences (
  user_id UUID NOT NULL,
  browser_push_enabled BOOLEAN DEFAULT TRUE,
  in_app_enabled BOOLEAN DEFAULT TRUE,
  notify_status_change BOOLEAN DEFAULT TRUE,
  notify_shortlist BOOLEAN DEFAULT TRUE,
  notify_tests BOOLEAN DEFAULT TRUE,
  notify_interviews BOOLEAN DEFAULT TRUE,
  notify_ppt BOOLEAN DEFAULT TRUE,
  notify_new_jds BOOLEAN DEFAULT TRUE,
  notify_reminders BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  reminder_event_types TEXT[] DEFAULT ARRAY['online_test'::text, 'coding_test'::text, 'technical_interview'::text, 'hr_interview'::text, 'final_interview'::text, 'ppt'::text, 'registration_deadline'::text],
  reminder_lead_time_mins INTEGER[] DEFAULT ARRAY[1440, 120, 15],
  CONSTRAINT notification_preferences_pkey PRIMARY KEY (user_id),
  CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- ============================================
-- 14. drive_resolutions
-- ============================================
CREATE TABLE IF NOT EXISTS public.drive_resolutions (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  drive_number TEXT NOT NULL UNIQUE,
  company_base_name TEXT NOT NULL,
  resolved_role TEXT NOT NULL,
  resolved_company_name TEXT NOT NULL,
  resolved_via TEXT NOT NULL CHECK (resolved_via = ANY (ARRAY['timing_correlation'::text, 'direct_role_text'::text, 'manual_review'::text, 'historical_rule'::text])),
  confidence TEXT NOT NULL DEFAULT 'high'::text CHECK (confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text, 'needs_review'::text])),
  time_diff_seconds INTEGER,
  candidate_circular_id UUID,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT drive_resolutions_pkey PRIMARY KEY (id),
  CONSTRAINT drive_resolutions_candidate_circular_id_fkey FOREIGN KEY (candidate_circular_id) REFERENCES public.emails(id) ON DELETE SET NULL
);

-- ============================================
-- 15. sync_state
-- ============================================
CREATE TABLE IF NOT EXISTS public.sync_state (
  user_id UUID NOT NULL,
  is_syncing BOOLEAN DEFAULT FALSE,
  phase TEXT DEFAULT 'idle'::text,
  account_email TEXT,
  account_type TEXT,
  total_messages INTEGER DEFAULT 0,
  processed_messages INTEGER DEFAULT 0,
  new_emails INTEGER DEFAULT 0,
  new_companies INTEGER DEFAULT 0,
  skipped_duplicates INTEGER DEFAULT 0,
  current_subject TEXT,
  is_initial_sync BOOLEAN DEFAULT FALSE,
  current_page_index INTEGER DEFAULT 0,
  total_pages INTEGER DEFAULT 1,
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  CONSTRAINT sync_state_pkey PRIMARY KEY (user_id),
  CONSTRAINT sync_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- ============================================
-- 16. sync_pages
-- ============================================
CREATE TABLE IF NOT EXISTS public.sync_pages (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID,
  gmail_account_id UUID,
  page_index INTEGER NOT NULL,
  message_ids JSONB NOT NULL,
  next_offset INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'complete'::text])),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT sync_pages_pkey PRIMARY KEY (id),
  CONSTRAINT sync_pages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT sync_pages_gmail_account_id_fkey FOREIGN KEY (gmail_account_id) REFERENCES public.gmail_accounts(id) ON DELETE CASCADE
);

-- ============================================
-- 17. feedback_reports
-- ============================================
CREATE TABLE IF NOT EXISTS public.feedback_reports (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID,
  user_email TEXT NOT NULL,
  user_name TEXT,
  category TEXT NOT NULL CHECK (category = ANY (ARRAY['bug'::text, 'feature'::text, 'sync_issue'::text, 'general'::text])),
  severity TEXT NOT NULL DEFAULT 'normal'::text CHECK (severity = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'critical'::text])),
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'new'::text CHECK (status = ANY (ARRAY['new'::text, 'in_progress'::text, 'resolved'::text, 'closed'::text])),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT feedback_reports_pkey PRIMARY KEY (id),
  CONSTRAINT feedback_reports_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX IF NOT EXISTS idx_users_google_id ON public.users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_neo_id ON public.users(neo_id);
CREATE INDEX IF NOT EXISTS idx_gmail_accounts_user ON public.gmail_accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_placement_drives_user_drive_number
  ON public.placement_drives(user_id, normalized_drive_number)
  WHERE normalized_drive_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_user_drive
  ON public.applications(user_id, placement_drive_id)
  WHERE placement_drive_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_placement_drives_user ON public.placement_drives(user_id);
CREATE INDEX IF NOT EXISTS idx_placement_drives_company ON public.placement_drives(company_id);
CREATE INDEX IF NOT EXISTS idx_placement_drives_state ON public.placement_drives(user_id, identity_state);
CREATE INDEX IF NOT EXISTS idx_applications_drive ON public.applications(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_emails_drive ON public.emails(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_emails_assignment ON public.emails(user_id, assignment_state);
CREATE INDEX IF NOT EXISTS idx_events_drive ON public.events(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_candidate_matches_drive ON public.candidate_matches(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_notifications_drive ON public.notifications(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_companies_user ON public.companies(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_name ON public.companies(user_id, name);
CREATE INDEX IF NOT EXISTS idx_applications_user ON public.applications(user_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON public.applications(user_id, status);
CREATE INDEX IF NOT EXISTS idx_emails_gmail_message ON public.emails(gmail_account_id, gmail_message_id);
CREATE INDEX IF NOT EXISTS idx_emails_user ON public.emails(user_id);
CREATE INDEX IF NOT EXISTS idx_emails_classification ON public.emails(classification);
CREATE INDEX IF NOT EXISTS idx_attachments_email ON public.attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_attachments_hash ON public.attachments(file_hash);
CREATE INDEX IF NOT EXISTS idx_candidate_matches_neo ON public.candidate_matches(neo_id);
CREATE INDEX IF NOT EXISTS idx_events_user ON public.events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_start ON public.events(start_time);
CREATE INDEX IF NOT EXISTS idx_events_type ON public.events(event_type);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_status_history_app ON public.status_history(application_id);
CREATE INDEX IF NOT EXISTS idx_drive_resolutions_drive_num ON public.drive_resolutions(drive_number);
CREATE INDEX IF NOT EXISTS idx_drive_resolutions_company ON public.drive_resolutions(company_base_name);
CREATE INDEX IF NOT EXISTS idx_sync_pages_user_status ON public.sync_pages(user_id, status);
