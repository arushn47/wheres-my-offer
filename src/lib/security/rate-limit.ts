// Per-instance abuse protection. Deployments need an edge/WAF distributed limit too.
export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly capacity = 10_000) {}
  consume(key: string, limit: number, windowMs: number, now = Date.now()): { allowed: boolean; retryAfter: number } {
    let bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt <= now) { this.buckets.delete(key); bucket = undefined; }
    if (!bucket) {
      if (this.buckets.size >= this.capacity) {
        for (const [id, value] of this.buckets) if (value.resetAt <= now) this.buckets.delete(id);
        if (this.buckets.size >= this.capacity) return { allowed: false, retryAfter: 60 };
      }
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    const allowed = bucket.count < limit;
    if (allowed) bucket.count++;
    return { allowed, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
}
export const apiLimiter = new RateLimiter();

export function ratePolicy(path: string, method: string) {
  if (path === '/api/feedback') return { group: 'feedback', limit: 5, windowMs: 600_000 };
  if (path.startsWith('/api/auth/')) return { group: 'auth', limit: 40, windowMs: 60_000 };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && (/^\/api\/(sync|calendar)(\/|$)/.test(path) || path.startsWith('/api/admin/'))) return { group: 'work', limit: 10, windowMs: 60_000 };
  return { group: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'write', limit: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 360 : 60, windowMs: 60_000 };
}
