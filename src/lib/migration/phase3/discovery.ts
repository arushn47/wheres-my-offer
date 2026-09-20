/**
 * Phase 3 DISCOVERY step.
 *
 * Loads the raw inputs that RESOLUTION (`resolve-drive.ts`) and PLAN (`plan.ts`) need, and
 * assembles them into one bundle per user. The I/O boundary (`Phase3DiscoveryReader`) is a
 * narrow, injectable interface so this module is testable with an in-memory fake — the real
 * Supabase-backed reader is a thin adapter with no business logic of its own.
 *
 * Business logic here is limited to *aggregation* (grouping rows, resolving a candidate_match's
 * company via its email/application, extracting drive-number evidence from email text). It does
 * NOT classify evidence or decide actions — that remains the job of `resolve-drive.ts`/`plan.ts`.
 */

import { extractAllDriveNumbers } from '@/lib/sync/events';
import { extractJobDetails } from '@/lib/sync/events';
import type { DriveMetadata, MigratableRecordType, TenantDriveRecord } from './types';
import type { MigratableRecord } from './plan';

export interface LegacyRecord extends MigratableRecord {
  recordType: MigratableRecordType;
  companyId: string;
  /** Drive-number evidence found directly on this record (emails only; others rely on the
   *  company-level fallback inside `classifyDriveEvidence`). */
  ownDriveNumbers: Array<string | null | undefined>;
  metadata?: DriveMetadata;
}

/** A legacy record whose tenant scope (company) could not be determined at all. Never guessed. */
export interface UnscopedLegacyRecord {
  recordType: MigratableRecordType;
  recordId: string;
  userId: string;
  reason: string;
}

export interface UserDiscoveryBundle {
  userId: string;
  /** Every placement_drives row this user owns, across every company — see resolve-drive.ts. */
  userDrives: TenantDriveRecord[];
  /** Drive numbers discovered anywhere in a company's own emails, keyed by companyId. */
  companyDiscoveredDriveNumbers: Map<string, Array<string | null | undefined>>;
  /** Every legacy (company-scoped, drive-less) record this user owns, grouped by type. */
  legacyRecords: LegacyRecord[];
  /** Legacy records whose company could not be resolved at all (e.g. an orphaned candidate_match). */
  unscopedRecords: UnscopedLegacyRecord[];
}

export interface EmailRow {
  id: string;
  userId: string;
  companyId: string | null;
  placementDriveId: string | null;
  subject: string | null;
  bodySnippet: string | null;
}

export interface ApplicationRow {
  id: string;
  userId: string;
  companyId: string;
  placementDriveId: string | null;
}

export interface EventRow {
  id: string;
  userId: string;
  companyId: string;
  placementDriveId: string | null;
}

export interface NotificationRow {
  id: string;
  userId: string;
  companyId: string | null;
  placementDriveId: string | null;
}

export interface CandidateMatchRow {
  id: string;
  userId: string;
  emailId: string | null;
  applicationId: string | null;
  placementDriveId: string | null;
}

/**
 * The narrow I/O boundary DISCOVERY depends on. Every method returns already-shaped rows for
 * exactly one user — no cross-user data ever crosses this interface, so a caller bug can't leak
 * another tenant's rows into a discovery bundle by construction.
 */
export interface Phase3DiscoveryReader {
  listUserDrives(userId: string): Promise<TenantDriveRecord[]>;
  /** ALL of this user's emails (not just drive-less ones) — needed both as legacy candidates and
   *  as the company_id lookup source for candidate_matches. */
  listUserEmails(userId: string): Promise<EmailRow[]>;
  /** ALL of this user's applications — needed both as legacy candidates and as the company_id
   *  lookup source for candidate_matches. */
  listUserApplications(userId: string): Promise<ApplicationRow[]>;
  listLegacyEvents(userId: string): Promise<EventRow[]>;
  listLegacyNotifications(userId: string): Promise<NotificationRow[]>;
  listLegacyCandidateMatches(userId: string): Promise<CandidateMatchRow[]>;
}

export interface Phase3ReadQuery<T> extends PromiseLike<{ data: T[] | null; error: { message: string } | null }> {
  eq(column: string, value: string): Phase3ReadQuery<T>;
}

export interface Phase3DiscoveryTableQuery {
  select(columns: string): Phase3ReadQuery<Record<string, unknown>>;
}

export interface Phase3DiscoverySupabaseClient {
  from(table: string): Phase3DiscoveryTableQuery;
}

async function readUserRows(
  supabase: Phase3DiscoverySupabaseClient,
  table: string,
  columns: string,
  userId: string
): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase.from(table).select(columns).eq('user_id', userId);
  if (error) throw new Error(`Phase 3 discovery failed reading ${table}: ${error.message}`);
  const rows = data || [];
  if (rows.some((row) => row.user_id !== userId)) {
    throw new Error(`Phase 3 discovery returned a ${table} row outside user ${userId}`);
  }
  return rows;
}

