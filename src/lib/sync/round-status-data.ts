import type { createAdminClient } from '@/lib/supabase/admin';
import { summarizeRoundDecisions, type RoundStatusDecision } from './round-status';

/** User-specific outcomes only; shared circulars never establish participation. */
export async function loadRoundStatusSummaries(supabase: ReturnType<typeof createAdminClient>, userId: string) {
  const { data, error } = await supabase.from('round_verdicts')
    .select('placement_drive_id,verdict,is_current').eq('user_id', userId);
  if (error) throw error;
  const grouped = new Map<string, Array<{ verdict: RoundStatusDecision; is_current: boolean }>>();
  for (const row of data || []) {
    const rows = grouped.get(row.placement_drive_id) || [];
    rows.push(row);
    grouped.set(row.placement_drive_id, rows);
  }
  return new Map([...grouped].map(([driveId, rows]) => [driveId, summarizeRoundDecisions(rows)]));
}
