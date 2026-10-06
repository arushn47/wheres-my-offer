import { resolveRecruitmentStatus, type RoundStatusDecision } from './round-status';

export type StatusUpdatePhase = 'personal_scan' | 'college_matching' | 'status_recalculation' | 'complete' | null;

/**
 * Verification state describes parsing and identity checks. Partial-list
 * completeness describes scope, and never changes a checked absence to pending.
 */
export function isShortlistVerificationPending(state?: string | null): boolean {
  return state === 'pending' || state === 'deferred';
}

/** Shared by list and detail loaders so both surfaces use the same current evidence. */
export function getRoundStatusDisplay(status: string, decisions: RoundStatusDecision[] = [], manualOverride = false, notes = '') {
  return {
    status: resolveRecruitmentStatus(status, decisions, manualOverride, notes),
  };
}

export function getVisibleApplicationStatus(
  status: string | null | undefined,
  _isSyncing = false,
  _manualOverride = false,
  _statusUpdatesPending = false
): string {
  return status || 'not_applied';
}

export function getStatusUpdatePhase(subject?: string | null): StatusUpdatePhase {
  const value = (subject || '').toLowerCase();
  if (/drive statuses updated/.test(value)) return 'complete';
  if (/updating drive statuses|recalculating application statuses/.test(value)) return 'status_recalculation';
  if (/matching shared college shortlist archive|matching cached college shortlist/.test(value)) return 'college_matching';
  if (/^(connecting|scanning|processing|checking)/.test(value)) return 'personal_scan';
  return null;
}
