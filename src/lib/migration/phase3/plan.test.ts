import { describe, expect, it } from 'vitest';
import { planBatchAction, planRecordAction } from './plan';
import { TenantBoundaryViolation } from './tenant-guard';
import type { DriveEvidenceOutcome, TenantScope } from './types';

const scope: TenantScope = { userId: 'user-a', companyId: 'company-1' };
const REAL_UUID = '123e4567-e89b-42d3-a456-426614174000';

describe('planRecordAction — idempotency / reruns / already-migrated records', () => {
  it('skips a record that already has a placement_drive_id, regardless of the (re-)resolved outcome', () => {
    const outcome: DriveEvidenceOutcome = { state: 'proven_new_drive_candidate', normalizedDriveNumber: 'r9' };
    const action = planRecordAction({
      scope,
      record: { id: 'app-1', userId: scope.userId, companyId: scope.companyId, placementDriveId: 'existing-drive' },
      outcome,
    });
    expect(action).toEqual({
      action: 'skip_already_migrated',
      scope,
      recordId: 'app-1',
      existingDriveId: 'existing-drive',
    });
  });

  it('produces the same plan across repeated runs for an untouched record (deterministic/idempotent)', () => {
    const outcome: DriveEvidenceOutcome = { state: 'proven_existing_drive', driveId: REAL_UUID, normalizedDriveNumber: 'r1' };
    const record = { id: 'app-1', userId: scope.userId, companyId: scope.companyId, placementDriveId: null };
    const run1 = planRecordAction({ scope, record, outcome });
    const run2 = planRecordAction({ scope, record, outcome });
    expect(run1).toEqual(run2);
    expect(run1).toEqual({ action: 'assign_existing_drive', scope, recordId: 'app-1', driveId: REAL_UUID });
  });
});

describe('planRecordAction — one action per outcome state', () => {
  const record = { id: 'rec-1', userId: scope.userId, companyId: scope.companyId, placementDriveId: null };

  it('assign_existing_drive for proven_existing_drive', () => {
    const outcome: DriveEvidenceOutcome = { state: 'proven_existing_drive', driveId: REAL_UUID, normalizedDriveNumber: 'r1' };
    expect(planRecordAction({ scope, record, outcome })).toEqual({
      action: 'assign_existing_drive',
      scope,
      recordId: 'rec-1',
      driveId: REAL_UUID,
    });
  });

  it('rejects a fabricated/placeholder UUID instead of planning an assignment', () => {
    const outcome: DriveEvidenceOutcome = {
      state: 'proven_existing_drive',
      driveId: '00000000-0000-0000-0000-000000000000',
      normalizedDriveNumber: 'r1',
    };
    expect(() => planRecordAction({ scope, record, outcome })).toThrow(TenantBoundaryViolation);
  });

  it('create_drive_then_assign for proven_new_drive_candidate', () => {
    const outcome: DriveEvidenceOutcome = { state: 'proven_new_drive_candidate', normalizedDriveNumber: 'r9' };
    expect(planRecordAction({ scope, record, outcome })).toEqual({
      action: 'create_drive_then_assign',
      scope,
      recordId: 'rec-1',
      normalizedDriveNumber: 'r9',
    });
  });

  it('defer_ambiguous for ambiguous', () => {
    const outcome: DriveEvidenceOutcome = { state: 'ambiguous', normalizedDriveNumbers: ['r1', 'r2'] };
    const action = planRecordAction({ scope, record, outcome });
    expect(action.action).toBe('defer_ambiguous');
  });

  it('defer_conflict for conflict', () => {
    const outcome: DriveEvidenceOutcome = { state: 'conflict', reason: 'because' };
    const action = planRecordAction({ scope, record, outcome });
    expect(action).toEqual({ action: 'defer_conflict', scope, recordId: 'rec-1', reason: 'because' });
  });

  it('skip_unresolved for unresolved', () => {
    const outcome: DriveEvidenceOutcome = { state: 'unresolved' };
    expect(planRecordAction({ scope, record, outcome })).toEqual({
      action: 'skip_unresolved',
      scope,
      recordId: 'rec-1',
    });
  });
});

describe('planRecordAction — tenant isolation', () => {
  it('throws instead of planning an action for a record owned by a different user', () => {
    const outcome: DriveEvidenceOutcome = { state: 'proven_existing_drive', driveId: REAL_UUID, normalizedDriveNumber: 'r1' };
    expect(() =>
      planRecordAction({
        scope,
        record: { id: 'rec-1', userId: 'someone-else', companyId: scope.companyId, placementDriveId: null },
        outcome,
      })
    ).toThrow(TenantBoundaryViolation);
  });

  it('throws instead of planning an action for a record owned by a different company', () => {
    const outcome: DriveEvidenceOutcome = { state: 'proven_existing_drive', driveId: REAL_UUID, normalizedDriveNumber: 'r1' };
    expect(() =>
      planRecordAction({
        scope,
        record: { id: 'rec-1', userId: scope.userId, companyId: 'some-other-company', placementDriveId: null },
        outcome,
      })
    ).toThrow(TenantBoundaryViolation);
  });
});

describe('planBatchAction', () => {
  it('plans one action per record and skips already-migrated ones within the same batch', () => {
    const outcome: DriveEvidenceOutcome = { state: 'proven_existing_drive', driveId: REAL_UUID, normalizedDriveNumber: 'r1' };
    const actions = planBatchAction({
      scope,
      records: [
        { id: 'rec-1', userId: scope.userId, companyId: scope.companyId, placementDriveId: null },
        { id: 'rec-2', userId: scope.userId, companyId: scope.companyId, placementDriveId: 'already' },
      ],
      outcome,
    });
    expect(actions).toEqual([
      { action: 'assign_existing_drive', scope, recordId: 'rec-1', driveId: REAL_UUID },
      { action: 'skip_already_migrated', scope, recordId: 'rec-2', existingDriveId: 'already' },
    ]);
  });
});
