import { describe, expect, it } from 'vitest';
import { createSupabaseRpcClient, type SupabaseRpcLike } from './rpc-client';
import type { RpcAction } from './assign';

const USER_A = '123e4567-e89b-42d3-a456-426614174000';
const ACTION: RpcAction = {
  action: 'create_drive_then_assign',
  record_type: 'application',
  record_id: '223e4567-e89b-42d3-a456-426614174000',
  user_id: USER_A,
  normalized_drive_number: 'pat-pl-2026-1',
};

function fakeRpc(
  response: { data: unknown; error: { message: string } | null }
): SupabaseRpcLike & { calls: Array<{ fn: string; params?: Record<string, unknown> }> } {
  const calls: Array<{ fn: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    async rpc(fn, params) {
      calls.push({ fn, params });
      return response;
    },
  };
}

describe('createSupabaseRpcClient', () => {
  it('maps PostgreSQL preflight column names into the validation contract', async () => {
    const supabase = fakeRpc({
      data: [
        { check_name: 'sync_in_progress', status: 'WARN', details: 'sync active' },
        { check_name: 'applications.drive_ownership', status: 'PASS', details: 'ok' },
      ],
      error: null,
    });

    await expect(createSupabaseRpcClient(supabase).preflightReport()).resolves.toEqual([
      { checkName: 'sync_in_progress', status: 'WARN', details: 'sync active' },
      { checkName: 'applications.drive_ownership', status: 'PASS', details: 'ok' },
    ]);
    expect(supabase.calls).toEqual([{ fn: 'phase3_preflight_report', params: undefined }]);
  });

  it('forwards one user action batch to the write RPC and returns its result as committed', async () => {
    const result = {
      applied: [{ recordType: 'application', recordId: ACTION.record_id, driveId: USER_A }],
      skippedAlreadyMigratedConcurrently: [],
      conflicts: [],
      drivesCreated: ['pat-pl-2026-1'],
      drivesReused: [],
    };
    const supabase = fakeRpc({ data: result, error: null });

    await expect(createSupabaseRpcClient(supabase).applyUserActions(USER_A, [ACTION])).resolves.toEqual({
      committed: true,
      ...result,
    });
    expect(supabase.calls).toEqual([
      {
        fn: 'phase3_apply_user_actions',
        params: { p_user_id: USER_A, p_actions: [ACTION] },
      },
    ]);
  });

  it('surfaces an RPC error as a rolled-back result without claiming partial writes', async () => {
    const supabase = fakeRpc({ data: null, error: { message: 'sync in progress' } });

    await expect(createSupabaseRpcClient(supabase).applyUserActions(USER_A, [ACTION])).resolves.toEqual({
      committed: false,
      applied: [],
      skippedAlreadyMigratedConcurrently: [],
      conflicts: [],
      drivesCreated: [],
      drivesReused: [],
      error: 'sync in progress',
    });
  });

  it('fails the read-only preflight call when Supabase returns an error', async () => {
    const supabase = fakeRpc({ data: null, error: { message: 'permission denied' } });

    await expect(createSupabaseRpcClient(supabase).preflightReport()).rejects.toThrow(
      'phase3_preflight_report failed: permission denied'
    );
  });
});
