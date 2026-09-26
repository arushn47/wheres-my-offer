-- ============================================================================
-- NeoTrack (Where's My Offer) — Consolidated Authoritative Database Schema
-- ============================================================================
-- Consolidated snapshot matching live Supabase production and all migrations
-- (v1 through v27, including Google Pub/Sub push inbox, Canonical Email
-- deduplication, Sync Lease concurrency locking, and tenant RLS invariants).
-- ============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. users
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.users (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  google_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  neo_id TEXT,
  role TEXT DEFAULT 'user'::text CHECK (role = ANY (ARRAY['user'::text, 'admin'::text])),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT users_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- 2. gmail_accounts
-- ============================================================================
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
  watch_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT gmail_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT gmail_accounts_user_email_unique UNIQUE (user_id, email),
  CONSTRAINT gmail_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- ============================================================================
-- 3. companies
-- ============================================================================
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

-- ============================================================================
-- 4. canonical_emails (Global cross-tenant deduplicated message archive)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.canonical_emails (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  content_key TEXT NOT NULL UNIQUE,
  sender_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_snippet TEXT,
  body_text TEXT,
  message_id TEXT,
  metadata_key TEXT,
  has_attachments BOOLEAN,
  classification TEXT,
  classification_confidence REAL,
  parsed_company_name TEXT,
  parsed_drive_numbers JSONB,
  parsed_job_details JSONB,
  parsed_events JSONB,
  parser_version INTEGER NOT NULL DEFAULT 1,
  identity_version INTEGER NOT NULL DEFAULT 2,
  processing_status TEXT NOT NULL DEFAULT 'pending'::text
    CHECK (processing_status = ANY (ARRAY['pending'::text, 'processing'::text, 'complete'::text, 'error'::text])),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT canonical_emails_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- 5. canonical_attachments (Global cross-tenant deduplicated attachments)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.canonical_attachments (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  canonical_email_id UUID NOT NULL,
  gmail_message_id TEXT NOT NULL,
  gmail_account_id UUID NOT NULL,
  attachment_id TEXT NOT NULL,
  filename TEXT,
  size_bytes BIGINT,
  content_hash TEXT UNIQUE,
  extracted_rows JSONB,
  parse_status TEXT NOT NULL DEFAULT 'pending'::text
    CHECK (parse_status = ANY (ARRAY['pending'::text, 'processing'::text, 'complete'::text, 'error'::text])),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT canonical_attachments_pkey PRIMARY KEY (id),
  CONSTRAINT canonical_attachments_canonical_email_id_fkey
    FOREIGN KEY (canonical_email_id) REFERENCES public.canonical_emails(id) ON DELETE CASCADE
);

-- ============================================================================
-- 6. placement_drives
-- ============================================================================
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
  identity_state TEXT NOT NULL DEFAULT 'unassigned'::text
    CHECK (identity_state = ANY (ARRAY['assigned'::text, 'ambiguous'::text, 'unassigned'::text, 'legacy'::text, 'conflict'::text, 'manually_assigned'::text])),
  identity_confidence TEXT NOT NULL DEFAULT 'low'::text
    CHECK (identity_confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])),
  identity_source TEXT,
  source_email_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT placement_drives_pkey PRIMARY KEY (id),
  CONSTRAINT placement_drives_user_id_id_key UNIQUE (user_id, id),
  CONSTRAINT placement_drives_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT placement_drives_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE
);

-- ============================================================================
-- 7. applications
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.applications (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  placement_drive_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown'::text
    CHECK (status = ANY (ARRAY[
      'not_applied'::text, 'applied'::text, 'registration_open'::text,
      'ppt_scheduled'::text, 'ppt_ongoing'::text, 'ppt_completed'::text,
      'shortlisted'::text, 'test_scheduled'::text, 'test_ongoing'::text, 'test_completed'::text,
      'interview_scheduled'::text, 'interview_ongoing'::text, 'interview_completed'::text,
      'selected'::text, 'offer'::text, 'offer_received'::text,
      'rejected'::text, 'not_shortlisted'::text, 'rejected_test'::text, 'rejected_interview'::text,
      'withdrawn'::text, 'declined'::text, 'unknown'::text
    ])),
  status_source TEXT,
  status_confidence TEXT DEFAULT 'low'::text
    CHECK (status_confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text, 'ai'::text, 'manual'::text])),
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
  category TEXT,
  work_mode TEXT CHECK (work_mode IS NULL OR (work_mode = ANY (ARRAY['remote'::text, 'office'::text, 'hybrid'::text]))),
  applied_at TIMESTAMPTZ,
  status_source_email_at TIMESTAMPTZ,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT applications_pkey PRIMARY KEY (id),
  CONSTRAINT applications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT applications_placement_drive_id_fkey FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE CASCADE
);

