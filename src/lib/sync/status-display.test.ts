import { describe, it, expect } from 'vitest';
import {
  getVisibleApplicationStatus,
  isShortlistVerificationPending,
  getStatusUpdatePhase,
} from './status-display';

describe('sync status display', () => {
  it('always shows the stored status — no provisional masking', () => {
    expect(getVisibleApplicationStatus('not_shortlisted', false, false, false)).toBe('not_shortlisted');
    expect(getVisibleApplicationStatus('not_shortlisted', true, false, false)).toBe('not_shortlisted');
    expect(getVisibleApplicationStatus('not_shortlisted', true, false, true)).toBe('not_shortlisted');
    expect(getVisibleApplicationStatus('applied', true, false, true)).toBe('applied');
    expect(getVisibleApplicationStatus(null, false, false, false)).toBe('not_applied');
  });

  it('manual override no longer changes visibility', () => {
    expect(getVisibleApplicationStatus('not_shortlisted', true, true, true)).toBe('not_shortlisted');
  });

  it('tracks pending verification without treating complete absence as pending', () => {
    expect(isShortlistVerificationPending('pending')).toBe(true);
    expect(isShortlistVerificationPending('verified_absent')).toBe(false);
    expect(isShortlistVerificationPending(null)).toBe(false);
  });

  it('classifies sync subjects', () => {
    expect(getStatusUpdatePhase('Updating drive statuses…')).toBe('status_recalculation');
    expect(getStatusUpdatePhase('Matching shared College shortlist archive…')).toBe('college_matching');
    expect(getStatusUpdatePhase('Drive statuses updated')).toBe('complete');
    expect(getStatusUpdatePhase('random')).toBeNull();
  });
});
