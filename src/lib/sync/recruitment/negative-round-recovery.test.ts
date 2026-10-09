import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { createAdminClient } from '@/lib/supabase/admin';
import { withOwnedMutationLease } from '../lease-context';
vi.mock('./round-verdict-service', () => ({ dispatchRoundNotificationOutbox: vi.fn(async () => {}) }));
import { dispatchRoundNotificationOutbox } from './round-verdict-service';
import { recoverNegativeRoundNotifications } from './negative-round-recovery';
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const verdict = { eligible: false, state: 'verified_absent', finalNegative: true, reason: 'complete_list_absence', evaluations: [{ state: 'verified_absent' }] };
  const row = { id: 'reviewed', placement_drive_id: 'drive', verdict, placement_drives: { companies: { name: 'Fixture' } } };
  const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain), in: vi.fn(async () => ({ data: [row], error: null })) };
  const rpc = vi.fn(async () => ({ data: true, error: null }));
  const from = vi.fn(() => chain);
  return { row, rpc, from, chain, admin: { from, rpc } as unknown as ReturnType<typeof createAdminClient> };
}
describe('explicit negative notification recovery', () => {
  it('requires an owned lease and explicit bounded IDs before reading anything', async () => {
    const db = fixture();
    await expect(recoverNegativeRoundNotifications(db.admin, 'alice', ['reviewed'])).rejects.toThrow('requires the user lease');
    await withOwnedMutationLease('alice', 'run', async () => {
      await expect(recoverNegativeRoundNotifications(db.admin, 'bob', ['reviewed'])).rejects.toThrow('requires the user lease');
      await expect(recoverNegativeRoundNotifications(db.admin, 'alice', [])).rejects.toThrow('explicitly reviewed');
      await expect(recoverNegativeRoundNotifications(db.admin, 'alice', Array.from({ length: 21 }, (_, i) => String(i)))).rejects.toThrow('explicitly reviewed');
    });
    expect(db.from).not.toHaveBeenCalled();expect(db.rpc).not.toHaveBeenCalled();
  });
  it('only reads requested current user decisions and queues existing verdicts without reprocessing', async () => {
    const db = fixture();
    await withOwnedMutationLease('alice', 'run', () => expect(recoverNegativeRoundNotifications(db.admin, 'alice', ['reviewed','reviewed'])).resolves.toBe(1));
    expect(db.from).toHaveBeenCalledExactlyOnceWith('round_verdicts');
    expect(db.chain.eq).toHaveBeenCalledWith('user_id','alice'); expect(db.chain.eq).toHaveBeenCalledWith('is_current',true);
    expect(db.chain.in).toHaveBeenCalledExactlyOnceWith('id',['reviewed']);
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('enqueue_negative_round_notification',expect.objectContaining({ p_user_id: 'alice', p_run_id: 'run', p_decision_id: 'reviewed', p_notification: expect.objectContaining({ dedupeKey: 'shortlist_absent:alice:drive' }) }));
    expect(dispatchRoundNotificationOutbox).toHaveBeenCalledExactlyOnceWith(db.admin,'alice');
  });
  it('does not queue partial evidence or force recovery rejected by database guards', async () => {
    const db = fixture();db.row.verdict.finalNegative=false;
    await withOwnedMutationLease('alice', 'run', () => expect(recoverNegativeRoundNotifications(db.admin, 'alice', ['reviewed'])).resolves.toBe(0));
    expect(db.rpc).not.toHaveBeenCalled();
    db.row.verdict.finalNegative=true;db.rpc.mockResolvedValue({ data: false, error: null });
    await withOwnedMutationLease('alice', 'run2', () => expect(recoverNegativeRoundNotifications(db.admin, 'alice', ['reviewed'])).resolves.toBe(0));
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
});
