export type StatusUpdatePhase = 'personal_scan' | 'college_matching' | 'status_recalculation' | 'complete' | null;

/**
 * Shortlist verdicts are stored directly on applications.status. There is no
 * separate verification-tracking state and no provisional masking: whatever the
 * scanner wrote is what the user sees.
 */
export function isShortlistVerificationPending(_state?: string | null): boolean {
  return false;
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

export function getProvisionalStatusLabel(_params: {
  status?: string | null;
  isSyncing?: boolean;
  statusUpdatesPending?: boolean;
  verificationPending?: boolean;
  updatePhase?: 'personal' | 'personal_scan' | 'college' | 'college_matching' | 'recalculate' | 'status_recalculation' | 'complete' | null;
  manualOverride?: boolean;
  syncSubject?: string | null;
}): string | null {
  return null;
}
