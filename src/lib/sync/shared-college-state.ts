export interface SharedCollegeInitialScanState {
  initial_scan_complete: boolean;
  next_page_token: string | null;
  pending_next_page_token: string | null;
}

export function getInitialArchivePageState(state: SharedCollegeInitialScanState) {
  const isInitialArchiveScan = !state.initial_scan_complete || Boolean(state.next_page_token);
  return {
    isInitialArchiveScan,
    completingPendingInitialPage: Boolean(state.pending_next_page_token) && isInitialArchiveScan,
    completingLastInitialPage: isInitialArchiveScan && !state.pending_next_page_token,
  };
}

export function isSharedArchiveComplete(state: {
  initial_scan_complete: boolean;
  next_page_token: string | null;
  is_syncing: boolean;
  pending_count: number;
} | null | undefined): boolean {
  // `is_syncing` is a lease flag, not a measure of archive content: it is set for
  // the whole run (including the multi-minute per-user fan-out), it flaps on every
  // daily history sweep, and it stays stuck when a worker is killed before its
  // release call. Gating absence verification on it made "not shortlisted"
  // unreachable forever after a single crash, and silently retracted every
  // negative status while any sweep was running. The content-level signal is what
  // matters: every page consumed and no known-but-unprocessed message left.
  return Boolean(
    state &&
    state.initial_scan_complete &&
    !state.next_page_token &&
    state.pending_count === 0
  );
}
