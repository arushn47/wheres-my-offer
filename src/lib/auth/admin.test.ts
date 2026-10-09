import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), lookup: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getSession: mocks.session }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => {
  const q = { select: () => q, eq: () => q, maybeSingle: mocks.lookup };
  return { from: () => q };
} }));
import { checkIsAdmin, requireAdmin } from './admin';
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('ADMIN_EMAILS', 'admin@example.test'); });
afterEach(() => vi.unstubAllEnvs());
it('requires authentication and rejects a non-admin', async () => {
  mocks.session.mockResolvedValue(null); await expect(requireAdmin()).rejects.toMatchObject({ status: 401 });
  mocks.session.mockResolvedValue({ userId: 'student', email: 'student@example.test' });
  mocks.lookup.mockResolvedValue({ data: { role: 'user', email: 'student@example.test' }, error: null });
  await expect(requireAdmin()).rejects.toMatchObject({ status: 403 });
});
it('does not trust a stale bootstrap email or permit a failed lookup', async () => {
  mocks.session.mockResolvedValue({ userId: 'student', email: 'admin@example.test' });
  mocks.lookup.mockResolvedValue({ data: { role: 'user', email: 'student@example.test' }, error: null });
  await expect(requireAdmin()).rejects.toMatchObject({ status: 403 });
  mocks.lookup.mockResolvedValue({ data: null, error: { message: 'offline' } });
  expect(await checkIsAdmin('student', 'admin@example.test')).toBe(false);
});
it('accepts an existing matching bootstrap identity and database administrator', async () => {
  mocks.session.mockResolvedValue({ userId: 'admin', email: 'admin@example.test' });
  mocks.lookup.mockResolvedValue({ data: { role: 'user', email: 'admin@example.test' }, error: null });
  await expect(requireAdmin()).resolves.toMatchObject({ userId: 'admin' });
  mocks.lookup.mockResolvedValue({ data: { role: 'admin', email: 'other@example.test' }, error: null });
  expect(await checkIsAdmin('admin', 'other@example.test')).toBe(true);
});
