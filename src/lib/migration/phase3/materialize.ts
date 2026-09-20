/**
 * Phase 3 MATERIALIZATION step.
 *
 * Pure planning only — no I/O. Collapses every `create_drive_then_assign` action for a user
 * into the deduplicated set of distinct placement_drives rows that actually need to be
 * inserted. The real INSERT happens server-side inside the `phase3_apply_user_actions`
 * Postgres function (see `supabase/migration_v13_phase3_functions.sql`) — this module exists so
 * that:
 *
 *   1. The report can say "N distinct drives would be created" instead of "N actions happened
 *      to be create_drive_then_assign" (several records can prove the same new drive).
 *   2. A caller bug that produced two actions for the same normalized drive number but
 *      DIFFERENT company ids is caught here, loudly, before it ever reaches SQL — this would
 *      otherwise be a silent cross-company identity bug (the DB's `ON CONFLICT
 *      (user_id, normalized_drive_number)` would just attach the second company's record to the
 *      first company's drive).
 *
 * The actual INSERT is idempotent regardless (`ON CONFLICT ... DO UPDATE ... RETURNING id`), so
 * this dedup is a determinism/efficiency/safety concern, not a correctness requirement of the
 * INSERT itself.
 */

import { TenantBoundaryViolation } from './tenant-guard';
import type { PlannedAction } from './plan-run';

export interface DriveCreationRequest {
  userId: string;
  companyId: string;
  normalizedDriveNumber: string;
}

/**
 * Extracts the deduplicated set of drives that must be created for one user's planned actions.
 * Throws `TenantBoundaryViolation` if two actions disagree about which company a given
 * (user_id, normalized_drive_number) belongs to — this must never be silently resolved.
 */
export function planDriveCreations(plannedActions: PlannedAction[]): DriveCreationRequest[] {
  const byKey = new Map<string, DriveCreationRequest>();

  for (const { action } of plannedActions) {
    if (action.action !== 'create_drive_then_assign') continue;

    const key = `${action.scope.userId}::${action.normalizedDriveNumber}`;
    const existing = byKey.get(key);
    if (existing && existing.companyId !== action.scope.companyId) {
      throw new TenantBoundaryViolation(
        `Conflicting drive-creation requests for user ${action.scope.userId}, drive number ` +
          `"${action.normalizedDriveNumber}": company ${existing.companyId} vs ` +
          `${action.scope.companyId}. Refusing to guess which company owns the new drive.`
      );
    }
    if (!existing) {
      byKey.set(key, {
        userId: action.scope.userId,
        companyId: action.scope.companyId,
        normalizedDriveNumber: action.normalizedDriveNumber,
      });
    }
  }

  return Array.from(byKey.values());
}
