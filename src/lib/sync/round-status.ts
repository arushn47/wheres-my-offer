import type { RoundType } from './round-identity';

/** Safe to send to the UI: contains round outcomes, never roster contents or identities. */
export interface RoundStatusDecision {
  roundKey: string;
  roundType: RoundType | null;
  state: string;
  outcome?: 'selected' | 'rejected';
  eligible: boolean;
  finalNegative: boolean;
  sourceReceivedAt: string;
  parserVersion: number;
  isCurrent?: boolean;
  roundNumber?: number;
  pptIncluded?: boolean;
}

export function usesAutomaticRoundStatus(status: string, manualOverride = false): boolean {
  return !manualOverride && !['withdrawn', 'declined', 'not_applied', 'registration_open', 'unknown'].includes(status);
}

export function statusForRoundVerdict(verdict: RoundStatusDecision, currentStatus: string, manualOverride = false, history: RoundStatusDecision[] = []): string {
  if (!usesAutomaticRoundStatus(currentStatus, manualOverride)) return currentStatus;
  if (!verdict.eligible) {
    if (verdict.state !== 'verified_absent') return currentStatus;
    const resolved = resolveRecruitmentStatus(currentStatus, [...history.filter(d => d.roundKey !== verdict.roundKey).map(d => ({ ...d, isCurrent: false })), { ...verdict, isCurrent: true }], manualOverride);
    // The database keeps the existing status codes; PPT scope is retained in evidence.
    return resolved === 'not_shortlisted_post_ppt' ? 'not_shortlisted' : resolved;
  }
  if (verdict.outcome === 'selected' || verdict.roundType === 'selected') return 'selected';
  if (verdict.roundType === 'ppt') return ['ppt_completed', 'ppt_ongoing'].includes(currentStatus) ? currentStatus : 'ppt_scheduled';
  if (['test_completed', 'interview_completed'].includes(currentStatus)) return currentStatus;
  return 'shortlisted';
}

/** Reserve explicit ordinals before assigning dated rounds. */
export function roundEventNumbers(verdicts: RoundStatusDecision[]): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const family of ['test', 'interview']) {
    const rounds = verdicts.filter(verdict => verdict.roundType?.replace(/_r2$/, '') === family);
    const used = new Set<number>();
    for (const round of rounds) {
      const ordinal = round.roundKey.match(/:(\d{1,2})$/);
      if (ordinal) { const number = Number(ordinal[1]); numbers.set(round.roundKey, number); used.add(number); }
    }
    for (const round of rounds.filter(round => !numbers.has(round.roundKey)).sort((a, b) => a.sourceReceivedAt.localeCompare(b.sourceReceivedAt))) {
      let number = 1; while (used.has(number)) number++;
      numbers.set(round.roundKey, number); used.add(number);
    }
  }
  for (const round of verdicts.filter(round => round.roundType === 'game')) numbers.set(round.roundKey, 50);
  return numbers;
}

export function getCurrentRoundDecision(decisions?: RoundStatusDecision[]): RoundStatusDecision | undefined {
  if (!decisions || decisions.length === 0) return undefined;
  // Reprocessing retires obsolete decisions by clearing is_current. Those rows
  // remain as history, but cannot revive the status that was just repaired.
  if (decisions.every(decision => decision.isCurrent === false)) return undefined;
  const active = decisions.filter(decision => decision.isCurrent);
  const currentVersion = Math.max(...(active.length ? active : decisions).map(decision => decision.parserVersion));
  decisions = decisions.filter(decision => decision.parserVersion >= currentVersion);

  // Determine true terminal decision based on verified presence and earliest elimination
  const sorted = [...decisions].sort((a, b) => a.sourceReceivedAt.localeCompare(b.sourceReceivedAt));
  const lastPresentIdx = sorted.findLastIndex(d => d.eligible && d.state === 'verified_present');

  if (lastPresentIdx >= 0) {
    const subsequent = sorted.slice(lastPresentIdx + 1);
    const firstElimination = subsequent.find(d => !d.eligible && d.state === 'verified_absent' && d.finalNegative);
    if (firstElimination) return firstElimination;
  } else {
    const firstElimination = sorted.find(d => !d.eligible && d.state === 'verified_absent' && d.finalNegative);
    if (firstElimination) return firstElimination;
  }

  return decisions.filter(decision => decision.isCurrent)
    .sort((a, b) => b.parserVersion - a.parserVersion || b.sourceReceivedAt.localeCompare(a.sourceReceivedAt))[0]
    || sorted.at(-1);
}

export function summarizeRoundDecisions(rows: Array<{ verdict: RoundStatusDecision; is_current: boolean }>): RoundStatusDecision[] {
  const numbers = roundEventNumbers(rows.map(row => row.verdict));
  return rows.map(({ verdict, is_current }) => ({
    roundKey: verdict.roundKey, roundType: verdict.roundType, state: verdict.state,
    pptIncluded: verdict.pptIncluded, outcome: verdict.outcome, eligible: verdict.eligible, finalNegative: verdict.finalNegative,
    sourceReceivedAt: verdict.sourceReceivedAt, parserVersion: verdict.parserVersion,
    isCurrent: is_current, roundNumber: numbers.get(verdict.roundKey),
  }));
}

