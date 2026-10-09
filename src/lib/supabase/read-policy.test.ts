import { afterEach, describe, expect, it, vi } from 'vitest';
import { optimizedReadEnabled, allowLegacyReadFallback } from './read-policy';
import { readRoundStatusRows, readRecentCollegeSearchRows, readDriveActivity } from '../sync/dashboard-readers';
import { readPersonalPageProgress, readSharedProgress } from '../sync/progress/progress-readers';
import { loadCandidateRosters } from '../sync/attachments/roster-lookup';
import type { createAdminClient } from './admin';
afterEach(() => vi.unstubAllEnvs());

describe('production-target development readers', () => {
  it.each(['nvkxyeugonjevmbvxirm', 'mltfzskewmpifnyleevb'])('uses compact readers on %s even with unset/false local flags', async ref => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', `https://${ref}.supabase.co`);
    for (const flag of ['ROSTER_LOOKUP_ENABLED', 'COMPACT_DASHBOARD_READS_ENABLED', 'COMPACT_SYNC_PROGRESS_ENABLED'] as const) {
      vi.stubEnv(flag, 'false'); expect(optimizedReadEnabled(flag)).toBe(true);
    }
    const error = { code: 'PGRST202' };
    const result = { data: null, error };
    const rpc = vi.fn(() => ({ ...result, range: async () => result, then: (resolve: (value: unknown) => unknown) => resolve(result) }));
    const from = vi.fn(); const admin = { rpc, from } as unknown as ReturnType<typeof createAdminClient>;
    await expect(readRoundStatusRows(admin, 'alice')).rejects.toEqual(error);
    await expect(readRecentCollegeSearchRows(admin)).rejects.toEqual(error);
    await expect(readDriveActivity(admin, 'alice')).rejects.toEqual(error);
    await expect(readPersonalPageProgress(admin, 'alice', ['account'])).rejects.toEqual(error);
    await expect(readSharedProgress(admin)).rejects.toEqual(error);
    await expect(loadCandidateRosters(admin, ['email'], ['NEO123'])).rejects.toEqual(error);
    expect(from).not.toHaveBeenCalled(); expect(rpc).toHaveBeenCalledTimes(6);
  });
  it('preserves explicit production rollback and legacy reads on isolated development databases', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://nvkxyeugonjevmbvxirm.supabase.co');
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('ROSTER_LOOKUP_ENABLED', 'false');
    vi.stubEnv('VERCEL', '1'); vi.stubEnv('VERCEL_ENV', 'production');
    expect(optimizedReadEnabled('ROSTER_LOOKUP_ENABLED')).toBe(false);
    expect(allowLegacyReadFallback({ code: 'PGRST202' })).toBe(true);
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    expect(optimizedReadEnabled('ROSTER_LOOKUP_ENABLED')).toBe(false);
    expect(allowLegacyReadFallback({ code: '57014' })).toBe(false);
  });
  it('also fences a local production-mode preview and a Vercel preview pointed at production', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://nvkxyeugonjevmbvxirm.supabase.co');
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('VERCEL', ''); vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('ROSTER_LOOKUP_ENABLED', 'false');
    expect(optimizedReadEnabled('ROSTER_LOOKUP_ENABLED')).toBe(true);
    expect(allowLegacyReadFallback({ code: '42883' })).toBe(false);
    vi.stubEnv('VERCEL', '1'); vi.stubEnv('VERCEL_ENV', 'preview');
    expect(optimizedReadEnabled('ROSTER_LOOKUP_ENABLED')).toBe(true);
  });
});