/** Read-only Supabase adapter for the discovery boundary. It never mutates the database. */
export function createSupabaseDiscoveryReader(supabase: Phase3DiscoverySupabaseClient): Phase3DiscoveryReader {
  return {
    async listUserDrives(userId) {
      const rows = await readUserRows(
        supabase,
        'placement_drives',
        'id,user_id,company_id,drive_number,normalized_drive_number,drive_name,role,category,ctc,stipend,location,registration_deadline,identity_state',
        userId
      );
      return rows.map((row) => ({
        id: row.id as string,
        userId: row.user_id as string,
        companyId: row.company_id as string,
        normalizedDriveNumber: (row.normalized_drive_number as string | null) ?? null,
        identityState: row.identity_state as TenantDriveRecord['identityState'],
        ...(row.drive_number !== undefined ? { driveNumber: row.drive_number as string | null } : {}),
        ...(row.drive_name !== undefined ? { driveName: row.drive_name as string | null } : {}),
        ...(row.role !== undefined ? { role: row.role as string | null } : {}),
        ...(row.category !== undefined ? { category: row.category as string | null } : {}),
        ...(row.ctc !== undefined ? { ctc: row.ctc as string | null } : {}),
        ...(row.stipend !== undefined ? { stipend: row.stipend as string | null } : {}),
        ...(row.location !== undefined ? { location: row.location as string | null } : {}),
      }));
    },
    async listUserEmails(userId) {
      const rows = await readUserRows(
        supabase,
        'emails',
        'id,user_id,company_id,placement_drive_id,subject,body_snippet',
        userId
      );
      return rows.map((row) => ({
        id: row.id as string,
        userId: row.user_id as string,
        companyId: row.company_id as string | null,
        placementDriveId: row.placement_drive_id as string | null,
        subject: row.subject as string | null,
        bodySnippet: row.body_snippet as string | null,
      }));
    },
    async listUserApplications(userId) {
      const rows = await readUserRows(supabase, 'applications', 'id,user_id,company_id,placement_drive_id', userId);
      return rows.map((row) => ({
        id: row.id as string,
        userId: row.user_id as string,
        companyId: row.company_id as string,
        placementDriveId: row.placement_drive_id as string | null,
      }));
    },
    async listLegacyEvents(userId) {
      const rows = await readUserRows(supabase, 'events', 'id,user_id,company_id,placement_drive_id', userId);
      return rows.map((row) => ({
        id: row.id as string,
        userId: row.user_id as string,
        companyId: row.company_id as string,
        placementDriveId: row.placement_drive_id as string | null,
      }));
    },
    async listLegacyNotifications(userId) {
      const rows = await readUserRows(supabase, 'notifications', 'id,user_id,company_id,placement_drive_id', userId);
      return rows.map((row) => ({
        id: row.id as string,
        userId: row.user_id as string,
        companyId: row.company_id as string | null,
        placementDriveId: row.placement_drive_id as string | null,
      }));
    },
    async listLegacyCandidateMatches(userId) {
      const rows = await readUserRows(
        supabase,
        'candidate_matches',
        'id,user_id,email_id,application_id,placement_drive_id',
        userId
      );
      return rows.map((row) => ({
        id: row.id as string,
        userId: row.user_id as string,
        emailId: row.email_id as string | null,
        applicationId: row.application_id as string | null,
        placementDriveId: row.placement_drive_id as string | null,
      }));
    },
  };
}