-- ============================================================================
-- 8. emails (User-level Gmail receipts)
-- ============================================================================
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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  placement_drive_id UUID,
  assignment_state TEXT DEFAULT 'unassigned'::text,
  assignment_confidence TEXT DEFAULT 'low'::text,
  assignment_source TEXT,
  canonical_email_id UUID,
  rfc_message_id TEXT,
  CONSTRAINT emails_pkey PRIMARY KEY (id),
  CONSTRAINT emails_gmail_account_id_fkey FOREIGN KEY (gmail_account_id) REFERENCES public.gmail_accounts(id) ON DELETE CASCADE,
  CONSTRAINT emails_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT emails_placement_drive_id_fkey FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE SET NULL,
  CONSTRAINT emails_canonical_email_id_fkey FOREIGN KEY (canonical_email_id) REFERENCES public.canonical_emails(id) ON DELETE SET NULL,
  CONSTRAINT chk_emails_body_snippet_max_500 CHECK (
    canonical_email_id IS NULL
    OR body_snippet IS NULL
    OR length(body_snippet) <= 500
  )
);

-- ============================================================================
-- 9. drive_resolutions (Global Drive Number to Role/Track Mapping Cache)
-- ============================================================================
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

-- ============================================================================
-- 10. candidate_matches (Shortlist / Eligibility evidence)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.candidate_matches (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  placement_drive_id UUID NOT NULL,
  email_id UUID,
  attachment_id UUID,
  neo_id TEXT NOT NULL,
  match_type TEXT NOT NULL CHECK (match_type = ANY (ARRAY[
    'xlsx_cell'::text, 'xlsx_applied_list'::text, 'pdf_text'::text, 'docx_text'::text,
    'email_body'::text, 'email_subject'::text
  ])),
  matched_round_type TEXT CHECK (matched_round_type IS NULL OR (matched_round_type = ANY (ARRAY['test'::text, 'interview'::text, 'selected'::text]))),
  matched_value TEXT,
  match_location TEXT,
  confidence TEXT DEFAULT 'high'::text CHECK (confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT candidate_matches_pkey PRIMARY KEY (id),
  CONSTRAINT candidate_matches_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT candidate_matches_email_id_fkey FOREIGN KEY (email_id) REFERENCES public.emails(id) ON DELETE CASCADE,
  CONSTRAINT candidate_matches_placement_drive_id_fkey FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE CASCADE
);

-- ============================================================================
-- 11. events (Deadlines, Tests, Interviews, PPTs)
-- ============================================================================
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
  gcal_event_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT events_pkey PRIMARY KEY (id),
  CONSTRAINT events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT events_source_email_id_fkey FOREIGN KEY (source_email_id) REFERENCES public.emails(id) ON DELETE SET NULL,
  CONSTRAINT events_placement_drive_id_fkey FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE CASCADE
);

-- ============================================================================
-- 12. notifications
-- ============================================================================
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
  body TEXT,
  link TEXT,
  event_id UUID,
  placement_drive_id UUID,
  dedupe_key TEXT UNIQUE,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT notifications_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL,
  CONSTRAINT notifications_placement_drive_id_fkey FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE SET NULL
);

-- ============================================================================
-- 13. email_drive_links (Association mapping between emails and drives)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.email_drive_links (
  id UUID NOT NULL DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  email_id UUID NOT NULL,
  placement_drive_id UUID NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'candidate'::text
    CHECK (link_type = ANY (ARRAY['primary'::text, 'secondary'::text, 'pooled'::text, 'reference_only'::text, 'ambiguous_candidate'::text])),
  confidence TEXT NOT NULL DEFAULT 'low'::text
    CHECK (confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])),
  assignment_source TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT email_drive_links_pkey PRIMARY KEY (id),
  CONSTRAINT email_drive_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT email_drive_links_email_id_fkey FOREIGN KEY (email_id) REFERENCES public.emails(id) ON DELETE CASCADE,
  CONSTRAINT email_drive_links_drive_id_fkey FOREIGN KEY (placement_drive_id) REFERENCES public.placement_drives(id) ON DELETE CASCADE
);

-- ============================================================================
-- 14. push_subscriptions
-- ============================================================================
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

