/**
 * Canonical normalization for placement-drive numbers.
 *
 * This is the single source of truth shared by:
 *  - the live sync-time resolver (`src/lib/sync/drive-resolution.ts`, `resolvePlacementDrive`)
 *  - the Phase 3 legacy-data migration resolver (`src/lib/migration/phase3/resolve-drive.ts`)
 *
 * Both call sites decide drive identity, and both must treat "the same" drive number
 * identically. Previously this function was copy-pasted into both files; any future edit to
 * one copy (e.g. stripping punctuation, collapsing whitespace) without an identical edit to the
 * other would silently make new-email resolution and legacy-backfill resolution disagree about
 * whether two records reference the same drive. Since a mismatch here is a data-identity bug,
 * not a rendering bug, it is centralized once instead of duplicated.
 */
export function normalizeDriveNumber(driveNumber: string | null | undefined): string | null {
  const normalized = driveNumber?.trim().toLowerCase() || '';
  return normalized || null;
}
