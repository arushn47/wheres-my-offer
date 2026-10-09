import type { RoundVerdict } from './round-verdict';

type Decision = Pick<RoundVerdict, 'eligible' | 'state' | 'finalNegative' | 'reason' | 'outcome' | 'evaluations'>;
const inactiveStatuses = new Set(['withdrawn', 'declined', 'not_applied', 'registration_open', 'unknown']);
export const negativeRoundNotificationKey = (userId: string, driveId: string) => `shortlist_absent:${userId}:${driveId}`;

/** Absence is conclusive only after a complete roster scan or explicit personal rejection. */
export function isConfirmedNegativeRound(verdict: Decision | null | undefined): boolean {
  return Boolean(verdict && verdict.eligible === false && verdict.state === 'verified_absent' && verdict.finalNegative === true &&
    verdict.reason === 'complete_list_absence' &&
    (verdict.outcome === 'rejected' || Array.isArray(verdict.evaluations) && verdict.evaluations.some(scan => scan?.state === 'verified_absent')));
}

export function canNotifyNegativeRound(verdict: Decision | null | undefined, status: string, manualOverride = false): boolean {
  return !manualOverride && Boolean(status) && !inactiveStatuses.has(status) && isConfirmedNegativeRound(verdict);
}
