import { currentMutationLease } from '../lease-context';

interface DispatchState {
  generation: number; drained: number; inFlight?: Promise<void>;
  pendingDecisionIds: Set<string>; committedKeys: Set<string>; retry: boolean;
}
const states = new WeakMap<object, DispatchState>();
function stateFor(userId: string): DispatchState | undefined {
  const lease = currentMutationLease();
  if (!lease || lease.userId !== userId) return undefined;
  let state = states.get(lease);
  if (!state) {
    state = { generation: 0, drained: -1, pendingDecisionIds: new Set(), committedKeys: new Set(), retry: false };
    states.set(lease, state);
  }
  return state;
}

/** Called only after the atomic commit succeeds. DB dedupe remains authoritative. */
export function noteRoundOutboxCommit(userId: string, decisionId: string | null, dedupeKey?: string): void {
  const state = stateFor(userId);
  if (!state) return;
  if (dedupeKey && !state.committedKeys.has(dedupeKey) || decisionId && state.pendingDecisionIds.has(decisionId) || !dedupeKey && state.inFlight) state.generation++;
  if (dedupeKey) state.committedKeys.add(dedupeKey);
}

/** Share a concurrent drain, recover persisted work on the first call, and
 * immediately re-drain if another commit completed while delivery was running.
 * Incomplete delivery is retried on the next call, never in a hot retry loop. */
export interface OutboxDrainResult { pendingDecisionIds: Set<string>; retry: boolean }
export async function coalesceRoundOutbox(userId: string, drain: () => Promise<OutboxDrainResult>): Promise<void> {
  const state = stateFor(userId);
  if (!state) { await drain(); return; }
  for (;;) {
    if (state.inFlight) {
      await state.inFlight;
      if (state.generation <= state.drained) return;
      continue;
    }
    if (state.generation <= state.drained && !state.retry) return;
    const generation = state.generation;
    const pending = drain().then(result => {
      state.pendingDecisionIds = result.pendingDecisionIds; state.retry = result.retry; state.drained = generation;
    });
    state.inFlight = pending;
    try { await pending; }
    finally { if (state.inFlight === pending) state.inFlight = undefined; }
    if (state.generation <= state.drained) return;
  }
}
