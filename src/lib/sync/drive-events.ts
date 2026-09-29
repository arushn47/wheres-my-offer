import type { createAdminClient } from '@/lib/supabase/admin';

/** Removes a user's non-manual events for a drive (and their Google Calendar entries).
 *  Rows whose calendar delete failed are kept so the next run retries them. */
export async function removeDriveEvents(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  placementDriveId: string,
  opts: { excludeTypes?: string[]; onlyUnfinished?: boolean } = {}
): Promise<{ removed: number; failed: number }> {
  const { data: rows, error } = await supabase
    .from('events')
    .select('id, gcal_event_id, event_type, start_time, end_time, manual_override')
    .eq('user_id', userId)
    .eq('placement_drive_id', placementDriveId);
  if (error || !rows?.length) return { removed: 0, failed: 0 };

  const now = Date.now();
  const targets = rows.filter((row) => {
    if (row.manual_override) return false;
    if (opts.excludeTypes?.includes(row.event_type)) return false;
    if (opts.onlyUnfinished) {
      const end = row.end_time || row.start_time;
      if (end && new Date(end).getTime() <= now) return false; // keep history
    }
    return true;
  });
  if (!targets.length) return { removed: 0, failed: 0 };

  const { deleteEventFromGoogleCalendar } = await import('@/lib/calendar/google-sync');
  const deletable: string[] = [];
  let failed = 0;
  for (const row of targets) {
    if (row.gcal_event_id) {
      const ok = await deleteEventFromGoogleCalendar({ userId, companyName: '', eventId: row.gcal_event_id });
      if (!ok) { failed++; console.warn(`[drive-events] gcal delete failed for ${row.id}; will retry`); continue; }
    }
    deletable.push(row.id);
  }
  if (deletable.length) await supabase.from('events').delete().in('id', deletable);
  return { removed: deletable.length, failed };
}