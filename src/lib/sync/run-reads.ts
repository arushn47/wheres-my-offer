import { currentMutationLease } from './lease-context';

// Lives only as long as the owning processing run; never shared across users/runs.
const reads = new WeakMap<object, Map<string, Promise<unknown>>>();

export function reuseRunRead<T>(userId: string | null, key: string, read: () => Promise<T>): Promise<T> {
  const lease = currentMutationLease();
  if (!lease || userId !== null && lease.userId !== userId) return read();
  let cache = reads.get(lease);
  if (!cache) { cache = new Map(); reads.set(lease, cache); }
  const existing = cache.get(key);
  if (existing) return existing as Promise<T>;
  const pending = read();
  cache.set(key, pending);
  void pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
  return pending;
}

/** Canonical mutations fence both in-flight and completed routing reads. */
export function invalidateCircularRoutingRead(): void {
  const lease = currentMutationLease();
  if (lease) reads.get(lease)?.delete('circular-routing');
}
