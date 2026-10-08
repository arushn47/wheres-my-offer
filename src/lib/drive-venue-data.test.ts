import { expect, it, vi } from 'vitest';
import type { createAdminClient } from '@/lib/supabase/admin';
import { readDriveVenues, persistDriveVenues } from './drive-venue-data';
type Admin = ReturnType<typeof createAdminClient>;
it('reads compact venue metadata in bounded batches, not per-drive bodies/events', async () => {
  const select = vi.fn(), batches: string[][] = [];
  const admin = { from: vi.fn((table: string) => { expect(table).toBe('placement_drives'); return { select: (s: string) => { select(s); return { in: async (_: string, ids: string[]) => { batches.push(ids); return { data: ids.map(id => ({ id, recruitment_venues: { version: 1, entries: [] } })), error: null }; } }; } }; }) } as unknown as Admin;
  const ids = Array.from({ length: 450 }, (_, i) => `drive-${i}`);
  const map = await readDriveVenues(admin, [...ids, ...ids]);
  expect(map.size).toBe(450); expect(batches.map(b => b.length)).toEqual([200, 200, 50]);
  expect(select.mock.calls.every(c => c[0] === 'id,recruitment_venues,excluded_email_ids')).toBe(true);
});
it('safely returns empty projection before the additive migration', async () => {
  const admin = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { code: '42703' } }) }) }) } as unknown as Admin;
  expect((await readDriveVenues(admin, ['drive'])).size).toBe(0);
});
it('does not write empty extraction or dispatch unrelated work', async () => {
  const rpc = vi.fn<(name: string, payload: unknown) => Promise<{ error: null }>>(async () => ({ error: null }));
  const admin = { rpc } as unknown as Admin;
  await persistDriveVenues(admin, 'one', 'source', 'date', []);
  expect(rpc).not.toHaveBeenCalled();
  await persistDriveVenues(admin, 'one', 'source', 'date', [{ stage: 'Interviews', kind: 'office', name: 'Chennai office', city: 'Chennai', quote: 'Interviews at Chennai office' }]);
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc.mock.calls[0][0]).toBe('merge_drive_recruitment_venues');
});
