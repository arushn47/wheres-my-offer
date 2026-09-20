/**
 * Phase 3 ASSIGNMENT step.
 *
 * Pure planning only — no I/O. Converts the subset of `PlannedAction`s that actually require a
 * database write (`assign_existing_drive`, `create_drive_then_assign`) into the JSON-serializable
 * action list sent, once per user, to the `phase3_apply_user_actions` Postgres function.
 *
 * `skip_already_migrated`, `defer_ambiguous`, `defer_conflict`, and `skip_unresolved` are
 * intentionally excluded here — they never reach SQL. They are counted in the report
 * (see report.ts) but literally never appear in the payload sent to the database, so there is
 * no code path by which "no evidence" or "ambiguous evidence" can accidentally turn into a
 * write, even inside the SQL function.
 */

import { assertRealDatabaseUuid } from './tenant-guard';
import type { PlannedAction } from './plan-run';

export type RpcActionType = 'assign_existing_drive' | 'create_drive_then_assign';

export interface AssignExistingDriveRpcAction {
  action: 'assign_existing_drive';
  record_type: PlannedAction['recordType'];
  record_id: string;
  user_id: string;

  drive_id: string;
  metadata?: import('./types').DriveMetadata;
}

export interface CreateDriveThenAssignRpcAction {
  action: 'create_drive_then_assign';
  record_type: PlannedAction['recordType'];
  record_id: string;
  user_id: string;

  normalized_drive_number: string;
  metadata?: import('./types').DriveMetadata;
}

export type RpcAction = AssignExistingDriveRpcAction | CreateDriveThenAssignRpcAction;

/**
 * Builds the write-eligible RPC action list for one user. Every `drive_id` is re-validated as a
 * real database UUID here (defense in depth — `planRecordAction` already enforced this once,
 * but a fabricated/placeholder id must never reach SQL even if a future refactor removes that
 * earlier check).
 */
export function buildRpcActions(plannedActions: PlannedAction[]): RpcAction[] {
  const rpcActions: RpcAction[] = [];

  for (const { recordType, action } of plannedActions) {
    switch (action.action) {
      case 'assign_existing_drive':
        assertRealDatabaseUuid(action.driveId, `assign action for ${recordType} ${action.recordId}`);
        rpcActions.push({
          action: 'assign_existing_drive',
          record_type: recordType,
          record_id: action.recordId,
          user_id: action.scope.userId,

           drive_id: action.driveId,
           ...(action.metadata ? { metadata: action.metadata } : {}),
        });
        break;
      case 'create_drive_then_assign':
        rpcActions.push({
          action: 'create_drive_then_assign',
          record_type: recordType,
          record_id: action.recordId,
          user_id: action.scope.userId,

           normalized_drive_number: action.normalizedDriveNumber,
           ...(action.metadata ? { metadata: action.metadata } : {}),
        });
        break;
      case 'skip_already_migrated':
      case 'defer_ambiguous':
      case 'defer_conflict':
      case 'skip_unresolved':
        // Never reaches SQL. Intentionally no default branch below: if `plan.ts` ever grows a
        // new action kind, this switch fails to compile instead of silently shipping it to SQL.
        break;
      default: {
        const _exhaustive: never = action;
        throw new Error(`Unhandled plan action: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  return rpcActions;
}