-- ============================================================================
-- 15. notification_preferences
-- ============================================================================
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
  reminder_event_types TEXT[] DEFAULT ARRAY['online_test'::text, 'coding_test'::text, 'technical_interview'::text, 'hr_interview'::text, 'final_interview'::text, 'ppt'::text, 'registration_deadline'::text],
  reminder_lead_time_mins INTEGER[] DEFAULT ARRAY[1440, 120, 15],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT notification_preferences_pkey PRIMARY KEY (user_id),
  CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- ============================================================================
-- 16. sync_state (Per-user sync lease & progress state)
-- ============================================================================
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
  run_id UUID,
  lease_expires_at TIMESTAMPTZ,
  CONSTRAINT sync_state_pkey PRIMARY KEY (user_id),
  CONSTRAINT sync_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- ============================================================================
-- 17. sync_pages (Pagination checkpointing for resumed syncs)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.sync_pages (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID,
  gmail_account_id UUID,
  page_index INTEGER NOT NULL,
  message_ids JSONB NOT NULL,
  next_offset INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'::text
    CHECK (status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'complete'::text])),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT sync_pages_pkey PRIMARY KEY (id),
  CONSTRAINT sync_pages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT sync_pages_gmail_account_id_fkey FOREIGN KEY (gmail_account_id) REFERENCES public.gmail_accounts(id) ON DELETE CASCADE
);

-- ============================================================================
-- 18. feedback_reports
-- ============================================================================
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
  CONSTRAINT feedback_reports_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL
);

-- ============================================================================
-- 19. gmail_pubsub_inbox (Replay-safe Google Cloud Pub/Sub Push Webhook Inbox)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.gmail_pubsub_inbox (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  subscription TEXT NOT NULL,
  message_id TEXT NOT NULL,
  email_address TEXT NOT NULL,
  history_id TEXT,
  publish_time TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'processing'::text
    CHECK (status = ANY (ARRAY['processing'::text, 'completed'::text, 'failed'::text])),
  run_id UUID,
  attempts INTEGER NOT NULL DEFAULT 1,
  locked_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '2 minutes'),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gmail_pubsub_inbox_pkey PRIMARY KEY (id),
  CONSTRAINT gmail_pubsub_inbox_message_unique UNIQUE (subscription, message_id)
);


-- ============================================================================
-- INDEXES
-- ============================================================================

