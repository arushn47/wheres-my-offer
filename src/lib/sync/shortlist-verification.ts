export type ShortlistVerificationState = 'pending' | 'verified_present' | 'verified_absent' | 'deferred' | 'not_published';

export interface ShortlistRosterScan {
  relevant: boolean;
  parsed: boolean;
  candidatePresent: boolean;
  collegeEmailId?: string;
  filename?: string;
  round?: 'test' | 'interview' | 'selected' | null;
  details?: string;
}

export interface CachedRosterInput {
  filename: string;
  collegeEmailId?: string;
  round?: 'test' | 'interview' | 'selected' | null;
  parseStatus?: string | null;
  extractedRows?: Array<{ sheetName: string; rows: unknown[][] }> | null;
}

export interface CachedRosterEvaluation {
  state: ShortlistVerificationState;
  checkedRosterCount: number;
  matchingRoster?: CachedRosterInput & { round: 'test' | 'interview' | 'selected' | null; details: string };
}

function normalizedIdentity(value: unknown): string {
  return String(value ?? '').replace(/[\u00a0\s\-_.]/g, '').toUpperCase();
}

function isAppliedRoster(filename: string): boolean {
  return /applied[_\s-]*list|opt[_\s-]*in(?:[_\s-]*list)?|opt_in|eligible[_\s-]*student|registered[_\s-]*student|registration[_\s-]*list|applied[_\s-]*(?:candidate|student)/i.test(filename);
}

export function evaluateCachedShortlistRosters(params: {
  rosters: CachedRosterInput[];
  shortlistContext: boolean;
  identityTokens: string[];
}): CachedRosterEvaluation {
  const identityTokens = new Set(params.identityTokens.map(normalizedIdentity).filter(Boolean));
  const possibleRoster = params.rosters.some((roster) =>
    !isAppliedRoster(roster.filename) &&
    (/shortlist|selection[_\s-]*list|selected[_\s-]*student|shortlisted/i.test(roster.filename) || params.shortlistContext)
  );
  const relevant = params.rosters.filter((roster) => {
    if (!/\.(xlsx|xls|csv)$/i.test(roster.filename) || isAppliedRoster(roster.filename)) return false;
    const namedShortlist = /shortlist|selection[_\s-]*list|selected[_\s-]*student|shortlisted/i.test(roster.filename);
    return namedShortlist || params.shortlistContext;
  });
  if (relevant.length === 0) {
    return { state: possibleRoster ? 'deferred' : 'not_published', checkedRosterCount: 0 };
  }
  if (identityTokens.size === 0) {
    return { state: 'deferred', checkedRosterCount: 0 };
  }

  let checkedRosterCount = 0;
  let matchingRoster: (CachedRosterInput & { round: 'test' | 'interview' | 'selected' | null; details: string }) | undefined;
  let incomplete = false;
  for (const roster of relevant) {
    if (roster.parseStatus !== 'complete' || !roster.extractedRows?.length) {
      incomplete = true;
      continue;
    }
    checkedRosterCount++;
    const found = roster.extractedRows.some((sheet) =>
      sheet.rows.some((row) => row.some((cell) => identityTokens.has(normalizedIdentity(cell))))
    );
    if (found) {
      matchingRoster = {
        ...roster,
        round: roster.round || null,
        details: `Matched in ${roster.filename}`,
      };
    }
  }

  if (matchingRoster) return { state: 'verified_present', checkedRosterCount, matchingRoster };
  if (incomplete || checkedRosterCount === 0) return { state: 'deferred', checkedRosterCount };
  return { state: 'verified_absent', checkedRosterCount };
}

export function deriveShortlistVerificationState(
  rosters: ShortlistRosterScan[],
  deferred = false
): { state: ShortlistVerificationState; checkedRosterCount: number } {
  const relevant = rosters.filter((roster) => roster.relevant);
  const checkedRosterCount = relevant.filter((roster) => roster.parsed).length;

  if (relevant.some((roster) => roster.parsed && roster.candidatePresent)) {
    return { state: 'verified_present', checkedRosterCount };
  }
  if (relevant.length === 0) return { state: 'not_published', checkedRosterCount: 0 };
  if (deferred || relevant.some((roster) => !roster.parsed)) {
    return { state: 'deferred', checkedRosterCount };
  }
  return { state: 'verified_absent', checkedRosterCount };
}

export function shouldPublishNotShortlisted(params: {
  verificationState: ShortlistVerificationState | null | undefined;
  hasPositiveMatch: boolean;
  manualOverride?: boolean;
}): boolean {
  return params.verificationState === 'verified_absent' && !params.hasPositiveMatch && !params.manualOverride;
}

export function getVerifiedShortlistStatus(params: {
  verificationState: ShortlistVerificationState;
  hasPositiveMatch: boolean;
  currentStatus: string;
  manualOverride?: boolean;
}): 'not_shortlisted' | 'shortlisted' | null {
  if (params.manualOverride || ['not_applied', 'unknown', 'withdrawn', 'declined'].includes(params.currentStatus)) return null;
  if (params.hasPositiveMatch || params.verificationState === 'verified_present') {
    if (['test_scheduled', 'test_ongoing', 'test_completed', 'interview_scheduled', 'interview_ongoing', 'interview_completed', 'selected', 'offer', 'offer_received', 'rejected', 'rejected_test', 'rejected_interview'].includes(params.currentStatus)) return null;
    return 'shortlisted';
  }
  if (shouldPublishNotShortlisted(params)) return 'not_shortlisted';
  return null;
}

export function resolveDriveVerification(params: {
  scans: ShortlistRosterScan[];
  archiveComplete: boolean;
}): { state: ShortlistVerificationState; checkedRosterCount: number } {
  const result = deriveShortlistVerificationState(params.scans);
  if (result.state === 'verified_present' || result.state === 'not_published') return result;
  if (!params.archiveComplete && result.state === 'verified_absent') {
    return { state: 'deferred', checkedRosterCount: result.checkedRosterCount };
  }
  return result;
}
