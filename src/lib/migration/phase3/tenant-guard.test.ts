import { describe, expect, it } from 'vitest';
import {
  assertDrivesBelongToTenant,
  assertDrivesBelongToUser,
  assertRealDatabaseUuid,
  assertRecordBelongsToTenant,
  TenantBoundaryViolation,
} from './tenant-guard';
import type { TenantDriveRecord, TenantScope } from './types';

const USER_A = 'user-a';
const USER_B = 'user-b';
const COMPANY_1 = 'company-1';
const COMPANY_2 = 'company-2';
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

describe('assertDrivesBelongToTenant', () => {
  it('passes silently when every drive matches (user_id, company_id)', () => {
    expect(() => assertDrivesBelongToTenant([drive({ id: 'd1' })], scope)).not.toThrow();
  });

  it('throws when a drive belongs to a different user', () => {
    expect(() =>
      assertDrivesBelongToTenant([drive({ id: 'd1', userId: USER_B })], scope)
    ).toThrow(TenantBoundaryViolation);
  });

  it('throws when a drive belongs to a different company for the same user', () => {
    expect(() =>
      assertDrivesBelongToTenant([drive({ id: 'd1', companyId: COMPANY_2 })], scope)
    ).toThrow(TenantBoundaryViolation);
  });
});

describe('assertDrivesBelongToUser', () => {
  it('passes for drives across multiple companies, as long as the user matches', () => {
    expect(() =>
      assertDrivesBelongToUser(
        [drive({ id: 'd1', companyId: COMPANY_1 }), drive({ id: 'd2', companyId: COMPANY_2 })],
        USER_A
      )
    ).not.toThrow();
  });

  it('throws when any drive belongs to a different user', () => {
    expect(() =>
      assertDrivesBelongToUser([drive({ id: 'd1', userId: USER_B })], USER_A)
    ).toThrow(TenantBoundaryViolation);
  });
});

describe('assertRecordBelongsToTenant', () => {
  it('passes when the record matches user and company', () => {
    expect(() =>
      assertRecordBelongsToTenant({ userId: USER_A, companyId: COMPANY_1 }, scope)
    ).not.toThrow();
  });

  it('allows a null companyId on the record (e.g. candidate_matches without a company)', () => {
    expect(() => assertRecordBelongsToTenant({ userId: USER_A, companyId: null }, scope)).not.toThrow();
  });

  it('throws for a foreign user', () => {
    expect(() =>
      assertRecordBelongsToTenant({ userId: USER_B, companyId: COMPANY_1 }, scope)
    ).toThrow(TenantBoundaryViolation);
  });

  it('throws for a mismatched company', () => {
    expect(() =>
      assertRecordBelongsToTenant({ userId: USER_A, companyId: COMPANY_2 }, scope)
    ).toThrow(TenantBoundaryViolation);
  });
});

describe('assertRealDatabaseUuid', () => {
  it('accepts a well-formed v4-shaped UUID', () => {
    expect(() => assertRealDatabaseUuid('123e4567-e89b-42d3-a456-426614174000', 'test')).not.toThrow();
  });

  it('rejects a non-UUID string', () => {
    expect(() => assertRealDatabaseUuid('not-a-uuid', 'test')).toThrow(TenantBoundaryViolation);
  });

  it('rejects the all-zero placeholder UUID', () => {
    expect(() => assertRealDatabaseUuid('00000000-0000-0000-0000-000000000000', 'test')).toThrow(
      TenantBoundaryViolation
    );
  });

  it('rejects the all-f placeholder UUID', () => {
    expect(() => assertRealDatabaseUuid('ffffffff-ffff-ffff-ffff-ffffffffffff', 'test')).toThrow(
      TenantBoundaryViolation
    );
  });
});
