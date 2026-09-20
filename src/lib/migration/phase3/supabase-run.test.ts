import { describe, expect, it } from 'vitest';
import {
  runSupabasePhase3Migration,
  type SupabasePhase3MigrationParams,
} from './run';
import type { Phase3DiscoveryTableQuery, Phase3ReadQuery } from './discovery';

const USER_A = 'user-a';

type RpcCall = { fn: string; params?: Record<string, unknown> };

function makeSupabase(): SupabasePhase3MigrationParams['supabase'] & {
  fromTables: string[];
  rpcCalls: RpcCall[];
} {
  const fromTables: string[] = [];
  const rpcCalls: RpcCall[] = [];
  return {
    fromTables,
    rpcCalls,
    from(table) {
      fromTables.push(table);
      const query: Phase3ReadQuery<Record<string, unknown>> = {
        eq() {
          return query;
        },
        then<TResult1 = { data: Record<string, unknown>[] | null; error: { message: string } | null }, TResult2 = never>(
          onfulfilled?: ((
            value: { data: Record<string, unknown>[] | null; error: { message: string } | null }
          ) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) {
          return Promise.resolve({ data: [], error: null }).then(onfulfilled, onrejected);
        },
      };
      const tableQuery: Phase3DiscoveryTableQuery = {
        select() {
          return query;
        },
      };
      return tableQuery;
    },
    async rpc(fn, params) {
      rpcCalls.push({ fn, params });
      if (fn === 'phase3_preflight_report') {
        return { data: [{ check_name: 'ok', status: 'PASS', details: '' }], error: null };
      }
      throw new Error(`unexpected write RPC: ${fn}`);
    },
  };
}

describe('runSupabasePhase3Migration', () => {
  it('wires one Supabase client through discovery and dry-run execution without writes', async () => {
    const supabase = makeSupabase();

    const summary = await runSupabasePhase3Migration({
      supabase,
      userIds: [USER_A],
    });

    expect(summary.mode).toBe('dry-run');
    expect(summary.readOnly).toBe(true);
    expect(summary.users[0].outcome).toEqual({ kind: 'dry_run' });
    expect(supabase.fromTables).toEqual([
      'placement_drives',
      'emails',
      'applications',
      'events',
      'notifications',
      'candidate_matches',
    ]);
    expect(supabase.rpcCalls).toEqual([{ fn: 'phase3_preflight_report', params: undefined }]);
  });
});
