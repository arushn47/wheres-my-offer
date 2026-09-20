/**
 * Phase 3 PLAN orchestration — the pure glue between DISCOVERY and PLAN.
 *
 * Turns one user's `UserDiscoveryBundle` into one `DrivePlanAction` per legacy record, by
 * feeding each record's evidence through `classifyDriveEvidence` (RESOLUTION) and then
 * `planRecordAction` (PLAN). Still pure — no I/O, no Supabase client — so the whole
 * DISCOVERY-input -> PLAN-output pipeline can be exercised deterministically in tests without
 * a database.
 */

import { classifyDriveEvidence } from './resolve-drive';
import { planRecordAction } from './plan';
import type { LegacyRecord, UnscopedLegacyRecord, UserDiscoveryBundle } from './discovery';
import type { DrivePlanAction } from './plan';
import type { MigratableRecordType } from './types';

export interface PlannedAction {
  recordType: MigratableRecordType;
  action: DrivePlanAction;
}

export interface UserMigrationPlan {
  userId: string;
  plannedActions: PlannedAction[];
  /** Records that could never be scoped to a tenant at all (see discovery.ts) — always a no-op. */
  unscoped: UnscopedLegacyRecord[];
}

/** Plans one legacy record. Exported standalone so tests can target a single record cheaply. */
export function planLegacyRecord(params: {
  record: LegacyRecord;
  userDrives: UserDiscoveryBundle['userDrives'];
}): PlannedAction {
  const scope = { userId: params.record.userId, companyId: params.record.companyId };
  const outcome = classifyDriveEvidence({
    scope,
    ownDriveNumbers: params.record.ownDriveNumbers,
    userDrives: params.userDrives,
  });
  const action = planRecordAction({
    scope,
    record: {
      id: params.record.id,
      userId: params.record.userId,
      companyId: params.record.companyId,
      placementDriveId: params.record.placementDriveId,
    },
    outcome,
    metadata: params.record.metadata,
  });
  return { recordType: params.record.recordType, action };
}

/** Plans every legacy record in a discovery bundle. Deterministic: same bundle in, same
 *  plan out, every time — required for idempotent reruns and for dry-run/execute parity. */
export function planUserMigration(bundle: UserDiscoveryBundle): UserMigrationPlan {
  return {
    userId: bundle.userId,
    plannedActions: bundle.legacyRecords.map((record) =>
      planLegacyRecord({ record, userDrives: bundle.userDrives })
    ),
    unscoped: bundle.unscopedRecords,
  };
}
