/**
 * Adaptive polling delay calculators for passive version checks and fallback sync status.
 * Reduces client request amplification and serverless compute consumption.
 */

export const UPDATES_POLL_ACTIVE_MS = 30_000;     // 30s while actively interacting
export const UPDATES_POLL_IDLE_WARM_MS = 60_000;  // 60s when idle 2-5 min
export const UPDATES_POLL_IDLE_COLD_MS = 120_000; // 120s when idle 5-15 min
export const UPDATES_POLL_STOP_MS = 900_000;      // 15 min idle threshold to cease polling

/**
 * Calculates the next updates poll delay based on elapsed user idle time.
 * Returns null if user has been idle for >= 15 minutes, indicating polling should stop.
 */
export function getUpdatesPollDelay(idleMs: number): number | null {
  if (idleMs < 0) return UPDATES_POLL_ACTIVE_MS;
  if (idleMs < 120_000) return UPDATES_POLL_ACTIVE_MS;
  if (idleMs < 300_000) return UPDATES_POLL_IDLE_WARM_MS;
  if (idleMs < UPDATES_POLL_STOP_MS) return UPDATES_POLL_IDLE_COLD_MS;
  return null;
}

export const FALLBACK_SYNC_FAST_MS = 5_000;  // 5s when sync progress is changing
export const FALLBACK_SYNC_SLOW_MS = 10_000; // 10s when sync progress is stationary

/**
 * Calculates the fallback sync status poll delay.
 * Returns null if sync is no longer active.
 */
export function getFallbackSyncPollDelay(isSyncing: boolean, consecutiveUnchanged = 0): number | null {
  if (!isSyncing) return null;
  return consecutiveUnchanged > 0 ? FALLBACK_SYNC_SLOW_MS : FALLBACK_SYNC_FAST_MS;
}

