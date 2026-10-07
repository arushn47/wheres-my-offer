/** Onboarding may need the full history; an incremental run only changes touched drives. */
export function postSyncDriveScope(initialPagesCompleted: boolean, touchedDriveIds: Iterable<string>): string[] | undefined {
  if (initialPagesCompleted) return undefined;
  const ids = [...new Set(touchedDriveIds)].filter(Boolean);
  // Retain the existing recovery path if an earlier processing failure recorded no IDs.
  return ids.length ? ids : undefined;
}

/** A requested scope narrows existing participation evidence; it cannot create eligibility. */
export function restrictEligibleDrives(eligibleDriveIds: Set<string>, targetDriveIds?: string[]): Set<string> {
  if (targetDriveIds === undefined) return eligibleDriveIds;
  return new Set(targetDriveIds.filter(id => eligibleDriveIds.has(id)));
}
