import type { createAdminClient } from '@/lib/supabase/admin';
import type { RecruitmentVenues, VenueEntry } from './drive-venues';
type Admin = ReturnType<typeof createAdminClient>;
const missing = (error: { code?: string }) => ['42703', 'PGRST204', 'PGRST202', '42883'].includes(error.code || '');

/** One compact batch per 200 drives; absent migration safely renders TBA. No bodies or events. */
export async function readDriveVenues(admin: Admin, driveIds: string[]) {
  const result = new Map<string, RecruitmentVenues>();
  const ids = [...new Set(driveIds.filter(Boolean))];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const { data, error } = await admin.from('placement_drives').select('id,recruitment_venues,excluded_email_ids').in('id', ids.slice(offset, offset + 200));
    if (error) { if (missing(error)) return result; throw error; }
    for (const row of data || []) {
      const projection = row.recruitment_venues as RecruitmentVenues | null;
      if (projection?.version === 1 && Array.isArray(projection.entries)) {
        const excluded = new Set(row.excluded_email_ids || []);
        result.set(row.id, { ...projection, entries: projection.entries.filter(entry => entry && !excluded.has(entry.sourceId)) });
      }
    }
  }
  return result;
}

/** Atomic display-only merge; independent of status, activity, calendar and notifications. */
export async function persistDriveVenues(admin: Admin, driveId: string, sourceId: string, receivedAt: string, entries: VenueEntry[]) {
  if (!entries.length) return;
  const { error } = await admin.rpc('merge_drive_recruitment_venues', { p_drive_id: driveId, p_source_id: sourceId, p_received_at: receivedAt, p_entries: entries });
  if (error && !missing(error)) throw error;
}
