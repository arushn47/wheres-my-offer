/**
 * Phase 3 legacy-drive migration: shared types.
 *
 * These types describe the DISCOVERY -> RESOLUTION -> PLAN -> MATERIALIZATION ->
 * ASSIGNMENT -> VALIDATION -> EXECUTION pipeline for backfilling `placement_drive_id`
 * onto legacy (company-only) records.
 *
 * Nothing in this file talks to a database. It only defines the shapes that let the
 * rest of the pipeline reason about tenant-scoped drive identity safely.
 */

/**
 * A placement_drives row, trimmed to the fields the resolver needs.
 * Every drive is intrinsically owned by exactly one (userId, companyId) tenant pair —
 * that ownership is enforced by the `placement_drives_user_id_fkey` /
 * `placement_drives_company_id_fkey` foreign keys and is never inferred.
 */
export interface TenantDriveRecord {
  id: string;
  userId: string;
  companyId: string;
  normalizedDriveNumber: string | null;
  driveNumber?: string | null;
  driveName?: string | null;
  role?: string | null;
  category?: string | null;
  ctc?: string | null;
  stipend?: string | null;
  location?: string | null;
  identityState:
    | 'assigned'
    | 'ambiguous'
    | 'unassigned'
    | 'legacy'
    | 'conflict'
    | 'manually_assigned';
}

/**
 * The explicit, exhaustive set of classification outcomes a piece of evidence can resolve to.
 * Nothing outside this union is a valid resolution state — this is intentional so that every
 * caller must handle every case instead of falling through to a default "assign anyway".
 */
export type DriveEvidenceOutcome =
  /** Evidence maps to exactly one drive number, and that drive already exists for this tenant. */
  | { state: 'proven_existing_drive'; driveId: string; normalizedDriveNumber: string }
  /**
   * Evidence maps to exactly one drive number, but no placement_drives row exists yet for this
   * tenant. A real row MUST be created (with a database-generated UUID) before any dependent
   * record may be assigned. This is a candidate, never a usable ID.
   */
  | { state: 'proven_new_drive_candidate'; normalizedDriveNumber: string }
  /** Two or more distinct, mutually exclusive drive numbers are implicated. Never auto-resolve. */
  | { state: 'ambiguous'; normalizedDriveNumbers: string[] }
  /** The evidence is internally contradictory, or contradicts an existing drive's tenant scope. */
  | { state: 'conflict'; reason: string }
  /** No usable evidence exists at all. */
  | { state: 'unresolved' };

export type DriveEvidenceState = DriveEvidenceOutcome['state'];

/** Canonical, exhaustive list — used by tests/exhaustiveness checks. */
export const DRIVE_EVIDENCE_STATES: DriveEvidenceState[] = [
  'proven_existing_drive',
  'proven_new_drive_candidate',
  'ambiguous',
  'conflict',
  'unresolved',
];

export interface TenantScope {
  userId: string;
  companyId: string;
}

export interface DriveMetadata {
  driveNumber?: string | null;
  driveName?: string | null;
  role?: string | null;
  category?: string | null;
  ctc?: string | null;
  stipend?: string | null;
  location?: string | null;
  registrationDeadline?: string | null;
}

/**
 * The five dependent-record tables Phase 3 can backfill `placement_drive_id` onto.
 * Kept as an exhaustive union (not a bare `string`) so every downstream switch/map that
 * branches on record type is checked by the compiler instead of silently ignoring a typo.
 */
export type MigratableRecordType =
  | 'application'
  | 'event'
  | 'candidate_match'
  | 'notification'
  | 'email';

export const MIGRATABLE_RECORD_TYPES: MigratableRecordType[] = [
  'application',
  'event',
  'candidate_match',
  'notification',
  'email',
];
