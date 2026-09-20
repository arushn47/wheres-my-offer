/**
 * Phase 3 VALIDATION step.
 *
 * `evaluatePreflight` is pure: it takes the rows returned by `phase3_preflight_report()`
 * (mirroring `preflight_v12_drive_migration.sql`) and decides whether EXECUTION may proceed at
 * all. The actual invariant checks live in SQL (they need to see live data); this module only
 * decides what the *aggregate* result means, so that decision is unit-testable without a
 * database.
 */

import type { PreflightCheckRow } from './rpc-client';

export type PreflightStatus = 'BLOCKED' | 'REVIEW_REQUIRED' | 'READY';

export interface PreflightResult {
  status: PreflightStatus;
  blocked: PreflightCheckRow[];
  warnings: PreflightCheckRow[];
  checks: PreflightCheckRow[];
}

/**
 * Any `BLOCKED` row means EXECUTION must not run at all (not even for unaffected users) — the
 * technical prerequisites for `phase3_apply_user_actions` are not met. `WARN` rows never block;
 * they are surfaced for human review (e.g. "legacy rows exist" is expected and fine).
 */
export function evaluatePreflight(checks: PreflightCheckRow[]): PreflightResult {
  const blocked = checks.filter((c) => c.status === 'BLOCKED');
  const warnings = checks.filter((c) => c.status === 'WARN');
  return {
    status: blocked.length > 0 ? 'BLOCKED' : warnings.length > 0 ? 'REVIEW_REQUIRED' : 'READY',
    blocked,
    warnings,
    checks,
  };
}

/** Convenience guard for callers that only care about the yes/no answer. */
export function canProceedToExecution(result: PreflightResult): boolean {
  return result.status !== 'BLOCKED';
}

export type CandidateMatchEmailConsistency =
  | 'pass'
  | 'warn_legacy_source_email'
  | 'blocked_drive_mismatch'
  | 'blocked_invalid_source_scope';

/**
 * A candidate match may preserve valid historical drive evidence even when its
 * source email predates email-drive assignment. A non-null disagreement is a
 * real cross-drive conflict; ownership failures remain blocked separately.
 */
export function classifyCandidateMatchEmailConsistency(params: {
  candidateDriveId: string | null;
  emailDriveId: string | null;
  candidateUserIdMatches: boolean;
  candidateCompanyMatches?: boolean;
}): CandidateMatchEmailConsistency {
  if (!params.candidateUserIdMatches || params.candidateCompanyMatches === false) {
    return 'blocked_invalid_source_scope';
  }
  if (params.candidateDriveId && !params.emailDriveId) {
    return 'warn_legacy_source_email';
  }
  if (!params.candidateDriveId || !params.emailDriveId) {
    return 'pass';
  }
  return params.candidateDriveId === params.emailDriveId
    ? 'pass'
    : 'blocked_drive_mismatch';
}
