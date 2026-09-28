export interface SharedStatusPollState {
  isSyncing: boolean;
}

export function getSharedStatusPollDelay(status: SharedStatusPollState | null): number | null {
  return status?.isSyncing ? 5_000 : null;
}