-- Users
CREATE INDEX IF NOT EXISTS idx_users_google_id ON public.users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_neo_id ON public.users(neo_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON public.users(role);

-- Gmail accounts
CREATE INDEX IF NOT EXISTS idx_gmail_accounts_user ON public.gmail_accounts(user_id);

-- Companies
CREATE INDEX IF NOT EXISTS idx_companies_user ON public.companies(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_name ON public.companies(user_id, name);

-- Canonical emails & attachments
CREATE INDEX IF NOT EXISTS idx_canonical_emails_content_key ON public.canonical_emails(content_key);
CREATE INDEX IF NOT EXISTS idx_canonical_emails_status ON public.canonical_emails(processing_status);
CREATE INDEX IF NOT EXISTS idx_canonical_emails_identity_version_key ON public.canonical_emails(identity_version, content_key);
CREATE INDEX IF NOT EXISTS idx_canonical_emails_message_metadata ON public.canonical_emails(message_id, metadata_key);
CREATE INDEX IF NOT EXISTS idx_canonical_emails_status_identity ON public.canonical_emails(processing_status, identity_version);
CREATE INDEX IF NOT EXISTS idx_canonical_emails_body_text_not_null ON public.canonical_emails(id) WHERE body_text IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_canonical_attachments_email_id ON public.canonical_attachments(canonical_email_id);
CREATE INDEX IF NOT EXISTS idx_canonical_attachments_hash ON public.canonical_attachments(content_hash);

-- Placement drives
CREATE UNIQUE INDEX IF NOT EXISTS idx_placement_drives_user_drive_number
  ON public.placement_drives(user_id, normalized_drive_number)
  WHERE normalized_drive_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_placement_drives_user ON public.placement_drives(user_id);
CREATE INDEX IF NOT EXISTS idx_placement_drives_company ON public.placement_drives(company_id);
CREATE INDEX IF NOT EXISTS idx_placement_drives_state ON public.placement_drives(user_id, identity_state);

-- Applications
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_user_drive
  ON public.applications(user_id, placement_drive_id)
  WHERE placement_drive_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_applications_drive ON public.applications(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_applications_user ON public.applications(user_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON public.applications(user_id, status);
CREATE INDEX IF NOT EXISTS idx_applications_source_email_at ON public.applications(user_id, status_source_email_at);

-- Emails
CREATE INDEX IF NOT EXISTS idx_emails_gmail_message ON public.emails(gmail_account_id, gmail_message_id);
CREATE INDEX IF NOT EXISTS idx_emails_user ON public.emails(user_id);
CREATE INDEX IF NOT EXISTS idx_emails_drive ON public.emails(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_emails_classification ON public.emails(classification);
CREATE INDEX IF NOT EXISTS idx_emails_assignment ON public.emails(user_id, assignment_state);
CREATE INDEX IF NOT EXISTS idx_emails_canonical_email_id ON public.emails(canonical_email_id);
CREATE INDEX IF NOT EXISTS idx_emails_rfc_message_id ON public.emails(rfc_message_id);
CREATE INDEX IF NOT EXISTS idx_emails_user_sender_received ON public.emails(user_id, sender, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_user_unlinked_canonical ON public.emails(user_id) WHERE canonical_email_id IS NULL;

-- Candidate matches
CREATE INDEX IF NOT EXISTS idx_candidate_matches_neo ON public.candidate_matches(neo_id);
CREATE INDEX IF NOT EXISTS idx_candidate_matches_drive ON public.candidate_matches(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_candidate_matches_user_drive ON public.candidate_matches(user_id, placement_drive_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_matches_identity_nulls_not_distinct
  ON public.candidate_matches(user_id, placement_drive_id, neo_id, match_type, matched_round_type)
  WHERE email_id IS NULL;

-- Events
CREATE INDEX IF NOT EXISTS idx_events_drive ON public.events(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_events_user ON public.events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_start ON public.events(start_time);
CREATE INDEX IF NOT EXISTS idx_events_type ON public.events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_gcal_event_id ON public.events(gcal_event_id);
CREATE INDEX IF NOT EXISTS idx_events_user_drive_type_date ON public.events(user_id, placement_drive_id, event_type, start_time);

-- Notifications
CREATE INDEX IF NOT EXISTS idx_notifications_drive ON public.notifications(placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON public.notifications(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON public.notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_drive ON public.notifications(user_id, placement_drive_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_type_created ON public.notifications(user_id, type, created_at DESC);

-- Email drive links
CREATE INDEX IF NOT EXISTS idx_email_drive_links_email ON public.email_drive_links(email_id);
CREATE INDEX IF NOT EXISTS idx_email_drive_links_drive ON public.email_drive_links(placement_drive_id);

-- Push subscriptions & Preferences
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON public.push_subscriptions(user_id);

-- Sync state & Sync pages
CREATE INDEX IF NOT EXISTS idx_sync_state_user ON public.sync_state(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_state_syncing ON public.sync_state(is_syncing) WHERE is_syncing = TRUE;
CREATE INDEX IF NOT EXISTS idx_sync_pages_user_status ON public.sync_pages(user_id, status);
CREATE INDEX IF NOT EXISTS idx_sync_pages_account_status ON public.sync_pages(gmail_account_id, status, page_index);

-- Feedback
CREATE INDEX IF NOT EXISTS idx_feedback_reports_user_id ON public.feedback_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_reports_status ON public.feedback_reports(status);
CREATE INDEX IF NOT EXISTS idx_feedback_reports_category ON public.feedback_reports(category);
CREATE INDEX IF NOT EXISTS idx_feedback_reports_created_at ON public.feedback_reports(created_at DESC);

-- Drive resolutions
CREATE INDEX IF NOT EXISTS idx_drive_resolutions_drive_num ON public.drive_resolutions(drive_number);
CREATE INDEX IF NOT EXISTS idx_drive_resolutions_company ON public.drive_resolutions(company_base_name);

-- Pub/Sub Inbox Queue
CREATE INDEX IF NOT EXISTS idx_gmail_pubsub_inbox_processing ON public.gmail_pubsub_inbox(status, locked_until);


-- ============================================================================
-- STORED PROCEDURES & FUNCTIONS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. acquire_sync_lease
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acquire_sync_lease(
  p_user_id UUID,
  p_run_id UUID,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.sync_state (
    user_id, run_id, is_syncing, phase, updated_at, lease_expires_at
  )
  VALUES (
    p_user_id, p_run_id, TRUE, 'initializing', NOW(),
    NOW() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 900)))
  )
  ON CONFLICT (user_id) DO UPDATE
  SET run_id = EXCLUDED.run_id,
      is_syncing = TRUE,
      phase = 'initializing',
      updated_at = NOW(),
      lease_expires_at = EXCLUDED.lease_expires_at
  WHERE public.sync_state.is_syncing IS NOT TRUE
     OR public.sync_state.lease_expires_at <= NOW()
     OR (
       public.sync_state.lease_expires_at IS NULL
       AND public.sync_state.updated_at <= NOW() - INTERVAL '90 seconds'
     )
  RETURNING TRUE;
$$;

-- ----------------------------------------------------------------------------
-- 2. update_sync_lease
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_sync_lease(
  p_user_id UUID,
  p_run_id UUID,
  p_progress JSONB,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SET search_path = public, pg_temp
AS $$
  UPDATE public.sync_state
  SET phase = COALESCE(p_progress->>'phase', phase),
      account_email = COALESCE(p_progress->>'accountEmail', account_email),
      account_type = COALESCE(p_progress->>'accountType', account_type),
      total_messages = COALESCE((p_progress->>'totalMessages')::INTEGER, total_messages),
      processed_messages = COALESCE((p_progress->>'processedMessages')::INTEGER, processed_messages),
      new_emails = COALESCE((p_progress->>'newEmails')::INTEGER, new_emails),
      new_companies = COALESCE((p_progress->>'newCompanies')::INTEGER, new_companies),
      skipped_duplicates = COALESCE((p_progress->>'skippedDuplicates')::INTEGER, skipped_duplicates),
      current_subject = NULLIF(p_progress->>'currentSubject', ''),
      is_initial_sync = COALESCE((p_progress->>'isInitialSync')::BOOLEAN, is_initial_sync),
      current_page_index = COALESCE((p_progress->>'currentPageIndex')::INTEGER, current_page_index),
      total_pages = COALESCE((p_progress->>'totalPagesCount')::INTEGER, total_pages),
      last_error = NULLIF(p_progress->>'lastError', ''),
      updated_at = NOW(),
      lease_expires_at = NOW() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 900)))
  WHERE user_id = p_user_id
    AND run_id = p_run_id
    AND is_syncing = TRUE
  RETURNING TRUE;
$$;

-- ----------------------------------------------------------------------------
-- 3. release_sync_lease
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_sync_lease(
  p_user_id UUID,
  p_run_id UUID,
  p_phase TEXT,
  p_last_error TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SET search_path = public, pg_temp
AS $$
  UPDATE public.sync_state
  SET is_syncing = FALSE,
      phase = p_phase,
      last_error = p_last_error,
      completed_at = CASE WHEN p_phase IN ('complete', 'error') THEN NOW() ELSE completed_at END,
      updated_at = NOW(),
      lease_expires_at = NULL
  WHERE user_id = p_user_id
    AND run_id = p_run_id
    AND is_syncing = TRUE
  RETURNING TRUE;
$$;

-- ----------------------------------------------------------------------------
-- 4. update_sync_page_checkpoint
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_sync_page_checkpoint(
  p_user_id UUID,
  p_run_id UUID,
  p_page_id UUID,
  p_next_offset INTEGER,
  p_status TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SET search_path = public, pg_temp
AS $$
  UPDATE public.sync_pages AS page
  SET next_offset = p_next_offset,
      status = COALESCE(p_status, page.status),
      updated_at = NOW()
  WHERE page.id = p_page_id
    AND page.user_id = p_user_id
    AND EXISTS (
      SELECT 1
      FROM public.sync_state AS state
      WHERE state.user_id = p_user_id
        AND state.run_id = p_run_id
        AND state.is_syncing = TRUE
        AND state.lease_expires_at > NOW()
    )
  RETURNING TRUE;
$$;

-- ----------------------------------------------------------------------------
-- 5. claim_gmail_pubsub_message
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_gmail_pubsub_message(
  p_subscription TEXT,
  p_message_id TEXT,
  p_email_address TEXT,
  p_history_id TEXT,
  p_publish_time TIMESTAMPTZ,
  p_run_id UUID,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.gmail_pubsub_inbox (
    subscription, message_id, email_address, history_id, publish_time,
    status, run_id, attempts, locked_until, updated_at
  )
  VALUES (
    p_subscription, p_message_id, p_email_address, p_history_id, p_publish_time,
    'processing', p_run_id, 1,
    NOW() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 900))), NOW()
  )
  ON CONFLICT (subscription, message_id) DO UPDATE
  SET status = 'processing',
      email_address = EXCLUDED.email_address,
      history_id = EXCLUDED.history_id,
      publish_time = EXCLUDED.publish_time,
      run_id = EXCLUDED.run_id,
      attempts = gmail_pubsub_inbox.attempts + 1,
      locked_until = NOW() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 900))),
      last_error = NULL,
      updated_at = NOW()
  WHERE gmail_pubsub_inbox.status = 'failed'
     OR gmail_pubsub_inbox.locked_until <= NOW()
  RETURNING TRUE;
$$;

-- ----------------------------------------------------------------------------
-- 6. complete_gmail_pubsub_message
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_gmail_pubsub_message(
  p_subscription TEXT,
  p_message_id TEXT,
  p_run_id UUID
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SET search_path = public, pg_temp
AS $$
  UPDATE public.gmail_pubsub_inbox
  SET status = 'completed', locked_until = NOW(), updated_at = NOW(), last_error = NULL
  WHERE subscription = p_subscription AND message_id = p_message_id
    AND run_id = p_run_id AND status = 'processing'
  RETURNING TRUE;
$$;

-- ----------------------------------------------------------------------------
-- 7. fail_gmail_pubsub_message
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fail_gmail_pubsub_message(
  p_subscription TEXT,
  p_message_id TEXT,
  p_run_id UUID,
  p_error TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
VOLATILE
SET search_path = public, pg_temp
AS $$
  UPDATE public.gmail_pubsub_inbox
  SET status = 'failed', locked_until = NOW(), updated_at = NOW(), last_error = LEFT(p_error, 2000)
  WHERE subscription = p_subscription AND message_id = p_message_id
    AND run_id = p_run_id AND status = 'processing'
  RETURNING TRUE;
$$;

-- ----------------------------------------------------------------------------
-- 8. trg_emails_truncate_body_snippet
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 9. guard_admin_unlinked_email
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_admin_unlinked_email()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
BEGIN
  IF OLD.assignment_source = 'admin_unlinked'
     AND NEW.placement_drive_id IS NOT NULL
     AND OLD.placement_drive_id IS DISTINCT FROM NEW.placement_drive_id
     AND NEW.assignment_source = 'admin_unlinked' THEN
    RAISE EXCEPTION
      'Email % is admin-unlinked and cannot be re-assigned. Only the admin link action may restore it.',
      OLD.id;
  END IF;
  RETURN NEW;
END;
$func$;

-- Function Permissions
REVOKE ALL ON FUNCTION public.acquire_sync_lease(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_sync_lease(UUID, UUID, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_sync_lease(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_sync_page_checkpoint(UUID, UUID, UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_sync_lease(UUID, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_sync_lease(UUID, UUID, JSONB, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_sync_lease(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_sync_page_checkpoint(UUID, UUID, UUID, INTEGER, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.claim_gmail_pubsub_message(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_gmail_pubsub_message(TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_gmail_pubsub_message(TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_gmail_pubsub_message(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_gmail_pubsub_message(TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_gmail_pubsub_message(TEXT, TEXT, UUID, TEXT) TO service_role;


-- ============================================================================
-- TRIGGERS
-- ============================================================================

DROP TRIGGER IF EXISTS trg_emails_truncate_body_snippet ON public.emails;
CREATE TRIGGER trg_emails_truncate_body_snippet
  BEFORE INSERT OR UPDATE ON public.emails
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_emails_truncate_body_snippet();

DROP TRIGGER IF EXISTS trg_emails_guard_admin_unlink ON public.emails;
CREATE TRIGGER trg_emails_guard_admin_unlink
  BEFORE UPDATE ON public.emails
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_admin_unlinked_email();


-- ============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

-- Enable RLS on all tenant-scoped tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gmail_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.placement_drives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_drive_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidate_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_reports ENABLE ROW LEVEL SECURITY;

-- 1. Users policy
DO $$ BEGIN
  CREATE POLICY users_tenant_isolation ON public.users
    FOR ALL TO authenticated
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Generic tenant isolation policies (user_id = auth.uid())
DO $$
DECLARE
  table_name TEXT;
  user_owned_tables TEXT[] := ARRAY[
    'gmail_accounts', 'companies', 'placement_drives', 'applications', 'emails',
    'email_drive_links', 'candidate_matches', 'events', 'notifications',
    'push_subscriptions', 'notification_preferences', 'sync_state', 'sync_pages',
    'feedback_reports'
  ];
BEGIN
  FOREACH table_name IN ARRAY user_owned_tables LOOP
    BEGIN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())',
        table_name || '_tenant_isolation', table_name
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;
