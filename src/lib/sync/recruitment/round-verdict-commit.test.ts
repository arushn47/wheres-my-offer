import { afterEach, describe, expect, it, vi } from 'vitest';
import type { createAdminClient } from '@/lib/supabase/admin';
import { withOwnedMutationLease } from '../lease-context';
import { commitDriveRoundVerdicts, dispatchRoundNotificationOutbox } from './round-verdict-service';
import type { RoundVerdict } from './round-verdict';
import { sendNotification } from '@/lib/notifications/service';
import type { CreateNotificationParams } from '@/lib/notifications/service';
vi.mock('@/lib/notifications/service', () => ({ sendNotification: vi.fn(async () => ({ complete: true })) }));
type Admin = ReturnType<typeof createAdminClient>;
afterEach(() => vi.clearAllMocks());
const verdict = (overrides: Partial<RoundVerdict> = {}): RoundVerdict => ({
  roundKey: 'test:1', roundType: 'test', state: 'verified_present', eligible: true, finalNegative: false,
  reason: 'matched', sourceEmailId: 'source', sourceReceivedAt: new Date().toISOString(), rosterKey: 'hash', parserVersion: 4, evaluations: [], ...overrides,
});
function database() {
  const pending: Array<{ id: string; decision_id: string; payload: CreateNotificationParams; round_verdicts: { is_current: boolean; verdict: RoundVerdict } }> = [];
  const dedupeKeys = new Set<string>();
  const rpc = vi.fn(async (name: string, raw: Record<string, unknown>): Promise<{ data: string | boolean | null; error: { message: string } | null }> => {
    const args = raw as unknown as { p_drive_id: string; p_notification: CreateNotificationParams | null; p_is_current: boolean; p_verdict: RoundVerdict };
    if (name === 'assert_sync_lease') return { data: true, error: null };
    if (name !== 'commit_round_verdict') throw new Error(`Unexpected RPC ${name}`);
    const id = `decision-${args.p_drive_id}`;
    const key = args.p_notification?.dedupeKey;
    if (args.p_notification && key && !dedupeKeys.has(key)) {
      dedupeKeys.add(key);
      pending.push({ id: `outbox-${id}`, decision_id: id, payload: args.p_notification, round_verdicts: { is_current: args.p_is_current, verdict: args.p_verdict } });
    }
    return { data: id, error: null };
  });
  let reads = 0, updates = 0;
  const from = vi.fn((table: string) => {
    if (table !== 'decision_notification_outbox') throw new Error(`Unexpected table ${table}`);
    let updating = false, rowId: string | null = null;
    const query = { select: () => query, eq: (_field: string, value: string) => { rowId = value; return query; }, is: () => query,
      update: () => { updating = true; return query; }, then: (resolve: (value: unknown) => unknown) => {
        if (updating) { updates++; const index = pending.findIndex(row => row.id === rowId); if (index >= 0) pending.splice(index, 1); return resolve({ data: null, error: null }); }
        reads++; return resolve({ data: [...pending], error: null });
      } };
    return query;
  });
  return { admin: { rpc, from } as unknown as Admin, rpc, from, pending, counts: () => ({ reads, updates }) };
}

