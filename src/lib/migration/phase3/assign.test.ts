import { describe, expect, it } from 'vitest';
import { buildRpcActions } from './assign';
import { TenantBoundaryViolation } from './tenant-guard';
import type { PlannedAction } from './plan-run';

const USER_A = 'user-a';
const COMPANY_1 = 'company-1';
const REAL_UUID = '123e4567-e89b-42d3-a456-426614174000';

describe('buildRpcActions', () => {
  it('includes assign_existing_drive actions with the record type attached', () => {
    const actions: PlannedAction[] = [
      {
        recordType: 'application',
        action: { action: 'assign_existing_drive', scope: { userId: USER_A, companyId: COMPANY_1 }, recordId: 'app-1', driveId: REAL_UUID },
      },
    ];
    expect(buildRpcActions(actions)).toEqual([
      {
        action: 'assign_existing_drive',
        record_type: 'application',
        record_id: 'app-1',
        user_id: USER_A,

        drive_id: REAL_UUID,
      },
    ]);
  });

  it('includes create_drive_then_assign actions with the record type attached', () => {
    const actions: PlannedAction[] = [
      {
        recordType: 'email',
        action: {
          action: 'create_drive_then_assign',
          scope: { userId: USER_A, companyId: COMPANY_1 },
          recordId: 'email-1',
          normalizedDriveNumber: 'r9',
        },
      },
    ];
    expect(buildRpcActions(actions)).toEqual([
      {
        action: 'create_drive_then_assign',
        record_type: 'email',
        record_id: 'email-1',
        user_id: USER_A,

        normalized_drive_number: 'r9',
      },
    ]);
  });

  it('never emits an RPC action for skip_already_migrated, defer_ambiguous, defer_conflict, or skip_unresolved', () => {
    const scope = { userId: USER_A, companyId: COMPANY_1 };
    const actions: PlannedAction[] = [
      { recordType: 'application', action: { action: 'skip_already_migrated', scope, recordId: 'a', existingDriveId: 'd' } },
      { recordType: 'event', action: { action: 'defer_ambiguous', scope, recordId: 'b', reason: 'x' } },
      { recordType: 'notification', action: { action: 'defer_conflict', scope, recordId: 'c', reason: 'x' } },
      { recordType: 'candidate_match', action: { action: 'skip_unresolved', scope, recordId: 'd' } },
    ];
    expect(buildRpcActions(actions)).toEqual([]);
  });

  it('rejects a fabricated/placeholder drive UUID instead of emitting an RPC action', () => {
    const actions: PlannedAction[] = [
      {
        recordType: 'application',
        action: {
          action: 'assign_existing_drive',
          scope: { userId: USER_A, companyId: COMPANY_1 },
          recordId: 'app-1',
          driveId: '00000000-0000-0000-0000-000000000000',
        },
      },
    ];
    expect(() => buildRpcActions(actions)).toThrow(TenantBoundaryViolation);
  });

  it('preserves action order and handles a mixed batch', () => {
    const scope = { userId: USER_A, companyId: COMPANY_1 };
    const actions: PlannedAction[] = [
      { recordType: 'application', action: { action: 'skip_unresolved', scope, recordId: 'a' } },
      { recordType: 'event', action: { action: 'assign_existing_drive', scope, recordId: 'b', driveId: REAL_UUID } },
    ];
    const rpcActions = buildRpcActions(actions);
    expect(rpcActions).toHaveLength(1);
    expect(rpcActions[0].record_id).toBe('b');
  });
});
