import 'server-only';

export type OptimizedReadFlag = 'ROSTER_LOOKUP_ENABLED' | 'COMPACT_DASHBOARD_READS_ENABLED' | 'COMPACT_SYNC_PROGRESS_ENABLED';
// Both historical Singapore and current Mumbai production projects are fenced.
const productionRefs = new Set(['nvkxyeugonjevmbvxirm', 'mltfzskewmpifnyleevb']);
export function requiresOptimizedReads(): boolean {
  const localRuntime = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'production' &&
    !(process.env.VERCEL === '1' && process.env.VERCEL_ENV === 'production');
  if (!localRuntime) return false;
  try { return productionRefs.has(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '').hostname.split('.')[0]); }
  catch { return false; }
}
export function optimizedReadEnabled(flag: OptimizedReadFlag): boolean {
  return requiresOptimizedReads() || process.env[flag] === 'true';
}
/** Development against production must never silently download legacy bodies. */
export function allowLegacyReadFallback(error: { code?: string }): boolean {
  return !requiresOptimizedReads() && ['PGRST202', '42883'].includes(error.code || '');
}
