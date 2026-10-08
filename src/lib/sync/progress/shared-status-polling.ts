export interface SharedStatusPollState {
  isSyncing: boolean;
  hasMoreArchivePages?: boolean;
  complete?: boolean;
  pendingMessages?: number;
}

/**
 * Returns the next poll delay in ms, or null to stop polling.
 * - Active sync or pending messages: 5s
 * - Archive pages remain but currently idle: 30s (cron will pick it up)
 * - Complete & idle: stop polling (null)
 */
export function getSharedStatusPollDelay(status: SharedStatusPollState | null): number | null {
  if (!status) return null;
  if (status.isSyncing) return 5_000;
  if ((status.pendingMessages ?? 0) > 0) return 5_000;
  if (status.hasMoreArchivePages || status.complete === false) return 30_000;
  return null;
}