/** Pure aggregation: turns raw rows into one `UserDiscoveryBundle`. No I/O. */
export function buildUserDiscoveryBundle(params: {
  userId: string;
  userDrives: TenantDriveRecord[];
  emails: EmailRow[];
  applications: ApplicationRow[];
  events: EventRow[];
  notifications: NotificationRow[];
  candidateMatches: CandidateMatchRow[];
}): UserDiscoveryBundle {
  const { userId } = params;

  const emailCompanyById = new Map<string, string | null>();
  const companyDiscoveredDriveNumbers = new Map<string, Array<string | null | undefined>>();
  for (const email of params.emails) {
    emailCompanyById.set(email.id, email.companyId);
    if (email.companyId) {
      const found = [
        ...extractAllDriveNumbers(email.subject || ''),
        ...extractAllDriveNumbers(email.bodySnippet || ''),
      ];
      const existing = companyDiscoveredDriveNumbers.get(email.companyId) || [];
      companyDiscoveredDriveNumbers.set(email.companyId, existing.concat(found));
    }
  }

  const applicationCompanyById = new Map<string, string>();
  for (const app of params.applications) {
    applicationCompanyById.set(app.id, app.companyId);
  }

  const legacyRecords: LegacyRecord[] = [];
  const unscopedRecords: UnscopedLegacyRecord[] = [];

  // Applications/events/notifications have no own drive evidence. Do not borrow
  // sibling email numbers at company scope: that would make a company with two
  // drives contaminate both opportunities. They remain unresolved unless a
  // future record-specific deterministic correlation is added.
  for (const app of params.applications) {
    if (app.placementDriveId) continue; // not a legacy record
    legacyRecords.push({
      recordType: 'application',
      id: app.id,
      userId: app.userId,
      companyId: app.companyId,
      placementDriveId: app.placementDriveId,
      ownDriveNumbers: [],
    });
  }

  for (const ev of params.events) {
    if (ev.placementDriveId) continue;
    legacyRecords.push({
      recordType: 'event',
      id: ev.id,
      userId: ev.userId,
      companyId: ev.companyId,
      placementDriveId: ev.placementDriveId,
      ownDriveNumbers: [],
    });
  }

  for (const n of params.notifications) {
    if (n.placementDriveId) continue;
    if (!n.companyId) {
      unscopedRecords.push({
        recordType: 'notification',
        recordId: n.id,
        userId: n.userId,
        reason: 'notification has no company_id; tenant scope cannot be determined',
      });
      continue;
    }
    legacyRecords.push({
      recordType: 'notification',
      id: n.id,
      userId: n.userId,
      companyId: n.companyId,
      placementDriveId: n.placementDriveId,
      ownDriveNumbers: [],
    });
  }

  for (const email of params.emails) {
    if (email.placementDriveId) continue;
    if (!email.companyId) {
      unscopedRecords.push({
        recordType: 'email',
        recordId: email.id,
        userId: email.userId,
        reason: 'email has no company_id; tenant scope cannot be determined',
      });
      continue;
    }
    legacyRecords.push({
      recordType: 'email',
      id: email.id,
      userId: email.userId,
      companyId: email.companyId,
      placementDriveId: email.placementDriveId,
      ownDriveNumbers: [
        ...extractAllDriveNumbers(email.subject || ''),
        ...extractAllDriveNumbers(email.bodySnippet || ''),
      ],
      metadata: extractDriveMetadata(`${email.subject || ''}\n${email.bodySnippet || ''}`),
    });
  }

  for (const cm of params.candidateMatches) {
    if (cm.placementDriveId) continue;
    // candidate_matches has no company_id column of its own — its tenant scope must be
    // resolved via the application or email it's evidence for. Never guessed, never defaulted.
    const companyId =
      (cm.applicationId && applicationCompanyById.get(cm.applicationId)) ||
      (cm.emailId && emailCompanyById.get(cm.emailId)) ||
      null;

    if (!companyId) {
      unscopedRecords.push({
        recordType: 'candidate_match',
        recordId: cm.id,
        userId: cm.userId,
        reason:
          'candidate_match has no resolvable company via application_id or email_id; tenant scope cannot be determined',
      });
      continue;
    }

    const sourceEmail = cm.emailId
      ? params.emails.find((candidate) => candidate.id === cm.emailId)
      : undefined;
    legacyRecords.push({
      recordType: 'candidate_match',
      id: cm.id,
      userId: cm.userId,
      companyId,
      placementDriveId: cm.placementDriveId,
      ownDriveNumbers: sourceEmail
        ? [
            ...extractAllDriveNumbers(sourceEmail.subject || ''),
            ...extractAllDriveNumbers(sourceEmail.bodySnippet || ''),
          ]
        : [],
      metadata: sourceEmail
        ? extractDriveMetadata(`${sourceEmail.subject || ''}\n${sourceEmail.bodySnippet || ''}`)
        : undefined,
    });
  }

  return {
    userId,
    userDrives: params.userDrives,
    companyDiscoveredDriveNumbers,
    legacyRecords,
    unscopedRecords,
  };
}

function extractDriveMetadata(text: string): DriveMetadata {
  const details = extractJobDetails(text);
  return {
    role: details.role,
    category: details.category,
    ctc: details.ctc,
    stipend: details.stipend,
    location: details.location,
  };
}

/** I/O: fetches one user's raw rows via the injected reader and assembles the bundle. */
export async function discoverUserData(
  reader: Phase3DiscoveryReader,
  userId: string
): Promise<UserDiscoveryBundle> {
  const [userDrives, emails, applications, events, notifications, candidateMatches] =
    await Promise.all([
      reader.listUserDrives(userId),
      reader.listUserEmails(userId),
      reader.listUserApplications(userId),
      reader.listLegacyEvents(userId),
      reader.listLegacyNotifications(userId),
      reader.listLegacyCandidateMatches(userId),
    ]);

  return buildUserDiscoveryBundle({
    userId,
    userDrives,
    emails,
    applications,
    events,
    notifications,
    candidateMatches,
  });
}
