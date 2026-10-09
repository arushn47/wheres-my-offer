import { describe, expect, it, vi } from 'vitest';
import type { createAdminClient } from '@/lib/supabase/admin';
import { withOwnedMutationLease } from './lease-context';
import { invalidateCircularRoutingRead, reuseRunRead } from './run-reads';
import { loadUserCandidateIdentity } from './identity/user-identity';

describe('processing run reads', () => {
  it('benchmarks eight candidate identity loads before/after processing-run reuse', async () => {
    let requests = 0;
    const from = (table: string) => {
      requests++;
      const result = { data: table === 'users' ? { id: 'alice', name: 'Alice Candidate', neo_id: 'NEO123', email: 'alice@example.com' } : [{ email: 'alice@vitbhopal.ac.in', account_type: 'college' }], error: null };
      const query = { select: () => query, eq: () => query, maybeSingle: async () => result, then: (resolve: (value: unknown) => unknown) => resolve(result) };
      return query;
    };
    const admin = { from } as unknown as ReturnType<typeof createAdminClient>;
    const before = [];
    for (let i = 0; i < 8; i++) before.push(await loadUserCandidateIdentity(admin, 'alice'));
    const beforeRequests = requests; requests = 0;
    const after = await withOwnedMutationLease('alice', 'run', () => Promise.all(Array.from({ length: 8 }, () => loadUserCandidateIdentity(admin, 'alice'))));
    expect(after).toEqual(before); expect(beforeRequests).toBe(16); expect(requests).toBe(2);
    console.info('IDENTITY_BENCHMARK', JSON.stringify({ loads: 8, beforeRequests, afterRequests: requests }));
  });
  it('shares concurrent identity reads and keeps users, runs and standalone calls isolated', async () => {
    const from = vi.fn((table: string) => {
      let id = '';
      const query = { select: () => query, eq: (_field: string, value: string) => { id = value; return query; },
        maybeSingle: async () => ({ data: { id, name: id, neo_id: `NEO${id}`, email: `${id}@example.com` }, error: null }),
        then: (resolve: (result: unknown) => unknown) => resolve({ data: [{ email: `${id}@vitbhopal.ac.in`, account_type: 'college' }], error: null }) };
      expect(['users', 'gmail_accounts']).toContain(table);
      return query;
    });
    const admin = { from } as unknown as ReturnType<typeof createAdminClient>;
    await withOwnedMutationLease('alice', 'one', async () => {
      const identities = await Promise.all(Array.from({ length: 12 }, () => loadUserCandidateIdentity(admin, 'alice')));
      expect(from).toHaveBeenCalledTimes(2);
      expect(identities.every(identity => identity === identities[0])).toBe(true);
      expect((await loadUserCandidateIdentity(admin, 'bob')).neoId).toBe('NEOBOB');
      expect(from).toHaveBeenCalledTimes(4);
    });
    await withOwnedMutationLease('alice', 'two', () => loadUserCandidateIdentity(admin, 'alice'));
    await loadUserCandidateIdentity(admin, 'alice');
    expect(from).toHaveBeenCalledTimes(8);
  });
  it('does not retain failed reads or a routing snapshot invalidated while in flight', async () => {
    await withOwnedMutationLease('alice', 'one', async () => {
      const read = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue('fresh');
      await expect(reuseRunRead('alice', 'identity', read)).rejects.toThrow('unavailable');
      expect(await reuseRunRead('alice', 'identity', read)).toBe('fresh');
      let finish!: (value: string) => void;
      const first = reuseRunRead(null, 'circular-routing', () => new Promise<string>(resolve => { finish = resolve; }));
      invalidateCircularRoutingRead();
      const replacement = reuseRunRead(null, 'circular-routing', async () => 'new revision');
      finish('old revision');
      expect(await first).toBe('old revision');
      expect(await replacement).toBe('new revision');
      expect(await reuseRunRead(null, 'circular-routing', async () => 'incorrect')).toBe('new revision');
    });
  });
  it('propagates identity read errors instead of caching an incomplete identity', async () => {
    const error = new Error('profile unavailable');
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }) };
    await expect(loadUserCandidateIdentity({ from: () => query } as unknown as ReturnType<typeof createAdminClient>, 'alice')).rejects.toBe(error);
  });
});
