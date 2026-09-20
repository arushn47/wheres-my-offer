import { describe, expect, it } from 'vitest';
import { planLegacyRecord, planUserMigration } from './plan-run';
import type { LegacyRecord, UserDiscoveryBundle } from './discovery';
import type { TenantDriveRecord } from './types';

const USER_A = 'user-a';
const COMPANY_1 = 'company-1';
const REAL_UUID = '123e4567-e89b-42d3-a456-426614174000';

function legacyRecord(overrides: Partial<LegacyRecord> & { id: string; recordType: LegacyRecord['recordType'] }): LegacyRecord {
  return {
    userId: USER_A,
    companyId: COMPANY_1,
    placementDriveId: null,
    ownDriveNumbers: [],
    ...overrides,
  };
}

describe('planLegacyRecord', () => {
  it('produces create_drive_then_assign when the record has unique explicit evidence and no existing drive matches', () => {
    const record = legacyRecord({ id: 'app-1', recordType: 'application', ownDriveNumbers: ['pat-pl-2026-1'] });
    const planned = planLegacyRecord({ record, userDrives: [] });
    expect(planned).toEqual({
      recordType: 'application',
      action: {
        action: 'create_drive_then_assign',
        scope: { userId: USER_A, companyId: COMPANY_1 },
        recordId: 'app-1',
        normalizedDriveNumber: 'pat-pl-2026-1',
      },
    });
  });

  it('keeps source-email drive metadata on the planned creation action', () => {
    const planned = planLegacyRecord({
      record: {
        id: 'email-a',
        recordType: 'email',
        userId: USER_A,
        companyId: COMPANY_1,
        placementDriveId: null,
        ownDriveNumbers: ['pat-pl-2026-1204'],
        metadata: { location: 'Bangalore / Noida', role: 'SDE', ctc: '12 LPA' },
      },
      userDrives: [],
    });

    expect(planned.action).toMatchObject({
      action: 'create_drive_then_assign',
      metadata: { location: 'Bangalore / Noida', role: 'SDE', ctc: '12 LPA' },
    });
  });

  it('keeps metadata isolated between two drive actions', () => {
    const first = planLegacyRecord({
      record: { id: 'email-a', recordType: 'email', userId: USER_A, companyId: COMPANY_1, placementDriveId: null, ownDriveNumbers: ['pat-pl-2026-1204'], metadata: { location: 'Bangalore' } },
      userDrives: [],
    });
    const second = planLegacyRecord({
      record: { id: 'email-b', recordType: 'email', userId: USER_A, companyId: COMPANY_1, placementDriveId: null, ownDriveNumbers: ['pat-pl-2026-1317'], metadata: { location: 'Noida' } },
      userDrives: [],
    });

    expect(first.action).toMatchObject({ metadata: { location: 'Bangalore' } });
    expect(second.action).toMatchObject({ metadata: { location: 'Noida' } });
  });

  it('produces assign_existing_drive when the evidence matches an existing tenant drive', () => {
    const drive: TenantDriveRecord = {
      id: REAL_UUID,
      userId: USER_A,
      companyId: COMPANY_1,
      normalizedDriveNumber: 'pat-pl-2026-1',
      identityState: 'assigned',
    };
    const record = legacyRecord({ id: 'app-1', recordType: 'application', ownDriveNumbers: ['pat-pl-2026-1'] });
    const planned = planLegacyRecord({ record, userDrives: [drive] });
    expect(planned.action).toEqual({
      action: 'assign_existing_drive',
      scope: { userId: USER_A, companyId: COMPANY_1 },
      recordId: 'app-1',
      driveId: REAL_UUID,
    });
  });

  it('leaves records without own drive evidence unresolved instead of guessing', () => {
    const drives: TenantDriveRecord[] = [
      { id: 'd1', userId: USER_A, companyId: COMPANY_1, normalizedDriveNumber: 'r1', identityState: 'assigned' },
      { id: 'd2', userId: USER_A, companyId: COMPANY_1, normalizedDriveNumber: 'r2', identityState: 'manually_assigned' },
    ];
    const record = legacyRecord({ id: 'app-1', recordType: 'application', ownDriveNumbers: [] });
    const planned = planLegacyRecord({ record, userDrives: drives });
    expect(planned.action.action).toBe('skip_unresolved');
  });

  it('skips a record that already has a placement_drive_id (idempotency), regardless of evidence', () => {
    const record = legacyRecord({
      id: 'app-1',
      recordType: 'application',
      placementDriveId: 'already-assigned',
      ownDriveNumbers: ['pat-pl-2026-1'],
    });
    const planned = planLegacyRecord({ record, userDrives: [] });
    expect(planned.action).toEqual({
      action: 'skip_already_migrated',
      scope: { userId: USER_A, companyId: COMPANY_1 },
      recordId: 'app-1',
      existingDriveId: 'already-assigned',
    });
  });
});

describe('planUserMigration', () => {
  function bundle(records: LegacyRecord[], userDrives: TenantDriveRecord[] = []): UserDiscoveryBundle {
    return {
      userId: USER_A,
      userDrives,
      companyDiscoveredDriveNumbers: new Map(),
      legacyRecords: records,
      unscopedRecords: [{ recordType: 'candidate_match', recordId: 'cm-orphan', userId: USER_A, reason: 'no company' }],
    };
  }

  it('plans one action per legacy record and carries unscoped records through untouched', () => {
    const records = [
      legacyRecord({ id: 'app-1', recordType: 'application', ownDriveNumbers: ['r1'] }),
      legacyRecord({ id: 'ev-1', recordType: 'event', ownDriveNumbers: [] }),
    ];
    const plan = planUserMigration(bundle(records));

    expect(plan.userId).toBe(USER_A);
    expect(plan.plannedActions).toHaveLength(2);
    expect(plan.plannedActions[0].recordType).toBe('application');
    expect(plan.plannedActions[1].recordType).toBe('event');
    expect(plan.plannedActions[1].action.action).toBe('skip_unresolved');
    expect(plan.unscoped).toEqual([{ recordType: 'candidate_match', recordId: 'cm-orphan', userId: USER_A, reason: 'no company' }]);
  });

  it('is deterministic: the same bundle produces an identical plan on repeated calls', () => {
    const records = [legacyRecord({ id: 'app-1', recordType: 'application', ownDriveNumbers: ['r1'] })];
    const b = bundle(records);
    expect(planUserMigration(b)).toEqual(planUserMigration(b));
  });
});
