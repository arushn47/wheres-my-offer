import { describe, expect, it } from 'vitest';
import { getSharedStatusPollDelay } from './shared-status-polling';

describe('shared College status polling cadence', () => {
  it('polls an active shared worker every five seconds', () => {
    expect(getSharedStatusPollDelay({ isSyncing: true })).toBe(5_000);
  });

  it('stops polling at idle/terminal state', () => {
    expect(getSharedStatusPollDelay({ isSyncing: false })).toBeNull();
    expect(getSharedStatusPollDelay(null)).toBeNull();
  });
});
