import type { createAdminClient } from '@/lib/supabase/admin';
import type { runSync } from './engine';

/** Acknowledge a push only once the saved queue and its history boundary are covered. */
export async function drainPersonalPush(params: {
  admin: ReturnType<typeof createAdminClient>;
  sync: typeof runSync;
  userId: string;
  accountId: string;
  historyId?: string;
}) {
  const globalDeadline = Date.now() + 240_000;
  let previousCursor: string | null = null;
  for (let runs = 0; runs < 20 && Date.now() < globalDeadline - 5000; runs++) {
    const result = await params.sync(params.userId, undefined, { isBackgroundCron: true, globalDeadline });
    if (result.alreadyRunning) throw new Error('Personal sync is already running; retry this push');
    if (result.paused) throw new Error('Personal sync paused at a saved checkpoint; retry this push');
    if (result.errors.length) throw new Error(result.errors.join('; '));
    if (result.hasMorePagesPending) continue;
    const { data, error } = await params.admin.from('gmail_accounts').select('last_history_id')
      .eq('id', params.accountId).eq('user_id', params.userId).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Connected account disappeared during push sync');
    const cursor = data.last_history_id || '';
    if (!params.historyId || (/^\d+$/.test(cursor) && /^\d+$/.test(params.historyId)
      && BigInt(cursor) >= BigInt(params.historyId))) return;
    // A resumed queue may need one fresh discovery pass. If that pass cannot
    // advance the cursor, let Pub/Sub back off instead of spinning no-op syncs.
    if (cursor === previousCursor) break;
    previousCursor = cursor;
  }
  throw new Error('Personal sync has saved work remaining; retry this push');
}
