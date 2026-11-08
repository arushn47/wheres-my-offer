import { describe, expect, it } from 'vitest';
import {
  getUpdatesPollDelay,
  getFallbackSyncPollDelay,
  UPDATES_POLL_ACTIVE_MS,
  UPDATES_POLL_IDLE_WARM_MS,
  UPDATES_POLL_IDLE_COLD_MS,
  FALLBACK_SYNC_FAST_MS,
  FALLBACK_SYNC_SLOW_MS,
} from './adaptive-poll';

describe('adaptive client polling delays', () => {
  it('returns active 30s delay for active users (< 2 min idle)', () => {
    expect(getUpdatesPollDelay(0)).toBe(UPDATES_POLL_ACTIVE_MS);
    expect(getUpdatesPollDelay(30_000)).toBe(UPDATES_POLL_ACTIVE_MS);
    expect(getUpdatesPollDelay(119_999)).toBe(UPDATES_POLL_ACTIVE_MS);
  });

  it('returns warm 60s delay for moderately idle users (2 to 5 min idle)', () => {
    expect(getUpdatesPollDelay(120_000)).toBe(UPDATES_POLL_IDLE_WARM_MS);
    expect(getUpdatesPollDelay(240_000)).toBe(UPDATES_POLL_IDLE_WARM_MS);
    expect(getUpdatesPollDelay(299_999)).toBe(UPDATES_POLL_IDLE_WARM_MS);
  });

  it('returns cold 120s delay for prolonged idle users (5 to 15 min idle)', () => {
    expect(getUpdatesPollDelay(300_000)).toBe(UPDATES_POLL_IDLE_COLD_MS);
    expect(getUpdatesPollDelay(600_000)).toBe(UPDATES_POLL_IDLE_COLD_MS);
    expect(getUpdatesPollDelay(899_999)).toBe(UPDATES_POLL_IDLE_COLD_MS);
  });

  it('stops polling (returns null) for idle users >= 15 min', () => {
    expect(getUpdatesPollDelay(900_000)).toBeNull();
    expect(getUpdatesPollDelay(1_800_000)).toBeNull();
  });

  it('returns fallback sync delays appropriately', () => {
    expect(getFallbackSyncPollDelay(false)).toBeNull();
    expect(getFallbackSyncPollDelay(true, 0)).toBe(FALLBACK_SYNC_FAST_MS);
    expect(getFallbackSyncPollDelay(true, 1)).toBe(FALLBACK_SYNC_SLOW_MS);
    expect(getFallbackSyncPollDelay(true, 5)).toBe(FALLBACK_SYNC_SLOW_MS);
  });
});

