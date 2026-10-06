import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';

import { currentMutationLease, withOwnedMutationLease } from './lease-context';
export { currentMutationLease, withOwnedMutationLease } from './lease-context';

export class MutationBusyError extends Error {
  constructor() { super('A sync or reprocess is already running for this user.'); this.name = 'MutationBusyError'; }
}

export async function assertMutationLease(): Promise<void> {
  const lease = currentMutationLease();
  if (!lease) throw new Error('User mutation requires a sync lease');
  const { data, error } = await createAdminClient().rpc('assert_sync_lease', { p_user_id: lease.userId, p_run_id: lease.runId });
  if (error || data !== true) throw new Error('Sync lease lost; stopping user mutations');
}

/** All entry points share the database lease; nested calculations reuse the owner. */
export async function withUserMutationLease<T>(userId: string, work: () => Promise<T>): Promise<T> {
  const existing = currentMutationLease();
  if (existing?.userId === userId) { await assertMutationLease(); return work(); }
  const supabase = createAdminClient();
  const runId = randomUUID();
  const { data, error } = await supabase.rpc('acquire_sync_lease', { p_user_id: userId, p_run_id: runId, p_lease_seconds: 300 });
  if (error) throw error;
  if (data !== true) throw new MutationBusyError();
  return withOwnedMutationLease(userId, runId, async () => {
    let lost = false;
    const timer = setInterval(() => {
      void supabase.rpc('update_sync_lease', { p_user_id: userId, p_run_id: runId, p_progress: { phase: 'processing' }, p_lease_seconds: 300 })
        .then(({ data, error }) => { if (error || data !== true) lost = true; });
    }, 30_000);
    try {
      const result = await work();
      if (lost) throw new Error('Sync lease lost during reprocess');
      return result;
    } finally {
      clearInterval(timer);
      const { error } = await supabase.rpc('release_sync_lease', { p_user_id: userId, p_run_id: runId, p_phase: lost ? 'error' : 'complete', p_last_error: lost ? 'Lease lost' : null });
      if (error) console.error('[Mutation lease] Release failed', error.message);
    }
  });
}
