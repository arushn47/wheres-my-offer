import { describe, expect, it } from 'vitest';
import { canNotifyNegativeRound, isConfirmedNegativeRound, negativeRoundNotificationKey } from './round-notification-policy';
const absent = { eligible: false, state: 'verified_absent' as const, finalNegative: true, reason: 'complete_list_absence' as const, evaluations: [{ emailId: 'source', state: 'verified_absent' as const, rosterKey: 'hash' }] };
describe('confirmed negative notification policy', () => {
  it.each(['applied', 'not_shortlisted', 'rejected', 'test_completed', 'interview_completed'])('allows a confirmed participating result for %s', status => expect(canNotifyNegativeRound(absent, status)).toBe(true));
  it.each(['withdrawn', 'declined', 'not_applied', 'registration_open', 'unknown', ''])('excludes %s', status => expect(canNotifyNegativeRound(absent, status)).toBe(false));
  it('excludes manual overrides, deferred and partial evidence, and unverifiable absence', () => {
    expect(isConfirmedNegativeRound(null)).toBe(false); expect(isConfirmedNegativeRound(undefined)).toBe(false);
    expect(canNotifyNegativeRound(absent, 'applied', true)).toBe(false);
    expect(isConfirmedNegativeRound({ ...absent, state: 'deferred' })).toBe(false);
    expect(isConfirmedNegativeRound({ ...absent, finalNegative: false })).toBe(false);
    expect(isConfirmedNegativeRound({ ...absent, reason: 'partial_list_absence' })).toBe(false);
    expect(isConfirmedNegativeRound({ ...absent, evaluations: [] })).toBe(false);
    expect(isConfirmedNegativeRound({ ...absent, eligible: true })).toBe(false);
  });
  it('allows explicit personal rejection without inventing a roster', () => expect(isConfirmedNegativeRound({ ...absent, evaluations: [], outcome: 'rejected' })).toBe(true));
  it('dedupes the elimination across rounds and roster revisions, isolating sibling drives and users', () => {
    expect(negativeRoundNotificationKey('a', 'one')).toBe('shortlist_absent:a:one');
    expect(negativeRoundNotificationKey('a', 'one')).not.toBe(negativeRoundNotificationKey('a', 'two'));
    expect(negativeRoundNotificationKey('a', 'one')).not.toBe(negativeRoundNotificationKey('b', 'one'));
  });
});
