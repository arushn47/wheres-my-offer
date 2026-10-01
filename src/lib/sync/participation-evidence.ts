export interface UserPlacementEvidence {
  hasPersonalDriveEvidence: boolean;
  hasConfirmedShortlistMatch: boolean;
  manualOverride?: boolean;
}

export function getMissingPersonalSyncSetup(params: {
  hasPersonal: boolean;
  userNeoId: string | null;
}): string[] {
  const missing: string[] = [];
  if (!params.hasPersonal) missing.push('Personal Gmail (for NeoPAT drives)');
  if (!params.userNeoId) missing.push('NeoPAT Registration ID');
  return missing;
}

/**
 * Shared College broadcasts describe the catalog, not a particular student's
 * eligibility or application. Only user-specific evidence may create tracking.
 */
export function hasUserPlacementEvidence(evidence: UserPlacementEvidence): boolean {
  return Boolean(
    evidence.manualOverride ||
    evidence.hasPersonalDriveEvidence ||
    evidence.hasConfirmedShortlistMatch
  );
}

export function isShortlistMatchEvidence(match: {
  matchType: string | null | undefined;
  matchedValue: string | null | undefined;
  matchedRoundType?: string | null;
}): boolean {
  if (!match.matchType || match.matchType === 'xlsx_applied_list') return false;
  // All known competitive round types (original + new)
  const competitiveRoundTypes = ['test', 'test_r2', 'gd', 'ppt', 'interview', 'interview_r2', 'selected'];
  if (match.matchedRoundType && competitiveRoundTypes.includes(match.matchedRoundType)) return true;
  if (!['xlsx_cell', 'pdf_text', 'docx_text'].includes(match.matchType)) return false;
  return !/applied[\s_-]*list|opt[\s_-]*in[\s_-]*list|opt_in|registration[\s_-]*list|applied[\s_-]*(?:student|candidate)/i.test(
    match.matchedValue || ''
  );
}

export function isConfirmedShortlistEvidence(params: {
  isCollegeBroadcast: boolean;
  isNeoMatched: boolean;
  isShortlistEmail: boolean;
  isInAppliedList: boolean;
  isEliminationEmail: boolean;
}): boolean {
  return Boolean(
    params.isCollegeBroadcast &&
    params.isNeoMatched &&
    params.isShortlistEmail &&
    !params.isInAppliedList &&
    !params.isEliminationEmail
  );
}

export function hasSharedDriveFanOutEvidence(params: {
  hasPersonalDriveEvidence: boolean;
  hasConfirmedShortlistMatch: boolean;
  manualOverride?: boolean;
}): boolean {
  return hasUserPlacementEvidence(params);
}
