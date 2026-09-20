/**
 * Phase 3 tenant boundary invariants.
 *
 * Tenant isolation is treated as a security invariant, not a migration convenience.
 * Every function here is pure and throws loudly instead of silently "fixing" or
 * dropping cross-tenant data — a thrown error in a dry-run/report context is far safer
 * than a quietly-wrong classification.
 */

import type { TenantDriveRecord, TenantScope } from './types';

export class TenantBoundaryViolation extends Error {
  constructor(message: string) {
    super(`[tenant-boundary-violation] ${message}`);
    this.name = 'TenantBoundaryViolation';
  }
}

/**
 * Asserts that every drive in `drives` actually belongs to the given tenant scope.
 * Placement drives are already scoped 1:1 by (user_id, company_id) at the DB level via
 * foreign keys, but callers assemble in-memory slices themselves (e.g. "all drives for
 * this company"), so this guard exists to catch a caller bug (wrong filter, joined the
 * wrong list, etc.) before it can influence a classification.
 */
export function assertDrivesBelongToTenant(
  drives: TenantDriveRecord[],
  scope: TenantScope
): void {
  for (const drive of drives) {
    if (drive.userId !== scope.userId) {
      throw new TenantBoundaryViolation(
        `placement_drive ${drive.id} belongs to user ${drive.userId}, not ${scope.userId}. ` +
          'Refusing to use a foreign user\'s drive as evidence.'
      );
    }
    if (drive.companyId !== scope.companyId) {
      throw new TenantBoundaryViolation(
        `placement_drive ${drive.id} belongs to company ${drive.companyId}, not ${scope.companyId}. ` +
          'A drive number match must never cross company identity, even for the same user.'
      );
    }
  }
}

/**
 * Asserts that every drive in `drives` belongs to the given user, WITHOUT constraining
 * company_id.
 *
 * This is deliberately weaker than `assertDrivesBelongToTenant` and exists for a different
 * purpose: `placement_drives` enforces global-per-user uniqueness on
 * `(user_id, normalized_drive_number)` (see `idx_placement_drives_user_drive_number` in
 * migration v11) — NOT `(user_id, company_id, normalized_drive_number)`. A caller that needs to
 * know whether a drive number is already taken *anywhere in the user's account* (to correctly
 * classify it as an existing drive vs. a conflicting cross-company reuse vs. a genuinely new
 * drive) must reason over every company the user owns, not just one. Company-scoped fallback
 * logic that has no explicit drive number to check must still use `assertDrivesBelongToTenant`.
 */
export function assertDrivesBelongToUser(drives: TenantDriveRecord[], userId: string): void {
  for (const drive of drives) {
    if (drive.userId !== userId) {
      throw new TenantBoundaryViolation(
        `placement_drive ${drive.id} belongs to user ${drive.userId}, not ${userId}. ` +
          'Refusing to use a foreign user\'s drive as evidence.'
      );
    }
  }
}

/**
 * Asserts that a dependent record (application/event/notification/email/candidate_match)
 * being considered for assignment actually belongs to the tenant whose drive is about to be
 * attached to it. This is the last line of defense against cross-user or cross-company
 * assignment bugs in plan-generation code.
 */
export function assertRecordBelongsToTenant(
  record: { userId: string; companyId?: string | null },
  scope: TenantScope
): void {
  if (record.userId !== scope.userId) {
    throw new TenantBoundaryViolation(
      `Record owned by user ${record.userId} cannot be assigned using tenant scope for user ${scope.userId}.`
    );
  }
  if (record.companyId != null && record.companyId !== scope.companyId) {
    throw new TenantBoundaryViolation(
      `Record belongs to company ${record.companyId}, not ${scope.companyId}. Refusing cross-company assignment.`
    );
  }
}

/**
 * Rejects placeholder/fake identifiers outright. The migration must never fabricate a UUID for
 * a drive that has not actually been inserted by Postgres. This is intentionally strict: any
 * value that doesn't look like a real, lowercase v4-shaped UUID from a live INSERT is rejected.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertRealDatabaseUuid(value: string, context: string): void {
  if (!UUID_RE.test(value)) {
    throw new TenantBoundaryViolation(
      `Refusing to treat "${value}" as a real placement_drive id (${context}). ` +
        'Only a UUID returned by an actual INSERT ... RETURNING id may be used here.'
    );
  }
  const looksLikePlaceholder = /^0{8}-0{4}-0{4}-0{4}-0{12}$|^f{8}-f{4}-f{4}-f{4}-f{12}$/i.test(value);
  if (looksLikePlaceholder) {
    throw new TenantBoundaryViolation(`Refusing obviously-fake placeholder UUID "${value}" (${context}).`);
  }
}
