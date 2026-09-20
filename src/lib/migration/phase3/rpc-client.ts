/**
 * Phase 3 RPC boundary.
 *
 * `phase3_apply_user_actions` and `phase3_preflight_report` (see
 * `supabase/migration_v13_phase3_functions.sql`) are the ONLY places any Phase 3 code performs a
 * write or reads live data. Everything upstream (discovery/resolve-drive/plan/materialize/
 * assign) is pure or reads through an injectable interface. `Phase3RpcClient` is that boundary,
 * kept intentionally narrow (two methods) so `run.ts` can be tested end-to-end against a fake
 * that never touches a real database, and the real adapter here has no business logic to get
 * wrong beyond "call the RPC and shape the response."
 */

import type { RpcAction } from './assign';

export interface PreflightCheckRow {
  checkName: string;
  status: 'PASS' | 'WARN' | 'BLOCKED' | 'READY' | 'REVIEW_REQUIRED' | string;
  details: string;
}

export interface AppliedRecordResult {
  recordType: string;
  recordId: string;
  driveId: string;
}

export interface SkippedRecordResult {
  recordType: string;
  recordId: string;
  reason: string;
}

/**
 * The result of one `phase3_apply_user_actions` call. `committed: false` means the SQL function
 * raised and the whole transaction for this user was rolled back — every field other than
 * `committed`/`error` should be treated as "did not happen" in that case, and the caller must
 * plan to retry this user on a later run rather than treat it as partially done.
 */
export interface ApplyUserActionsResult {
  committed: boolean;
  applied: AppliedRecordResult[];
  skippedAlreadyMigratedConcurrently: SkippedRecordResult[];
  conflicts: SkippedRecordResult[];
  drivesCreated: string[];
  drivesReused: string[];
  error?: string;
}

export interface Phase3RpcClient {
  /** Read-only. Safe to call in dry-run mode. Mirrors `preflight_v12_drive_migration.sql`. */
  preflightReport(): Promise<PreflightCheckRow[]>;
  /** The one and only write path. Executes entirely inside one Postgres transaction per call. */
  applyUserActions(userId: string, actions: RpcAction[]): Promise<ApplyUserActionsResult>;
}

/** Minimal shape of the Supabase client this adapter needs — matches `createAdminClient()`. */
export interface SupabaseRpcLike {
  rpc(fn: string, params?: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

/**
 * Real adapter over the Supabase admin client. No business logic — if this file starts making
 * decisions instead of shaping RPC I/O, that logic belongs in `validate.ts`/`run.ts` instead.
 */
export function createSupabaseRpcClient(supabase: SupabaseRpcLike): Phase3RpcClient {
  return {
    async preflightReport() {
      const { data, error } = await supabase.rpc('phase3_preflight_report');
      if (error) throw new Error(`phase3_preflight_report failed: ${error.message}`);
      const rows = Array.isArray(data) ? data : [];
      return rows.map((row) => {
        const value = row as Record<string, unknown>;
        return {
          checkName: (value.checkName ?? value.check_name) as string,
          status: value.status as PreflightCheckRow['status'],
          details: value.details as string,
        };
      });
    },
    async applyUserActions(userId: string, actions: RpcAction[]) {
      const { data, error } = await supabase.rpc('phase3_apply_user_actions', {
        p_user_id: userId,
        p_actions: actions,
      });
      if (error) {
        // A RAISE EXCEPTION inside the function (blocked preflight, integrity violation, live
        // sync in progress, etc.) surfaces here as a PostgREST error — the transaction was
        // rolled back server-side. Never treat this as partial success.
        return {
          committed: false,
          applied: [],
          skippedAlreadyMigratedConcurrently: [],
          conflicts: [],
          drivesCreated: [],
          drivesReused: [],
          error: error.message,
        };
      }
      const result = (data as Omit<ApplyUserActionsResult, 'committed'>) || {
        applied: [],
        skippedAlreadyMigratedConcurrently: [],
        conflicts: [],
        drivesCreated: [],
        drivesReused: [],
      };
      return { committed: true, ...result };
    },
  };
}
