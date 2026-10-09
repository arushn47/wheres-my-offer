import type { createAdminClient } from '@/lib/supabase/admin';
import { currentMutationLease } from '../mutation-lease';
import { isConfirmedNegativeRound, negativeRoundNotificationKey } from './round-notification-policy';
import type { RoundVerdict } from './round-verdict';
import { dispatchRoundNotificationOutbox } from './round-verdict-service';
import { noteRoundOutboxCommit } from './outbox-dispatch';

/** Explicit reviewed IDs only. Never scans inboxes, recalculates status, or acquires a lease. */
export async function recoverNegativeRoundNotifications(
  supabase: ReturnType<typeof createAdminClient>, userId: string, decisionIds: string[],
): Promise<number> {
  const lease = currentMutationLease();
  if (!lease || lease.userId !== userId) throw new Error('Negative notification recovery requires the user lease');
  const ids = [...new Set(decisionIds)];
  if (!ids.length || ids.length > 20) throw new Error('Recovery requires 1–20 explicitly reviewed decision IDs');
  const { data, error } = await supabase.from('round_verdicts')
    .select('id,placement_drive_id,verdict,placement_drives!inner(companies!inner(name))')
    .eq('user_id', userId).eq('is_current', true).in('id', ids);
  if (error) throw error;
  let queued = 0;
  for (const decision of (data || []) as unknown as Array<{ id: string; placement_drive_id: string; verdict: RoundVerdict; placement_drives: { companies: { name: string } } }>) {
    if (!isConfirmedNegativeRound(decision.verdict)) continue;
    const payload = {
      userId, placementDriveId: decision.placement_drive_id, type: 'shortlist_match',
      title: `Not Shortlisted: ${decision.placement_drives.companies.name}`,
      body: decision.verdict.outcome === 'rejected' ? 'Your personal placement email confirms you were not selected.' : 'Your identifier was not found in the confirmed complete shortlist for this round.',
      dedupeKey: negativeRoundNotificationKey(userId, decision.placement_drive_id),
    };
    const { data: enqueued, error: queueError } = await supabase.rpc('enqueue_negative_round_notification', {
      p_user_id: userId, p_run_id: lease.runId, p_decision_id: decision.id, p_notification: payload,
    });
    if (queueError) throw queueError;
    if (enqueued) { queued++; noteRoundOutboxCommit(userId, decision.id, payload.dedupeKey); }
  }
  await dispatchRoundNotificationOutbox(supabase, userId);
  return queued;
}
