import type { ApplicationStatus } from '@/constants/statuses';
import type { EventType } from '@/constants/event-types';

/** Company with its application and related data for the dashboard */
export interface CompanyWithApplication {
  id: string;
  name: string;
  legal_name: string | null;
  drive_number?: string | null;
  drive_name?: string | null;
  status: ApplicationStatus;
  status_confidence: string;
  role: string | null;
  ctc: string | null;
  location: string | null;
  neo_id_match: boolean;
  has_jd: boolean;
  next_event: {
    type: EventType;
    start_time: string;
    title: string | null;
  } | null;
  last_updated: string;
  manual_override: boolean;
}

export interface PlacementDriveSummary {
  id: string;

  company_name: string;
  drive_number: string | null;
  drive_name: string | null;
  status: ApplicationStatus | null;
  next_event: {
    type: EventType;
    start_time: string;
    title: string | null;
  } | null;
}

/** Dashboard summary statistics */
export interface DashboardStats {
  total_companies: number;
  active_applications: number;
  total_applied?: number;
  applied: number;
  shortlisted: number;
  total_shortlisted?: number;
  active_shortlisted?: number;
  not_shortlisted: number;
  upcoming_tests: number;
  upcoming_interviews: number;
  rejected: number;
  withdrawn: number;
  selected: number;
}

/** Upcoming event for the dashboard */
export interface UpcomingEvent {
  id: string;
  company_name: string;

  event_type: EventType;
  title: string | null;
  start_time: string;
  end_time: string | null;
  venue: string | null;
  mode: string | null;
}

/** Timeline entry for the company detail page */
export interface TimelineEntry {
  id: string;
  date: string;
  type: 'email' | 'event' | 'match' | 'status_change';
  title: string;
  description: string | null;
  source_type: 'personal_gmail' | 'college_gmail' | 'manual' | 'system';
  source_id: string | null;
  event_type?: EventType;
  status?: ApplicationStatus;
  neo_id_found?: boolean;
  attachment_name?: string;
}

/** Company detail page data */
export interface CompanyDetail {
  id: string;
  name: string;
  legal_name: string | null;
  aliases: string[];
  drive_number?: string | null;
  drive_name?: string | null;
  application: {
    id: string;
    status: ApplicationStatus;
    status_source: string | null;
    status_confidence: string;
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
  };
  neo_id_match: {
    found: boolean;
    matches: Array<{
      source: string;
      location: string | null;
      confidence: string;
    }>;
  };
  timeline: TimelineEntry[];
  documents: Array<{
    id: string;
    type: string;
    filename: string;
    created_at: string;
  }>;
  source_emails: Array<{
    id: string;
    subject: string | null;
    sender: string | null;
    received_at: string | null;
    classification: string | null;
    account_type: string;
  }>;
}

/** Sync operation state */
export interface SyncState {
  is_syncing: boolean;
  progress: number;
  total: number;
  current_step: string;
  last_sync_at: string | null;
  error: string | null;
}

/** User session data */
export interface UserSession {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  neo_id: string | null;
  gmail_accounts: Array<{
    id: string;
    email: string;
    account_type: 'personal' | 'college';
    is_connected: boolean;
    last_sync_at: string | null;
  }>;
}
