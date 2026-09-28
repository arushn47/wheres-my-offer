import { describe, expect, it } from 'vitest';
import {
  getProvisionalStatusLabel,
  getStatusUpdatePhase,
  getVisibleApplicationStatus,
  isShortlistVerificationPending,
} from './status-display';

describe('sync status display', () => {
  it('keeps negative shortlist results provisional until the global sync finishes', () => {
    expect(getProvisionalStatusLabel({ status: 'not_shortlisted', isSyncing: true })).toBe('Checking shortlist…');
    expect(getProvisionalStatusLabel({ status: 'not_shortlisted', isSyncing: false })).toBeNull();
  });

  it('labels the cached College matching and recalculation phases as status updates', () => {
    expect(getStatusUpdatePhase('Matching shared College shortlist archive…')).toBe('college_matching');
    expect(getStatusUpdatePhase('Updating drive statuses…')).toBe('status_recalculation');
    expect(getProvisionalStatusLabel({
      status: 'not_shortlisted',
      isSyncing: true,
      syncSubject: 'Matching shared College shortlist archive…',
    })).toBe('Updating status…');
  });

  it('does not replace already-positive or unrelated application statuses', () => {
    expect(getProvisionalStatusLabel({ status: 'test_scheduled', isSyncing: true })).toBeNull();
    expect(getProvisionalStatusLabel({ status: 'applied', isSyncing: true })).toBeNull();
  });

  it('keeps a provisional negative out of inactive filters while sync is in progress', () => {
    expect(getVisibleApplicationStatus('not_shortlisted', true)).toBe('applied');
    expect(getVisibleApplicationStatus('not_shortlisted', false)).toBe('not_shortlisted');
    expect(getVisibleApplicationStatus('test_scheduled', true)).toBe('test_scheduled');
  });

  it('preserves an explicitly manual shortlist status', () => {
    expect(getVisibleApplicationStatus('not_shortlisted', true, true)).toBe('not_shortlisted');
    expect(getProvisionalStatusLabel({ status: 'not_shortlisted', isSyncing: true, manualOverride: true })).toBeNull();
  });

  it('continues to show an updating label if the final checks were deferred', () => {
    expect(getProvisionalStatusLabel({ status: 'not_shortlisted', isSyncing: false, statusUpdatesPending: true })).toBe('Updating status…');
    expect(getVisibleApplicationStatus('not_shortlisted', false, false, true)).toBe('applied');
  });

  it('counts only a genuinely pending verdict as in flight, never a terminal deferral', () => {
    expect(isShortlistVerificationPending('pending')).toBe(true);
    expect(isShortlistVerificationPending('deferred')).toBe(false);
    expect(isShortlistVerificationPending('verified_absent')).toBe(false);
    expect(isShortlistVerificationPending('not_published')).toBe(false);
    expect(isShortlistVerificationPending(null)).toBe(false);
    expect(isShortlistVerificationPending(undefined)).toBe(false);
  });

  it('surfaces a verified negative once nothing is running for that drive', () => {
    expect(getVisibleApplicationStatus('not_shortlisted', false, false, isShortlistVerificationPending('deferred'))).toBe('not_shortlisted');
    expect(getVisibleApplicationStatus('not_shortlisted', false, false, isShortlistVerificationPending('pending'))).toBe('applied');
  });

});
