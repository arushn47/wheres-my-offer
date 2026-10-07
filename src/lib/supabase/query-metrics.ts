import { AsyncLocalStorage } from 'node:async_hooks';

type Job = 'sync' | 'recalculation' | 'reprocess';
interface Operation { requests: number; bytes: number; failures: number; elapsedMs: number }
interface Metrics { operations: Map<string, Operation>; startedAt: number }
const context = new AsyncLocalStorage<Metrics>();

// Opt-in, one summary per job. Never retain URLs, filters, headers, bodies or user IDs.
export async function withQueryMetrics<T>(job: Job, work: () => Promise<T>): Promise<T> {
  if (process.env.SUPABASE_QUERY_METRICS !== 'true' || context.getStore()) return work();
  const metrics: Metrics = { operations: new Map(), startedAt: performance.now() };
  let failed = false;
  try {
    return await context.run(metrics, work);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    console.info('[Supabase query metrics]', JSON.stringify({
      job, failed, elapsedMs: Math.round(performance.now() - metrics.startedAt),
      // These are consumed response bytes, not Supabase's authoritative billing counters.
      operations: Object.fromEntries(metrics.operations),
    }));
  }
}

export async function measuredAdminFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const metrics = context.getStore();
  if (!metrics) return fetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  const path = url.pathname.split('/').filter(Boolean);
  const resource = path[0] === 'rest' && path[1] === 'v1'
    ? path[2] === 'rpc' ? `rpc/${path[3] || 'unknown'}` : path[2] || 'unknown'
    : 'other';
  const key = `${init?.method || (input instanceof Request ? input.method : 'GET')} ${resource}`;
  // A bounded catalog prevents unbounded logs even if an unexpected route is called.
  const bucket = metrics.operations.has(key) || metrics.operations.size < 64 ? key : 'other';
  const operation = metrics.operations.get(bucket) || { requests: 0, bytes: 0, failures: 0, elapsedMs: 0 };
  metrics.operations.set(bucket, operation);
  operation.requests++;
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    operation.failures++;
    operation.elapsedMs += Math.round(performance.now() - startedAt);
    throw error;
  }
  operation.elapsedMs += Math.round(performance.now() - startedAt);
  if (!response.ok) operation.failures++;
  if (!response.body) return response;
  // Count while the client consumes the response; no clone or second full-body buffer.
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      operation.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