describe('atomic verdict commits and outbox request benchmark', () => {
  const absent = (overrides: Partial<RoundVerdict> = {}) => verdict({ eligible: false, state: 'verified_absent', finalNegative: true, reason: 'complete_list_absence', evaluations: [{ emailId: 'source', state: 'verified_absent', rosterKey: 'hash' }], ...overrides });
  it('leaves stale or partial negative payloads dormant instead of delivering the wrong outcome', async () => {
    const db = database();
    for (const v of [verdict(), absent({ finalNegative: false })]) {
      db.pending.push({ id: 'stale', decision_id: 'decision', payload: { userId: 'alice', placementDriveId: 'drive', type: 'shortlist_match', title: 'Not Shortlisted: Company', body: 'Fixture', dedupeKey: 'shortlist_absent:alice:drive' }, round_verdicts: { is_current: true, verdict: v } });
    }
    await withOwnedMutationLease('alice', 'run', () => dispatchRoundNotificationOutbox(db.admin, 'alice'));
    expect(sendNotification).not.toHaveBeenCalled(); expect(db.counts().updates).toBe(0);
  });
  it('immediately delivers a confirmed negative after an unchanged drain, once across roster revisions', async () => {
    const db = database();
    await withOwnedMutationLease('alice', 'run', async () => {
      await dispatchRoundNotificationOutbox(db.admin, 'alice');
      await commitDriveRoundVerdicts(db.admin, 'alice', 'one', 'Company', [absent()], 'not_shortlisted');
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Not Shortlisted: Company', type: 'shortlist_match', dedupeKey: 'shortlist_absent:alice:one', decisionId: 'decision-one' }));
      await commitDriveRoundVerdicts(db.admin, 'alice', 'one', 'Company', [absent({ rosterKey: 'revised' })], 'not_shortlisted');
      expect(sendNotification).toHaveBeenCalledTimes(1);
      await commitDriveRoundVerdicts(db.admin, 'alice', 'two', 'Company', [absent()], 'not_shortlisted');
      expect(sendNotification).toHaveBeenCalledTimes(2);
    });
  });
  it.each(['withdrawn', 'declined', 'not_applied', 'registration_open', 'unknown'])('never queues a negative for %s', async status => {
    const db = database();
    await withOwnedMutationLease('alice', 'run', () => commitDriveRoundVerdicts(db.admin, 'alice', 'one', 'Company', [absent()], status));
    expect(db.rpc.mock.calls[0][1].p_notification).toBeNull(); expect(sendNotification).not.toHaveBeenCalled();
  });
  it.each([{ finalNegative: false }, { state: 'deferred' as const }, { reason: 'partial_list_absence' as const }, { evaluations: [] }])('does not alert uncertain negative evidence %j', async overrides => {
    const db = database();
    await withOwnedMutationLease('alice', 'run', () => commitDriveRoundVerdicts(db.admin, 'alice', 'one', 'Company', [absent(overrides)], 'applied'));
    expect(db.rpc.mock.calls[0][1].p_notification).toBeNull(); expect(sendNotification).not.toHaveBeenCalled();
  });
  it('does not alert suppressed catch-up or old eliminations', async () => {
    const db = database();
    await withOwnedMutationLease('alice', 'run', async () => {
      await commitDriveRoundVerdicts(db.admin, 'alice', 'one', 'Company', [absent()], 'not_shortlisted', true);
      await commitDriveRoundVerdicts(db.admin, 'alice', 'two', 'Company', [absent({ sourceReceivedAt: '2025-01-01T00:00:00Z' })], 'not_shortlisted');
    });
    expect(db.rpc.mock.calls.every(call => call[1].p_notification === null)).toBe(true);
    expect(sendNotification).not.toHaveBeenCalled();
  });
  it('only notifies the current first elimination, not each later absent round', async () => {
    const db = database(); const time = Date.now()-60000;
    const rounds = [absent({ sourceReceivedAt: new Date(time).toISOString() }), absent({ roundKey: 'interview:1', sourceReceivedAt: new Date(time+1000).toISOString() })];
    await withOwnedMutationLease('alice', 'run', () => commitDriveRoundVerdicts(db.admin, 'alice', 'one', 'Company', rounds, 'not_shortlisted'));
    expect(db.rpc.mock.calls[0][1].p_notification).not.toBeNull(); expect(db.rpc.mock.calls[1][1].p_notification).toBeNull();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
  it('retains the owned run ID and atomic event payload; lease loss stops before delivery', async () => {
    const db = database(); const events = [{ event_type: 'test', start_time: '2026-10-10T10:00:00Z' }];
    await withOwnedMutationLease('alice', 'owned', () => commitDriveRoundVerdicts(db.admin, 'alice', 'drive', 'Company', [verdict()], 'shortlisted', false, events));
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc.mock.calls[0]).toMatchObject(['commit_round_verdict', { p_user_id: 'alice', p_run_id: 'owned', p_events: events, p_status: 'shortlisted', p_is_current: true }]);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const lost = database(); lost.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Sync lease lost' } });
    await expect(withOwnedMutationLease('alice', 'expired', () => commitDriveRoundVerdicts(lost.admin, 'alice', 'drive', 'Company', [verdict()], 'shortlisted'))).rejects.toMatchObject({ message: 'Sync lease lost' });
    expect(lost.from).not.toHaveBeenCalled();
    await expect(commitDriveRoundVerdicts(lost.admin, 'alice', 'drive', 'Company', [], 'applied')).rejects.toThrow('requires the user lease');
  });
  it('measures eight historical drive commits and two completion drains without changing notifications', async () => {
    const before = database(), after = database(); const historical = verdict({ sourceReceivedAt: '2025-01-01T00:00:00Z' });
    // Frozen old request sequence: a preflight RPC per drive, atomic commit,
    // and an outbox read per drive plus catch-up and engine completion reads.
    for (let i = 0; i < 8; i++) {
      await before.admin.rpc('assert_sync_lease', { p_user_id: 'alice', p_run_id: 'before' });
      await before.admin.rpc('commit_round_verdict', { p_user_id: 'alice', p_run_id: 'before', p_drive_id: `drive-${i}`, p_verdict: historical, p_status: 'shortlisted', p_is_current: true, p_notification: null, p_events: null });
      await dispatchRoundNotificationOutbox(before.admin, 'alice');
    }
    await dispatchRoundNotificationOutbox(before.admin, 'alice'); await dispatchRoundNotificationOutbox(before.admin, 'alice');
    await withOwnedMutationLease('alice', 'after', async () => {
      for (let i = 0; i < 8; i++) await commitDriveRoundVerdicts(after.admin, 'alice', `drive-${i}`, 'Company', [historical], 'shortlisted');
      await dispatchRoundNotificationOutbox(after.admin, 'alice'); await dispatchRoundNotificationOutbox(after.admin, 'alice');
    });
    const summary = (db: ReturnType<typeof database>) => ({ rpc: db.rpc.mock.calls.length, outboxReads: db.counts().reads, requests: db.rpc.mock.calls.length + db.counts().reads + db.counts().updates });
    console.info('COMMIT_BENCHMARK', JSON.stringify({ before: summary(before), after: summary(after) }));
    expect(summary(before)).toEqual({ rpc: 16, outboxReads: 10, requests: 26 });
    expect(summary(after)).toEqual({ rpc: 8, outboxReads: 1, requests: 9 });
    expect(sendNotification).not.toHaveBeenCalled();
  });
  it('delivers each new eligible decision immediately and dedupes a repeated commit', async () => {
    const db = database();
    await withOwnedMutationLease('alice', 'run', async () => {
      await commitDriveRoundVerdicts(db.admin, 'alice', 'one', 'Company', [verdict()], 'shortlisted');
      expect(sendNotification).toHaveBeenCalledTimes(1);
      await commitDriveRoundVerdicts(db.admin, 'alice', 'one', 'Company', [verdict()], 'shortlisted');
      expect(sendNotification).toHaveBeenCalledTimes(1);
      await commitDriveRoundVerdicts(db.admin, 'alice', 'two', 'Company', [verdict()], 'shortlisted');
      expect(sendNotification).toHaveBeenCalledTimes(2);
      expect(db.counts()).toEqual({ reads: 2, updates: 2 });
    });
  });
  it.each(['withdrawn', 'declined'])('does not queue notification for %s', async status => {
    const db = database();
    await withOwnedMutationLease('alice', 'run', () => commitDriveRoundVerdicts(db.admin, 'alice', 'one', 'Company', [verdict()], status));
    expect(db.rpc.mock.calls[0][1].p_notification).toBeNull();
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
