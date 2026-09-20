/**
 * Phase 3 RESOLUTION step.
 *
 * Pure functions only — no Supabase client, no I/O. Given evidence (drive numbers
 * extracted from a record's own text, or discovered anywhere for a company) and the
 * full set of placement_drives rows that already exist for a user (across every company
 * that user owns — see `ClassifyDriveEvidenceParams.userDrives`), decide whether the
 * evidence:
 *
 *   - proves an EXISTING drive          -> proven_existing_drive
 *   - proves exactly one NEW candidate  -> proven_new_drive_candidate (never a fake UUID)
 *   - is AMBIGUOUS (2+ distinct drives) -> ambiguous
 *   - CONFLICTS with itself/the tenant  -> conflict
 *   - has no evidence at all            -> unresolved
 *
 * This mirrors (and must stay behaviorally consistent with) the live runtime resolver in
 * `src/lib/sync/drive-resolution.ts` (`resolvePlacementDrive`), which is the source of truth
 * for how *new* live emails resolve drive identity. Phase 3 exists to catch legacy rows up to
 * the same invariants, not to invent a parallel, looser set of rules.
 */

import type { DriveEvidenceOutcome, TenantDriveRecord, TenantScope } from './types';
import { assertDrivesBelongToTenant, assertDrivesBelongToUser } from './tenant-guard';
import { normalizeDriveNumber } from '@/lib/drive-number';

export { normalizeDriveNumber };

export interface ClassifyDriveEvidenceParams {
  scope: TenantScope;
  /**
   * Distinct drive numbers found directly on the record/evidence being classified
   * (e.g. all numbers extracted from one email's own text, or the union of numbers
   * discovered anywhere for a company when resolving a record that has no text of
   * its own, such as an application or event). Does not need to be pre-deduplicated
   * or pre-normalized.
   */
  ownDriveNumbers: Array<string | null | undefined>;
  /**
   * Every placement_drives row owned by `scope.userId`, across ALL of that user's companies —
   * NOT pre-filtered to `scope.companyId`.
   *
   * This must be the user's full drive roster, not a company-scoped slice, because
   * `placement_drives` enforces uniqueness on `(user_id, normalized_drive_number)` globally per
   * user (`idx_placement_drives_user_drive_number`), not per company. If callers only passed the
   * company-scoped subset, a drive number already claimed by a different company for the same
   * user would be invisible here, and explicit-number evidence would be misclassified as a brand
   * new drive — which then either fails at INSERT time (unique-index violation) or, worse, could
   * be paired with a permissive materialization step into a cross-company identity collision.
   * This function narrows to the caller's company internally wherever narrowing is actually safe
   * (the no-explicit-evidence fallback), so the tenant boundary is enforced in one place.
   */
  userDrives: TenantDriveRecord[];
}

/**
 * Classifies one piece of evidence against one user's known drives.
 *
 * Deliberately does NOT accept a "companyId only" shortcut for the input roster: callers must
 * always pass every drive belonging to `scope.userId` so a same-numbered drive belonging to a
 * different company for this user is detected as a conflict instead of silently vanishing from
 * consideration. A drive belonging to a different *user* must never appear in `userDrives` at
 * all — that boundary is enforced by `assertDrivesBelongToUser` below, and a caller bug that
 * violates it throws immediately instead of quietly influencing a classification.
 */
export function classifyDriveEvidence(params: ClassifyDriveEvidenceParams): DriveEvidenceOutcome {
  assertDrivesBelongToUser(params.userDrives, params.scope.userId);

  const distinct = Array.from(
    new Set(params.ownDriveNumbers.map((value) => normalizeDriveNumber(value)).filter((v): v is string => Boolean(v)))
  );

  if (distinct.length > 1) {
    return {
      state: 'conflict',
      reason: `Evidence contains ${distinct.length} mutually exclusive drive numbers: ${distinct.join(', ')}`,
    };
  }

  if (distinct.length === 1) {
    const normalizedDriveNumber = distinct[0];
    // Canonical identity is (user_id, normalized_drive_number) — search the user's WHOLE
    // drive roster, not just this company's, so a number already claimed by another company
    // is never mistaken for one that is free to (re)create under this company.
    const matchesAnywhere = params.userDrives.filter(
      (d) => normalizeDriveNumber(d.normalizedDriveNumber) === normalizedDriveNumber
    );

    if (matchesAnywhere.length > 1) {
      // Data integrity problem, not a classification problem: two or more placement_drives rows
      // already share this normalized number for this user, which the unique index should make
      // impossible. Never guess which one is "right" — surface it as a conflict.
      return {
        state: 'conflict',
        reason:
          `Data integrity issue: ${matchesAnywhere.length} placement_drives rows already share ` +
          `normalized drive number "${normalizedDriveNumber}" for this user (ids: ` +
          `${matchesAnywhere.map((d) => d.id).join(', ')}). Refusing to guess which is authoritative.`,
      };
    }

    const existing = matchesAnywhere[0];
    if (existing) {
      if (existing.companyId === params.scope.companyId) {
        return { state: 'proven_existing_drive', driveId: existing.id, normalizedDriveNumber };
      }
      // Same user, same drive number, different company. This is exactly the shape of a
      // cross-company identity leak if it were ever silently accepted — treat it as a hard
      // conflict, mirroring resolvePlacementDrive's `existing.company_id !== companyId` check.
      return {
        state: 'conflict',
        reason:
          `Drive number "${normalizedDriveNumber}" already belongs to company ${existing.companyId} ` +
          `for this user, not company ${params.scope.companyId}. Refusing to reuse or duplicate it.`,
      };
    }
    return { state: 'proven_new_drive_candidate', normalizedDriveNumber };
  }

  // No explicit drive evidence is not sufficient to select a company drive.
  // A company may have one or many opportunities, and chronology/company-only
  // inference would silently contaminate the wrong opportunity.
  return { state: 'unresolved' };
}

/**
 * Aggregates several records' own drive-number evidence (e.g. every legacy email under one
 * company) into the single set of distinct numbers "discovered" for that company. This is a
 * pure list operation — it does not decide anything about assignment by itself. Feed the result
 * into `classifyDriveEvidence` as `ownDriveNumbers` when resolving company-scoped records
 * (applications/events/notifications) that have no drive-number text of their own.
 */
export function aggregateDiscoveredDriveNumbers(
  perRecordDriveNumbers: Array<Array<string | null | undefined>>
): string[] {
  const set = new Set<string>();
  for (const numbers of perRecordDriveNumbers) {
    for (const value of numbers) {
      const normalized = normalizeDriveNumber(value);
      if (normalized) set.add(normalized);
    }
  }
  return Array.from(set);
}
