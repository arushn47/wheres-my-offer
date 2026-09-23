/**
 * TypeScript types matching the Supabase database schema.
 * These are the raw database row types.
 */

export interface DbUser {
  id: string;
  google_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  neo_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbGmailAccount {
  id: string;
  user_id: string;
  email: string;
  account_type: 'personal' | 'college';
  google_account_id: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expiry: string | null;
  last_sync_at: string | null;
  last_history_id: string | null;
  is_connected: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbCompany {
  id: string;
  user_id: string;
  name: string;
  legal_name: string | null;
  aliases: string[];
  created_at: string;
  updated_at: string;
}

export interface DbPlacementDrive {
  id: string;
  user_id: string;
  company_id: string;

  drive_number: string | null;
  normalized_drive_number: string | null;
  drive_name: string | null;
  role: string | null;
  category: string | null;
  ctc: string | null;
  stipend: string | null;
  location: string | null;
  eligibility: string | null;
  branches: string[] | null;
  cgpa_requirement: string | null;
  backlog_requirement: string | null;
  registration_deadline: string | null;
  identity_state: 'assigned' | 'ambiguous' | 'unassigned' | 'legacy' | 'conflict' | 'manually_assigned';
  identity_confidence: 'high' | 'medium' | 'low';
  identity_source: string | null;
  source_email_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbApplication {
  id: string;
  user_id: string;
  placement_drive_id: string;
  status: string;
  status_source: string | null;
  status_confidence: 'high' | 'medium' | 'low' | 'ai' | 'manual';
  role: string | null;
  ctc: string | null;
  stipend: string | null;
  location: string | null;
  eligibility: string | null;
  branches: string[] | null;
  cgpa_requirement: string | null;
  backlog_requirement: string | null;
  registration_deadline: string | null;
  job_description: string | null;
  manual_override: boolean;
  notes: string | null;
  applied_at: string | null;
  category?: string | null;
  status_source_email_at?: string | null;
  last_updated: string;
  created_at: string;
}

export interface DbEmail {
  id: string;
  gmail_account_id: string;
  user_id: string;
  gmail_message_id: string;
  thread_id: string | null;
  sender: string | null;
  subject: string | null;
  received_at: string | null;
  body_snippet: string | null;
  classification: string | null;
  placement_drive_id: string | null;
  assignment_state: 'assigned' | 'ambiguous' | 'unassigned' | 'legacy' | 'conflict' | null;
  assignment_confidence: 'high' | 'medium' | 'low' | null;
  assignment_source: string | null;
  rfc_message_id?: string | null;
  canonical_email_id?: string | null;
  is_processed: boolean;
  is_relevant: boolean;
  processed_at: string | null;
  created_at: string;
}

export interface DbEmailDriveLink {
  id: string;
  user_id: string;
  email_id: string;
  placement_drive_id: string;
  link_type: 'primary' | 'secondary' | 'pooled' | 'reference_only' | 'ambiguous_candidate';
  confidence: 'high' | 'medium' | 'low';
  assignment_source: string | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbAttachment {
  id: string;
  email_id: string;
  user_id: string;
  filename: string;
  mime_type: string | null;
  storage_path: string | null;
  file_hash: string | null;
  file_size_bytes: number | null;
  is_processed: boolean;
  created_at: string;
}

export interface DbCandidateMatch {
  id: string;
  user_id: string;
  attachment_id: string | null;
  email_id: string | null;
  placement_drive_id: string;
  neo_id: string;
  match_type: 'xlsx_cell' | 'xlsx_applied_list' | 'pdf_text' | 'docx_text' | 'email_body' | 'email_subject';
  matched_value: string | null;
  match_location: string | null;
  confidence: 'high' | 'medium' | 'low';
  created_at: string;
}

export interface DbEvent {
  id: string;
  user_id: string;
  placement_drive_id: string;
  event_type: string;
  title: string | null;
  start_time: string | null;
  end_time: string | null;
  venue: string | null;
  mode: 'online' | 'offline' | 'hybrid' | 'unknown' | null;
  source_email_id: string | null;
  confidence: 'high' | 'medium' | 'low' | 'ai';
  manual_override: boolean;
  gcal_event_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbDocument {
  id: string;
  user_id: string;

  application_id: string | null;
  document_type: 'jd' | 'shortlist' | 'company_info' | 'offer_letter' | 'other';
  filename: string;
  storage_path: string;
  source_email_id: string | null;
  created_at: string;
}

export interface DbStatusHistory {
  id: string;
  application_id: string;
  old_status: string | null;
  new_status: string;
  source: string | null;
  source_email_id: string | null;
  changed_at: string;
}

export interface DbNotification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  message: string | null;
  placement_drive_id?: string | null;
  is_read: boolean;
  body?: string | null;
  link?: string | null;
  event_id?: string | null;
  dedupe_key?: string | null;
  created_at: string;
}

export interface DbPushSubscription {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbNotificationPreferences {
  user_id: string;
  browser_push_enabled: boolean;
  in_app_enabled: boolean;
  notify_status_change: boolean;
  notify_shortlist: boolean;
  notify_tests: boolean;
  notify_interviews: boolean;
  notify_ppt: boolean;
  notify_new_jds: boolean;
  notify_reminders: boolean;
  reminder_event_types: string[];
  reminder_lead_time_mins: number[];
  created_at: string;
  updated_at: string;
}

export interface DbDriveResolution {
  id: string;
  drive_number: string;
  company_base_name: string;
  resolved_role: string;
  resolved_company_name: string;
  resolved_via: 'timing_correlation' | 'direct_role_text' | 'manual_review' | 'historical_rule';
  confidence: 'high' | 'medium' | 'low' | 'needs_review';
  time_diff_seconds?: number | null;
  candidate_circular_id?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbSyncState {
  user_id: string;
  is_syncing: boolean;
  phase: string;
  account_email?: string | null;
  account_type?: string | null;
  total_messages: number;
  processed_messages: number;
  new_emails: number;
  new_companies: number;
  skipped_duplicates: number;
  current_subject?: string | null;
  is_initial_sync: boolean;
  current_page_index: number;
  total_pages: number;
  started_at?: string | null;
  updated_at: string;
  completed_at?: string | null;
  last_error?: string | null;
}

export interface DbSyncPage {
  id: string;
  user_id?: string | null;
  gmail_account_id?: string | null;
  page_index: number;
  message_ids: string[];
  next_offset: number;
  status: 'pending' | 'in_progress' | 'complete';
  created_at: string;
  updated_at: string;
}

export interface DbFeedbackReport {
  id: string;
  user_id?: string | null;
  user_email: string;
  user_name?: string | null;
  category: 'bug' | 'feature' | 'sync_issue' | 'general';
  severity: 'low' | 'normal' | 'high' | 'critical';
  subject: string;
  message: string;
  metadata?: Record<string, unknown>;
  status: 'new' | 'in_progress' | 'resolved' | 'closed';
  created_at: string;
  updated_at: string;
}
