export type StatusUpdatePhase = 'personal_scan' | 'college_matching' | 'status_recalculation' | 'complete' | null;

/**
 * A drive's shortlist verdict is only genuinely "in flight" while it is still `pending`.
 *
 * `deferred` is terminal: the archive is either incomplete or holds a roster we cannot
 * parse (PDF/DOCX). Nothing is running for that drive, so treating it as pending made the
 * UI hold a real `not_shortlisted` status back behind "Updating status…" forever.
 */
export function isShortlistVerificationPending(state?: string | null): boolean {
  return (state || '').toLowerCase() === 'pending';
}

export function getVisibleApplicationStatus(
  status: string | null | undefined,
  isSyncing: boolean,
  manualOverride = false,
  statusUpdatesPending = false
): string {
  return (isSyncing || statusUpdatesPending) && !manualOverride && status?.toLowerCase() === 'not_shortlisted'
    ? 'applied'
    : status || 'not_applied';
}

export function getStatusUpdatePhase(subject?: string | null): StatusUpdatePhase {
  const value = (subject || '').toLowerCase();
  if (/drive statuses updated/.test(value)) return 'complete';
  if (/updating drive statuses|recalculating application statuses/.test(value)) return 'status_recalculation';
  if (/matching shared college shortlist archive|matching cached college shortlist/.test(value)) return 'college_matching';
  if (/^(connecting|scanning|processing|checking)/.test(value)) return 'personal_scan';
  return null;
}

export function getProvisionalStatusLabel(params: {
  status: string | null | undefined;
  isSyncing: boolean;
  statusUpdatesPending?: boolean;
  verificationPending?: boolean;
  updatePhase?: 'personal' | 'personal_scan' | 'college' | 'college_matching' | 'recalculate' | 'status_recalculation' | 'complete' | null;
  manualOverride?: boolean;
  syncSubject?: string | null;
}): string | null {
  if ((!params.isSyncing && !params.statusUpdatesPending && !params.verificationPending) || params.manualOverride || params.status?.toLowerCase() !== 'not_shortlisted') return null;
  if (params.updatePhase === 'college' || params.updatePhase === 'recalculate' || params.statusUpdatesPending && !params.isSyncing) return 'Updating status…';
  if ((params.statusUpdatesPending || params.verificationPending) && !params.isSyncing) return 'Updating status…';
  const phase = getStatusUpdatePhase(params.syncSubject);
  if (phase === 'complete') return 'Updating status…';
  return phase === 'college_matching' || phase === 'status_recalculation' ? 'Updating status…' : 'Checking shortlist…';
}
