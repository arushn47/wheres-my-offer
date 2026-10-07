import { afterEach, describe, expect, it, vi } from 'vitest';
import type { createAdminClient } from '@/lib/supabase/admin';
import { readDriveActivity, readRoundStatusRows, readRecentCollegeSearchRows } from './dashboard-readers';
type Admin = ReturnType<typeof createAdminClient>;
afterEach(() => vi.unstubAllEnvs());

function fixture(options: { missing?: boolean; error?: string; rows?: unknown[]; pages?: unknown[][] } = {}) {
  const filters: Array<unknown[]> = [];
  const rpc = vi.fn((name: string, args: unknown) => {
    filters.push(['rpc', name, args]);
    const result = (from = 0) => ({ data: options.pages ? options.pages[from / 1000] : options.rows || [], error: options.missing ? { code: 'PGRST202' } : options.error ? { code: options.error } : null });
    return { range: vi.fn(async (from: number) => result(from)), then: (resolve: (value: unknown) => unknown) => resolve(result()) };
  });
  const from = vi.fn((table: string) => {
    const query = {
      select: (fields: string) => { filters.push([table, 'select', fields]); return query; },
      eq: (field: string, value: unknown) => { filters.push([table, field, value]); return query; },
      in: (field: string, value: unknown) => { filters.push([table, field, value]); return query; },
      not: () => query,
      order: (field: string, value: unknown) => { filters.push([table, 'order', field, value]); return query; },
      limit: (value: number) => { filters.push([table, 'limit', value]); return query; },
      range: async () => ({ data: table === 'round_verdicts' ? options.rows || [] : table === 'personal_emails'
        ? [{ id: 'receipt', placement_drive_id: 'drive', received_at: '2026-10-01', college_email_id: 'canonical', canonical_email_id: null }]
        : [{ placement_drive_id: 'drive', email_id: 'receipt' }, { placement_drive_id: 'other', email_id: 'another-users-receipt' }], error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: options.rows || [{ id: 'canonical', received_at: '2026-10-02' }], error: null }),
    };
    return query;
  });
  return { admin: { rpc, from } as unknown as Admin, rpc, from, filters };
}
describe('compact dashboard reads', () => {
  it('passes private user and selected drives, retaining history and detail roster states', async () => {
    vi.stubEnv('COMPACT_DASHBOARD_READS_ENABLED', 'true');
    const rows = [{ placement_drive_id: 'drive', is_current: false, verdict: { roundKey: 'test:1', state: 'verified_present' } }];
    const f = fixture({ rows });
    expect(await readRoundStatusRows(f.admin, 'user-one', ['drive'], true)).toEqual(rows);
    expect(f.rpc).toHaveBeenCalledWith('get_user_round_status_rows', { p_user_id: 'user-one', p_drive_ids: ['drive'], p_include_evaluations: true });
    expect(f.from).not.toHaveBeenCalled();
    await readRoundStatusRows(f.admin, 'user-two');
    expect(f.rpc).toHaveBeenLastCalledWith('get_user_round_status_rows', { p_user_id: 'user-two', p_drive_ids: null, p_include_evaluations: false });
  });
  it('does not replace an empty requested scope with every drive', async () => {
    const f = fixture();
    expect(await readRoundStatusRows(f.admin, 'user', [])).toEqual([]);
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.from).not.toHaveBeenCalled();
  });
  it('continues beyond the PostgREST row cap without dropping older participation', async () => {
    vi.stubEnv('COMPACT_DASHBOARD_READS_ENABLED', 'true');
    const f = fixture({ pages: [Array(1000).fill({ is_current: false }), [{ is_current: true }]] });
    expect(await readRoundStatusRows(f.admin, 'user')).toHaveLength(1001);
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it.each(['false', 'missing'])('retains scoped canonical reads when %s', async mode => {
    vi.stubEnv('COMPACT_DASHBOARD_READS_ENABLED', mode === 'false' ? 'false' : 'true');
    const f = fixture({ missing: mode === 'missing', rows: [{ verdict: { eligible: false } }] });
    expect(await readRoundStatusRows(f.admin, 'user', ['drive'])).toHaveLength(1);
    expect(f.filters).toContainEqual(['round_verdicts', 'user_id', 'user']);
    expect(f.filters).toContainEqual(['round_verdicts', 'placement_drive_id', ['drive']]);
  });
  it('propagates real database failures instead of masking them with a full read', async () => {
    vi.stubEnv('COMPACT_DASHBOARD_READS_ENABLED', 'true');
    const f = fixture({ error: '42501' });
    await expect(readRoundStatusRows(f.admin, 'user')).rejects.toEqual({ code: '42501' });
    await expect(readDriveActivity(f.admin, 'user')).rejects.toEqual({ code: '42501' });
    expect(f.from).not.toHaveBeenCalled();
  });
  it('preserves both personal and canonical linked activity on migration fallback', async () => {
    vi.stubEnv('COMPACT_DASHBOARD_READS_ENABLED', 'true');
    const f = fixture({ missing: true });
    expect(await readDriveActivity(f.admin, 'user')).toEqual([
      { placement_drive_id: 'drive', received_at: '2026-10-01' }, { placement_drive_id: 'drive', received_at: '2026-10-02' },
    ]);
    expect(f.filters).toContainEqual(['personal_emails', 'user_id', 'user']);
    expect(f.filters).toContainEqual(['email_drive_links', 'user_id', 'user']);
    expect(f.filters.filter(entry => String(entry).includes('college_emails('))).toEqual([]);
    expect(f.filters).toContainEqual(['college_emails', 'id', ['canonical']]);
  });
  it('uses compact shared search snippets and retains the limited canonical fallback', async () => {
    vi.stubEnv('COMPACT_DASHBOARD_READS_ENABLED', 'true');
    const rows = [{ id: 'canonical', body_text: 'Shortlist announcement' }];
    const compact = fixture({ rows });
    expect(await readRecentCollegeSearchRows(compact.admin)).toEqual(rows);
    expect(compact.rpc).toHaveBeenCalledWith('get_recent_college_search_rows');
    expect(compact.from).not.toHaveBeenCalled();
    const legacy = fixture({ rows, missing: true });
    expect(await readRecentCollegeSearchRows(legacy.admin)).toEqual(rows);
    expect(legacy.filters).toContainEqual(['college_emails', 'limit', 40]);
    expect(legacy.filters).toContainEqual(['college_emails', 'order', 'received_at', { ascending: false }]);
  });
});
