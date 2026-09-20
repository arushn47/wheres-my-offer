/**
 * Phase 3 EXECUTION step — the top-level orchestrator.
 *
 * Wires DISCOVERY -> RESOLUTION -> PLAN -> MATERIALIZATION -> ASSIGNMENT -> VALIDATION together,
 * one user at a time. Every external dependency (`Phase3DiscoveryReader`, `Phase3RpcClient`) is
 * injected, so this whole pipeline — including the "one transaction per user" and "abort
 * everything if the global preflight is BLOCKED" behavior — is testable with fakes and never
 * touches a real database in the test suite.
 *
 * `mode: 'dry-run'` (the default everywhere this is invoked) never calls
 * `rpcClient.applyUserActions` — it only calls the read-only `preflightReport()`. This is the
 * literal enforcement of "no destructive/live DB execution automatically": nothing in this file
 * can mutate data unless a caller explicitly passes `mode: 'execute'`.
 *
 * A single user's bad/unexpected data (e.g. two legacy records disagreeing about who owns a new
 * drive number, caught by `planDriveCreations`) is isolated to that user's report entry and does
 * not abort the batch — every other user is still processed and, in execute mode, still gets
 * their own independent transaction.
 */

import { discoverUserData, type Phase3DiscoveryReader } from './discovery';
import { createSupabaseDiscoveryReader, type Phase3DiscoverySupabaseClient } from './discovery';
import { planUserMigration } from './plan-run';
import { planDriveCreations } from './materialize';
import { buildRpcActions } from './assign';
import { evaluatePreflight, canProceedToExecution } from './validate';
import { buildPerUserReport, buildRunSummary, type Phase3RunSummary, type PerUserReport } from './report';
import { createSupabaseRpcClient, type Phase3RpcClient, type SupabaseRpcLike } from './rpc-client';

export type Phase3RunMode = 'dry-run' | 'execute';

export interface RunPhase3MigrationParams {
  reader: Phase3DiscoveryReader;
  rpcClient: Phase3RpcClient;
  userIds: string[];
  /** Defaults to 'dry-run'. Must be set to 'execute' explicitly to write anything. */
  mode?: Phase3RunMode;
}

export interface SupabasePhase3MigrationParams {
  /** A service-role client. This function never creates or mutates a client itself. */
  supabase: Phase3DiscoverySupabaseClient & SupabaseRpcLike;
  userIds: string[];
  /** Defaults to 'dry-run'; callers must explicitly opt into writes. */
  mode?: Phase3RunMode;
}

async function planOneUser(reader: Phase3DiscoveryReader, userId: string) {
  const bundle = await discoverUserData(reader, userId);
  const { plannedActions, unscoped } = planUserMigration(bundle);
  const driveCreationRequests = planDriveCreations(plannedActions);
  return { plannedActions, unscoped, driveCreationRequests };
}

export async function runPhase3Migration(params: RunPhase3MigrationParams): Promise<Phase3RunSummary> {
  const mode: Phase3RunMode = params.mode || 'dry-run';

  const preflightRows = await params.rpcClient.preflightReport();
  const preflight = evaluatePreflight(preflightRows);

  const users: PerUserReport[] = [];

  // Global safeguard: a BLOCKED preflight means the technical prerequisites for
  // `phase3_apply_user_actions` are not met at all — never process a single user's writes.
  if (mode === 'execute' && !canProceedToExecution(preflight)) {
    for (const userId of params.userIds) {
      users.push(
        buildPerUserReport({
          userId,
          plannedActions: [],
          driveCreationRequests: [],
          unscoped: [],
          outcome: {
            kind: 'skipped',
            reason: 'global preflight BLOCKED — execution aborted before any user was processed',
          },
        })
      );
    }
    return buildRunSummary({ mode, preflight, users });
  }

  for (const userId of params.userIds) {
    let planned;
    try {
      planned = await planOneUser(params.reader, userId);
    } catch (err) {
      users.push(
        buildPerUserReport({
          userId,
          plannedActions: [],
          driveCreationRequests: [],
          unscoped: [],
          outcome: {
            kind: 'skipped',
            reason: `planning failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        })
      );
      continue;
    }

    const { plannedActions, unscoped, driveCreationRequests } = planned;

    if (mode === 'dry-run') {
      users.push(
        buildPerUserReport({ userId, plannedActions, driveCreationRequests, unscoped, outcome: { kind: 'dry_run' } })
      );
      continue;
    }

    const rpcActions = buildRpcActions(plannedActions);
    if (rpcActions.length === 0) {
      users.push(
        buildPerUserReport({
          userId,
          plannedActions,
          driveCreationRequests,
          unscoped,
          outcome: { kind: 'skipped', reason: 'no writable actions for this user' },
        })
      );
      continue;
    }

    const result = await params.rpcClient.applyUserActions(userId, rpcActions);
    users.push(
      buildPerUserReport({
        userId,
        plannedActions,
        driveCreationRequests,
        unscoped,
        outcome: result.committed ? { kind: 'committed', result } : { kind: 'rolled_back', result },
      })
    );
  }

  return buildRunSummary({ mode, preflight, users });
}

/**
 * Production composition root for Phase 3. The adapters stay injectable and independently
 * testable, while this entrypoint guarantees that discovery and execution use the same client
 * and the same explicit dry-run/execute mode.
 */
export async function runSupabasePhase3Migration(
  params: SupabasePhase3MigrationParams
): Promise<Phase3RunSummary> {
  return runPhase3Migration({
    reader: createSupabaseDiscoveryReader(params.supabase),
    rpcClient: createSupabaseRpcClient(params.supabase),
    userIds: params.userIds,
    mode: params.mode,
  });
}
