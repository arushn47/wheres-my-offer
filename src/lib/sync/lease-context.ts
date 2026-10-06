import { AsyncLocalStorage } from 'node:async_hooks';
export interface MutationLease { userId: string; runId: string; touchedDriveIds: Set<string> }
export const mutationLeases = new AsyncLocalStorage<MutationLease>();
export function currentMutationLease(): MutationLease | undefined { return mutationLeases.getStore(); }
export function withOwnedMutationLease<T>(userId: string, runId: string, work: () => Promise<T>): Promise<T> {
  return mutationLeases.run({ userId, runId, touchedDriveIds: new Set() }, work);
}
