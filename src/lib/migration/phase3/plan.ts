/**
 * Phase 3 PLAN step.
 *
 * Pure functions only — no Supabase client, no I/O. Turns one record's RESOLUTION outcome
 * (`DriveEvidenceOutcome`) into exactly one deterministic, idempotent action. MATERIALIZATION
 * (creating a real placement_drives row when needed) and ASSIGNMENT (writing placement_drive_id
 * onto the dependent record) are downstream I/O steps that must execute *only* the action this
 * step describes — they must never re-derive or second-guess identity themselves.
 *
 * Every branch of `DriveEvidenceOutcome` is handled explicitly (enforced by TypeScript
 * exhaustiveness below); there is no default "assign anyway" fallthrough.
 */

import type { DriveEvidenceOutcome, DriveMetadata, TenantScope } from './types';
import { assertRealDatabaseUuid, assertRecordBelongsToTenant } from './tenant-guard';

/** The minimal shape of a dependent record (application/event/notification/email/candidate_match). */
export interface MigratableRecord {
  id: string;
  userId: string;
  companyId?: string | null;
  /** The record's current placement_drive_id, if any. Required for idempotency. */
  placementDriveId?: string | null;
}

export type DrivePlanAction =
  /**
   * The record already has a placement_drive_id. Phase 3 backfills NULL drive identity; it must
   * never overwrite or "correct" an already-assigned record. Re-deriving a different answer for
   * an already-migrated row (e.g. because more drives were discovered on a later run) is a data
   * *repair* concern, not a backfill concern, and must go through an explicit, separately
   * reviewed path — never silently, as a side effect of re-running this migration.
   */
  | { action: 'skip_already_migrated'; scope: TenantScope; recordId: string; existingDriveId: string }
  /** A real, existing placement_drives row was proven. Safe to assign directly. */
  | { action: 'assign_existing_drive'; scope: TenantScope; recordId: string; driveId: string; metadata?: DriveMetadata }
  /**
   * Exactly one new drive number was proven with no existing row for it. MATERIALIZATION must
   * INSERT a real placement_drives row (letting Postgres generate the UUID and enforce the
   * unique index) before ASSIGNMENT may run; this plan action never carries a fabricated id.
   */
  | { action: 'create_drive_then_assign'; scope: TenantScope; recordId: string; normalizedDriveNumber: string; metadata?: DriveMetadata }
  /** Two or more distinct drives are implicated. Never auto-resolve; needs human review. */
  | { action: 'defer_ambiguous'; scope: TenantScope; recordId: string; reason: string }
  /** Evidence contradicts itself or an existing tenant boundary. Never auto-resolve. */
  | { action: 'defer_conflict'; scope: TenantScope; recordId: string; reason: string }
  /** No usable evidence. Leave the record as a legacy (company-only) record. */
  | { action: 'skip_unresolved'; scope: TenantScope; recordId: string };

export interface PlanRecordActionParams {
  scope: TenantScope;
  record: MigratableRecord;
  outcome: DriveEvidenceOutcome;
  metadata?: DriveMetadata;
}

/**
 * Plans exactly one action for one record. Idempotency is checked first and unconditionally:
 * an already-migrated record is skipped before its RESOLUTION outcome is even consulted, so a
 * changed outcome across reruns (e.g. a newly discovered drive) can never mutate a record that
 * was already assigned by a previous run.
 */
export function planRecordAction(params: PlanRecordActionParams): DrivePlanAction {
  assertRecordBelongsToTenant(params.record, params.scope);

  if (params.record.placementDriveId) {
    return {
      action: 'skip_already_migrated',
      scope: params.scope,
      recordId: params.record.id,
      existingDriveId: params.record.placementDriveId,
    };
  }

  const { outcome } = params;
  switch (outcome.state) {
    case 'proven_existing_drive':
      assertRealDatabaseUuid(outcome.driveId, `plan for record ${params.record.id}`);
      return {
        action: 'assign_existing_drive',
        scope: params.scope,
        recordId: params.record.id,
        driveId: outcome.driveId,
        ...(params.metadata ? { metadata: params.metadata } : {}),
      };
    case 'proven_new_drive_candidate':
      return {
        action: 'create_drive_then_assign',
        scope: params.scope,
        recordId: params.record.id,
        normalizedDriveNumber: outcome.normalizedDriveNumber,
        ...(params.metadata ? { metadata: params.metadata } : {}),
      };
    case 'ambiguous':
      return {
        action: 'defer_ambiguous',
        scope: params.scope,
        recordId: params.record.id,
        reason: `Ambiguous among ${outcome.normalizedDriveNumbers.length} drives: ${outcome.normalizedDriveNumbers.join(', ')}`,
      };
    case 'conflict':
      return {
        action: 'defer_conflict',
        scope: params.scope,
        recordId: params.record.id,
        reason: outcome.reason,
      };
    case 'unresolved':
      return { action: 'skip_unresolved', scope: params.scope, recordId: params.record.id };
    default: {
      // Exhaustiveness guard: if DriveEvidenceOutcome ever gains a new state, this fails to
      // compile instead of silently falling through to an unsafe default action.
      const _exhaustive: never = outcome;
      throw new Error(`Unhandled drive evidence outcome: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Plans actions for a batch of records that all share the same resolved outcome. */
export function planBatchAction(params: {
  scope: TenantScope;
  records: MigratableRecord[];
  outcome: DriveEvidenceOutcome;
}): DrivePlanAction[] {
  return params.records.map((record) =>
    planRecordAction({ scope: params.scope, record, outcome: params.outcome })
  );
}
