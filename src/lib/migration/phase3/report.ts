/**
 * Phase 3 reporting.
 *
 * Pure aggregation of PLAN output (+ optional EXECUTION results) into one JSON-serializable
 * summary. This is the typed replacement for the ad-hoc `phase3_*.json` artifacts produced by
 * earlier, unaudited scripts — every count here is derived directly from the same
 * `DrivePlanAction`s that were actually planned/executed, not recomputed separately.
 */

import type { MigratableRecordType } from './types';
import type { PlannedAction } from './plan-run';
import type { DriveCreationRequest } from './materialize';
import type { ApplyUserActionsResult } from './rpc-client';
import type { UnscopedLegacyRecord } from './discovery';
import type { PreflightResult } from './validate';

export interface ActionCounts {
  assign_existing_drive: number;
  create_drive_then_assign: number;
  skip_already_migrated: number;
  defer_ambiguous: number;
  defer_conflict: number;
  skip_unresolved: number;
}

const EMPTY_COUNTS = (): ActionCounts => ({
  assign_existing_drive: 0,
  create_drive_then_assign: 0,
  skip_already_migrated: 0,
  defer_ambiguous: 0,
  defer_conflict: 0,
  skip_unresolved: 0,
});

export type ActionCountsByRecordType = Record<MigratableRecordType, ActionCounts>;

export function summarizePlannedActions(plannedActions: PlannedAction[]): ActionCountsByRecordType {
  const byType: ActionCountsByRecordType = {
    application: EMPTY_COUNTS(),
    event: EMPTY_COUNTS(),
    candidate_match: EMPTY_COUNTS(),
    notification: EMPTY_COUNTS(),
    email: EMPTY_COUNTS(),
  };

  for (const { recordType, action } of plannedActions) {
    byType[recordType][action.action] += 1;
  }

  return byType;
}

export type UserRunOutcome =
  | { kind: 'dry_run' }
  | { kind: 'committed'; result: ApplyUserActionsResult }
  | { kind: 'rolled_back'; result: ApplyUserActionsResult }
  | { kind: 'skipped'; reason: string };

export interface PerUserReport {
  userId: string;
  outcome: UserRunOutcome;
  actionCounts: ActionCountsByRecordType;
  driveCreationRequests: DriveCreationRequest[];
  unscoped: UnscopedLegacyRecord[];
}

export function buildPerUserReport(params: {
  userId: string;
  plannedActions: PlannedAction[];
  driveCreationRequests: DriveCreationRequest[];
  unscoped: UnscopedLegacyRecord[];
  outcome: UserRunOutcome;
}): PerUserReport {
  return {
    userId: params.userId,
    outcome: params.outcome,
    actionCounts: summarizePlannedActions(params.plannedActions),
    driveCreationRequests: params.driveCreationRequests,
    unscoped: params.unscoped,
  };
}

export interface Phase3RunSummary {
  mode: 'dry-run' | 'execute';
  generatedAt: string;
  readOnly: boolean;
  preflight: PreflightResult;
  users: PerUserReport[];
  totals: {
    usersPlanned: number;
    usersCommitted: number;
    usersRolledBack: number;
    usersSkipped: number;
    distinctDrivesWouldCreateOrCreated: number;
    actionCounts: ActionCountsByRecordType;
  };
}

export function buildRunSummary(params: {
  mode: 'dry-run' | 'execute';
  preflight: PreflightResult;
  users: PerUserReport[];
  now?: () => string;
}): Phase3RunSummary {
  const now = params.now || (() => new Date().toISOString());

  const totalsActionCounts: ActionCountsByRecordType = {
    application: EMPTY_COUNTS(),
    event: EMPTY_COUNTS(),
    candidate_match: EMPTY_COUNTS(),
    notification: EMPTY_COUNTS(),
    email: EMPTY_COUNTS(),
  };
  let usersCommitted = 0;
  let usersRolledBack = 0;
  let usersSkipped = 0;
  const distinctDriveKeys = new Set<string>();

  for (const user of params.users) {
    for (const recordType of Object.keys(totalsActionCounts) as MigratableRecordType[]) {
      for (const key of Object.keys(EMPTY_COUNTS()) as (keyof ActionCounts)[]) {
        totalsActionCounts[recordType][key] += user.actionCounts[recordType][key];
      }
    }
    for (const req of user.driveCreationRequests) {
      distinctDriveKeys.add(`${req.userId}::${req.normalizedDriveNumber}`);
    }
    if (user.outcome.kind === 'committed') usersCommitted += 1;
    if (user.outcome.kind === 'rolled_back') usersRolledBack += 1;
    if (user.outcome.kind === 'skipped') usersSkipped += 1;
  }

  return {
    mode: params.mode,
    generatedAt: now(),
    readOnly: params.mode === 'dry-run',
    preflight: params.preflight,
    users: params.users,
    totals: {
      usersPlanned: params.users.length,
      usersCommitted,
      usersRolledBack,
      usersSkipped,
      distinctDrivesWouldCreateOrCreated: distinctDriveKeys.size,
      actionCounts: totalsActionCounts,
    },
  };
}