/** Unreadable or unpublished lists cannot become a recruitment milestone. */
export function getConfirmedRoundDecision(decisions: RoundStatusDecision[] = []): RoundStatusDecision | undefined {
  const current = getCurrentRoundDecision(decisions);
  if (!current || ['verified_present', 'verified_absent'].includes(current.state)) return current;
  return decisions.filter(decision => ['verified_present', 'verified_absent'].includes(decision.state) &&
    decision.parserVersion >= current.parserVersion && decision.sourceReceivedAt <= current.sourceReceivedAt)
    .sort((a, b) => b.sourceReceivedAt.localeCompare(a.sourceReceivedAt))[0];
}

/** One existing recruitment status for badges, summaries, filters, and pipeline. */
export function resolveRecruitmentStatus(status: string, allDecisions: RoundStatusDecision[] = [], manualOverride = false, notes = ''): string {
  if (!usesAutomaticRoundStatus(status, manualOverride)) return status;
  const decision = getConfirmedRoundDecision(allDecisions);
  if (!decision) return status;
  if (decision.eligible && decision.state === 'verified_present') {
    if (decision.roundType === 'selected' || decision.outcome === 'selected') return 'selected';
    // An unreadable later list preserves a confirmed negative or completed status.
    if (['rejected', 'rejected_test', 'rejected_interview', 'not_shortlisted'].includes(status) && !decision.isCurrent) return status;
    if (decision.roundType?.startsWith('interview')) {
      return ['interview_completed', 'interview_ongoing'].includes(status) ? status : 'interview_scheduled';
    }
    if (decision.roundType === 'ppt') return ['ppt_completed', 'ppt_ongoing'].includes(status) ? status : 'ppt_scheduled';
    if (['test_completed', 'test_ongoing', 'test_scheduled'].includes(status)) return status;
    return 'shortlisted';
  }
  if (decision.state !== 'verified_absent') return status;
  const participation = getRoundParticipation(allDecisions, decision);
  // A broadcast announcing interviews/results does not establish any previous
  // participation. Rejection notes and old negative codes are not evidence either.
  if (participation.interview && (decision.roundType === 'selected' || decision.roundType?.startsWith('interview'))) return 'rejected_interview';
  if (participation.test || status === 'test_completed') return 'rejected_test';
  // Some later selection rounds include a PPT. Their absence cannot erase a
  // verified earlier test qualification, including already-stored PPT verdicts.
  if (decision.roundType === 'ppt') return 'not_shortlisted';
  return participation.ppt || ['ppt_completed', 'ppt_ongoing'].includes(status)
    ? 'not_shortlisted_post_ppt' : 'not_shortlisted';
}

/** Only verified inclusion in an earlier applicable round proves participation. */
export function getRoundParticipation(decisions: RoundStatusDecision[], current = getConfirmedRoundDecision(decisions)) {
  const prior = current ? decisions.filter(d => d.parserVersion >= current.parserVersion &&
    d.sourceReceivedAt <= current.sourceReceivedAt && d.eligible && d.state === 'verified_present' && d.roundKey !== current.roundKey) : [];
  return {
    ppt: prior.some(d => d.roundType === 'ppt' || d.pptIncluded),
    test: prior.some(d => ['test', 'test_r2', 'game', 'gd'].includes(d.roundType || '')),
    interview: prior.some(d => d.roundType?.startsWith('interview')),
  };
}

/** The evaluated round immediately before a missing next-round shortlist. */
export function getEliminationRoundDecision(
  decisions: RoundStatusDecision[] = [],
  current = getConfirmedRoundDecision(decisions)
): RoundStatusDecision | undefined {
  if (!current || current.state !== 'verified_absent') return undefined;
  const evaluatedTypes: Array<RoundType> = ['test', 'test_r2', 'game', 'gd', 'interview', 'interview_r2'];
  return decisions.filter(decision =>
    decision.roundKey !== current.roundKey &&
    decision.parserVersion >= current.parserVersion &&
    decision.sourceReceivedAt <= current.sourceReceivedAt &&
    decision.eligible && decision.state === 'verified_present' &&
    Boolean(decision.roundType && evaluatedTypes.includes(decision.roundType))
  ).sort((a, b) => b.sourceReceivedAt.localeCompare(a.sourceReceivedAt))[0];
}

/** A PPT invitation cannot also authorize tests/interviews mentioned in its agenda. */
export function isRoundEventEligible(decision: RoundStatusDecision | undefined, eventType: string): boolean {
  if (!decision?.eligible || decision.state !== 'verified_present') return false;
  if (eventType === 'ppt') return decision.roundType === 'ppt' || Boolean(decision.pptIncluded);
  if (/test|assessment/.test(eventType)) return ['test', 'test_r2', 'game'].includes(decision.roundType || '');
  if (/interview/.test(eventType)) return Boolean(decision.roundType?.startsWith('interview'));
  if (/group_discussion/.test(eventType)) return decision.roundType === 'gd';
  return false;
}
