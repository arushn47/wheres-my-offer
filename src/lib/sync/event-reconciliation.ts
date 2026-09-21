import { createAdminClient } from '@/lib/supabase/admin';
import { getEffectiveStage } from '@/lib/stages';

/**
 * Automatically reconciles and updates application statuses in the database
 * when scheduled events conclude:
 * - test_scheduled / test_ongoing -> test_completed (when test event ends and no subsequent round exists)
 * - ppt_scheduled / ppt_ongoing -> ppt_completed (when ppt event ends and no subsequent round exists)
 * - interview_scheduled / interview_ongoing -> interview_completed (when interview event ends and no subsequent round exists)
 *
 * Honors manual_override: true applications (never modifies user-forced statuses).
 *
 * @param supabase Admin Supabase client
 * @param userId User UUID
 * @param targetPlacementDriveId Optional drive ID to limit reconciliation to a single drive
 */
export async function reconcileElapsedEventStatuses(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  targetPlacementDriveId?: string | null
): Promise<{ updatedCount: number; updatedDrives: string[] }> {
  try {
    let appQuery = supabase
      .from('applications')
      .select('id, placement_drive_id, status, manual_override, notes')
      .eq('user_id', userId)
      .eq('manual_override', false)
      .in('status', [
        'test_scheduled',
        'test_ongoing',
        'ppt_scheduled',
        'ppt_ongoing',
        'interview_scheduled',
        'interview_ongoing',
      ]);

    if (targetPlacementDriveId) {
      appQuery = appQuery.eq('placement_drive_id', targetPlacementDriveId);
    }

    const { data: scheduledApps, error: appErr } = await appQuery;
    if (appErr || !scheduledApps || scheduledApps.length === 0) {
      return { updatedCount: 0, updatedDrives: [] };
    }

    const driveIds = Array.from(new Set(scheduledApps.map((a) => a.placement_drive_id).filter(Boolean)));
    if (driveIds.length === 0) {
      return { updatedCount: 0, updatedDrives: [] };
    }

    const { data: events, error: eventErr } = await supabase
      .from('events')
      .select('id, event_type, title, start_time, end_time, placement_drive_id')
      .eq('user_id', userId)
      .in('placement_drive_id', driveIds);

    if (eventErr || !events) {
      return { updatedCount: 0, updatedDrives: [] };
    }

    // Group events by placement_drive_id
    const eventsByDrive = new Map<string, typeof events>();
    for (const evt of events) {
      if (!evt.placement_drive_id) continue;
      const list = eventsByDrive.get(evt.placement_drive_id) || [];
      list.push(evt);
      eventsByDrive.set(evt.placement_drive_id, list);
    }

    const updatedDrives: string[] = [];

    for (const app of scheduledApps) {
      if (!app.placement_drive_id) continue;
      const driveEvents = eventsByDrive.get(app.placement_drive_id) || [];
      if (driveEvents.length === 0) continue;

      const effective = getEffectiveStage(app.status, null, driveEvents, app.notes, false);
      const effStatus = effective.effectiveStatus;

      let targetStatus: string | null = null;

      if (
        ['test_scheduled', 'test_ongoing'].includes(app.status) &&
        effStatus === 'test_completed'
      ) {
        targetStatus = 'test_completed';
      } else if (
        ['ppt_scheduled', 'ppt_ongoing'].includes(app.status) &&
        effStatus === 'ppt_completed'
      ) {
        targetStatus = 'ppt_completed';
      } else if (
        ['interview_scheduled', 'interview_ongoing'].includes(app.status) &&
        effStatus === 'interview_completed'
      ) {
        targetStatus = 'interview_completed';
      }

      if (targetStatus && targetStatus !== app.status) {
        const { error: updateErr } = await supabase
          .from('applications')
          .update({
            status: targetStatus,
            last_updated: new Date().toISOString(),
          })
          .eq('id', app.id);

        if (!updateErr) {
          updatedDrives.push(app.placement_drive_id);
        } else {
          console.warn(`[reconcileElapsedEventStatuses] Failed to update application ${app.id}:`, updateErr);
        }
      }
    }

    return { updatedCount: updatedDrives.length, updatedDrives };
  } catch (err) {
    console.warn('[reconcileElapsedEventStatuses] Error during elapsed events reconciliation:', err);
    return { updatedCount: 0, updatedDrives: [] };
  }
}
