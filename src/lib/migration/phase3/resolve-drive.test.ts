import { describe, expect, it } from 'vitest';
import {
  aggregateDiscoveredDriveNumbers,
  classifyDriveEvidence,
  normalizeDriveNumber,
} from './resolve-drive';
import { TenantBoundaryViolation } from './tenant-guard';
import type { TenantDriveRecord, TenantScope } from './types';

const USER_A = 'user-aaaaaaaa-0000-0000-0000-000000000001';
const USER_B = 'user-bbbbbbbb-0000-0000-0000-000000000002';
const COMPANY_1 = 'company-1111-0000-0000-0000-000000000001';
const COMPANY_2 = 'company-2222-0000-0000-0000-000000000002';

const scope: TenantScope = { userId: USER_A, companyId: COMPANY_1 };

function drive(overrides: Partial<TenantDriveRecord> & { id: string }): TenantDriveRecord {
  return {
    userId: USER_A,
    companyId: COMPANY_1,
    normalizedDriveNumber: null,
    identityState: 'assigned',
    ...overrides,
  };
}

describe('normalizeDriveNumber', () => {
  it('trims and lowercases', () => {
    expect(normalizeDriveNumber('  R1  ')).toBe('r1');
  });

  it('treats blank/whitespace-only strings as no evidence', () => {
    expect(normalizeDriveNumber('   ')).toBeNull();
    expect(normalizeDriveNumber('')).toBeNull();
  });

  it('treats null/undefined as no evidence', () => {
    expect(normalizeDriveNumber(null)).toBeNull();
    expect(normalizeDriveNumber(undefined)).toBeNull();
  });
});

describe('classifyDriveEvidence — exact / unique match', () => {
  it('resolves to the existing drive when the normalized number matches exactly one tenant drive', () => {
    const existing = drive({ id: 'drive-1', normalizedDriveNumber: 'r1' });
    const outcome = classifyDriveEvidence({
      scope,
      ownDriveNumbers: ['R1'],
      userDrives: [existing],
    });
    expect(outcome).toEqual({ state: 'proven_existing_drive', driveId: 'drive-1', normalizedDriveNumber: 'r1' });
  });

  it('is case- and whitespace-insensitive when matching an existing drive', () => {
    const existing = drive({ id: 'drive-1', normalizedDriveNumber: 'drive 2024-a' });
    const outcome = classifyDriveEvidence({
      scope,
      ownDriveNumbers: ['  Drive 2024-A  '],
      userDrives: [existing],
    });
    expect(outcome).toEqual({
      state: 'proven_existing_drive',
      driveId: 'drive-1',
      normalizedDriveNumber: 'drive 2024-a',
    });
  });

  it('deduplicates repeated identical evidence for the same record', () => {
    const outcome = classifyDriveEvidence({
      scope,
      ownDriveNumbers: ['R1', 'r1', ' R1 '],
      userDrives: [],
    });
    expect(outcome).toEqual({ state: 'proven_new_drive_candidate', normalizedDriveNumber: 'r1' });
  });
});

describe('classifyDriveEvidence — new drive candidate', () => {
  it('proves a new candidate when the number matches no existing drive anywhere for the user', () => {
    const outcome = classifyDriveEvidence({
      scope,
      ownDriveNumbers: ['R9'],
      userDrives: [drive({ id: 'drive-1', normalizedDriveNumber: 'r1' })],
    });
    expect(outcome).toEqual({ state: 'proven_new_drive_candidate', normalizedDriveNumber: 'r9' });
  });

  it('never returns a driveId for a new candidate (no fabricated UUIDs)', () => {
    const outcome = classifyDriveEvidence({ scope, ownDriveNumbers: ['R9'], userDrives: [] });
    expect(outcome.state).toBe('proven_new_drive_candidate');
    expect('driveId' in outcome).toBe(false);
  });
});

describe('classifyDriveEvidence — ambiguous', () => {
  it('is unresolved when a record has no own drive evidence, even if a company has multiple drives', () => {
    const outcome = classifyDriveEvidence({
      scope,
      ownDriveNumbers: [],
      userDrives: [
        drive({ id: 'drive-1', normalizedDriveNumber: 'r1', identityState: 'assigned' }),
        drive({ id: 'drive-2', normalizedDriveNumber: 'r2', identityState: 'manually_assigned' }),
      ],
    });
    expect(outcome).toEqual({ state: 'unresolved' });
  });

  it('does not infer a drive from a single confirmed company drive without own evidence', () => {
    const outcome = classifyDriveEvidence({
      scope,
      ownDriveNumbers: [],
      userDrives: [
        drive({ id: 'drive-1', normalizedDriveNumber: 'r1', identityState: 'assigned' }),
        drive({ id: 'drive-2', normalizedDriveNumber: 'r2', identityState: 'unassigned' }),
        drive({ id: 'drive-3', normalizedDriveNumber: 'r3', identityState: 'ambiguous' }),
        drive({ id: 'drive-4', normalizedDriveNumber: 'r4', identityState: 'conflict' }),
      ],
    });
    expect(outcome).toEqual({ state: 'unresolved' });
  });
});

