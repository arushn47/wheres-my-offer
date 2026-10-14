import { cleanCompanyName, normalizeCompanyName } from '@/lib/sync/classification/classifier';

/** Clean category and registration noise while retaining the drive's track name. */
export function getDriveDisplayName(driveName?: string | null, companyName?: string | null): string {
  for (const name of [driveName, companyName]) {
    if (!name?.trim()) continue;
    const cleaned = cleanCompanyName(name.trim());
    if (cleaned) return normalizeCompanyName(cleaned);
  }
  return 'Placement Drive';
}
