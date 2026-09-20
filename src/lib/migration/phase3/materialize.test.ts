import { describe, expect, it } from 'vitest';
import { planDriveCreations } from './materialize';
import { TenantBoundaryViolation } from './tenant-guard';
import type { PlannedAction } from './plan-run';

const USER_A = 'user-a';
const COMPANY_1 = 'company-1';
const COMPANY_2 = 'company-2';

function createAction(recordId: string, normalizedDriveNumber: string, companyId = COMPANY_1): PlannedAction {
  return {
    recordType: 'application',
    action: {
      action: 'create_drive_then_assign',
      scope: { userId: USER_A, companyId },
      recordId,
      normalizedDriveNumber,
    },
  };
}

function nonCreateAction(): PlannedAction {
  return {
    recordType: 'event',
    action: { action: 'skip_unresolved', scope: { userId: USER_A, companyId: COMPANY_1 }, recordId: 'ev-1' },
  };
}

describe('planDriveCreations', () => {
  it('returns one creation request per distinct (user, normalized_drive_number)', () => {
    const actions = [createAction('app-1', 'r1'), createAction('ev-1', 'r1'), createAction('app-2', 'r2')];
    const requests = planDriveCreations(actions);
    expect(requests).toHaveLength(2);
    expect(requests).toContainEqual({ userId: USER_A, companyId: COMPANY_1, normalizedDriveNumber: 'r1' });
    expect(requests).toContainEqual({ userId: USER_A, companyId: COMPANY_1, normalizedDriveNumber: 'r2' });
  });

  it('ignores actions that are not create_drive_then_assign', () => {
    const requests = planDriveCreations([nonCreateAction()]);
    expect(requests).toEqual([]);
  });

  it('is deterministic across repeated calls with the same input', () => {
    const actions = [createAction('app-1', 'r1'), createAction('app-2', 'r2')];
    expect(planDriveCreations(actions)).toEqual(planDriveCreations(actions));
  });

  it('throws instead of silently picking a company when two actions disagree about who owns a new drive number', () => {
    const actions = [createAction('app-1', 'r1', COMPANY_1), createAction('app-2', 'r1', COMPANY_2)];
    expect(() => planDriveCreations(actions)).toThrow(TenantBoundaryViolation);
  });

  it('returns an empty array for an empty input', () => {
    expect(planDriveCreations([])).toEqual([]);
  });
});