describe('classifyDriveEvidence — missing evidence', () => {
  it('is unresolved when there is no own evidence and no confirmed company drive', () => {
    const outcome = classifyDriveEvidence({ scope, ownDriveNumbers: [], userDrives: [] });
    expect(outcome).toEqual({ state: 'unresolved' });
  });

  it('is unresolved when own evidence is present but entirely blank/invalid', () => {
    const outcome = classifyDriveEvidence({
      scope,
      ownDriveNumbers: [null, undefined, '   ', ''],
      userDrives: [],
    });
    expect(outcome).toEqual({ state: 'unresolved' });
  });
});

describe('classifyDriveEvidence — conflicting evidence on one record', () => {
  it('is a conflict when a single record implicates two distinct drive numbers', () => {
    const outcome = classifyDriveEvidence({
      scope,
      ownDriveNumbers: ['R1', 'R2'],
      userDrives: [],
    });
    expect(outcome.state).toBe('conflict');
    if (outcome.state === 'conflict') {
      expect(outcome.reason).toMatch(/mutually exclusive/i);
    }
  });
});

describe('classifyDriveEvidence — tenant isolation (the core fix)', () => {
  it('throws instead of classifying when a passed-in drive belongs to a different user', () => {
    const foreignDrive = drive({ id: 'drive-x', userId: USER_B, normalizedDriveNumber: 'r1' });
    expect(() =>
      classifyDriveEvidence({ scope, ownDriveNumbers: ['R1'], userDrives: [foreignDrive] })
    ).toThrow(TenantBoundaryViolation);
  });

  it('treats a same-numbered drive owned by a DIFFERENT company (same user) as a conflict, never a match', () => {
    // Regression test: drive numbers are unique per (user_id) globally, not per (user_id,
    // company_id) — see idx_placement_drives_user_drive_number. A same-numbered drive under a
    // different company for the same user must never be silently reused nor silently ignored.
    const otherCompanyDrive = drive({ id: 'drive-other', companyId: COMPANY_2, normalizedDriveNumber: 'r1' });
    const outcome = classifyDriveEvidence({
      scope,
      ownDriveNumbers: ['R1'],
      userDrives: [otherCompanyDrive],
    });
    expect(outcome.state).toBe('conflict');
    if (outcome.state === 'conflict') {
      expect(outcome.reason).toContain(COMPANY_2);
    }
  });

  it('never returns a driveId belonging to another company when flagging the cross-company conflict', () => {
    const otherCompanyDrive = drive({ id: 'drive-other', companyId: COMPANY_2, normalizedDriveNumber: 'r1' });
    const outcome = classifyDriveEvidence({ scope, ownDriveNumbers: ['R1'], userDrives: [otherCompanyDrive] });
    expect(outcome).not.toHaveProperty('driveId');
  });

  it('company-only fallback never considers drives from a different company for the same user', () => {
    const outcome = classifyDriveEvidence({
      scope,
      ownDriveNumbers: [],
      userDrives: [drive({ id: 'drive-other', companyId: COMPANY_2, identityState: 'assigned', normalizedDriveNumber: 'r1' })],
    });
    expect(outcome).toEqual({ state: 'unresolved' });
  });

  it('does not throw for a legitimate multi-company user roster as long as every drive is the caller-scoped user', () => {
    const sameUserOtherCompany = drive({ id: 'drive-other', companyId: COMPANY_2, normalizedDriveNumber: 'r9' });
    const outcome = classifyDriveEvidence({
      scope,
      ownDriveNumbers: ['R1'],
      userDrives: [sameUserOtherCompany],
    });
    // r1 evidence doesn't match r9 anywhere, and the other-company drive is irrelevant to it.
    expect(outcome).toEqual({ state: 'proven_new_drive_candidate', normalizedDriveNumber: 'r1' });
  });
});

describe('classifyDriveEvidence — duplicate drive rows (data integrity)', () => {
  it('refuses to guess when two drive rows already share the same normalized number for the user', () => {
    const dup1 = drive({ id: 'drive-1', normalizedDriveNumber: 'r1' });
    const dup2 = drive({ id: 'drive-2', companyId: COMPANY_2, normalizedDriveNumber: 'r1' });
    const outcome = classifyDriveEvidence({ scope, ownDriveNumbers: ['R1'], userDrives: [dup1, dup2] });
    expect(outcome.state).toBe('conflict');
    if (outcome.state === 'conflict') {
      expect(outcome.reason).toMatch(/data integrity/i);
      expect(outcome.reason).toContain('drive-1');
      expect(outcome.reason).toContain('drive-2');
    }
  });
});

describe('aggregateDiscoveredDriveNumbers', () => {
  it('unions and normalizes numbers discovered across many records, deduplicated', () => {
    const result = aggregateDiscoveredDriveNumbers([
      ['R1', null],
      ['r1', 'R2'],
      [undefined, '  R3  '],
      [''],
    ]);
    expect(result.sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('returns an empty array when nothing was discovered', () => {
    expect(aggregateDiscoveredDriveNumbers([[], [null, undefined, '']])).toEqual([]);
  });
});
