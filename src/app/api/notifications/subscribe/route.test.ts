import { beforeEach, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ session: vi.fn(), upsert: vi.fn(), preferences: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getSession: mocks.session }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mocks.from }) }));
vi.mock('@/lib/notifications/preferences', () => ({ updateNotificationPreferences: mocks.preferences }));
import { POST } from './route';
const payload = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) };
const request = (enablePush?: boolean) => new Request('https://example.test/api/notifications/subscribe', {
  method: 'POST', body: JSON.stringify({ ...payload, enablePush }),
}) as NextRequest;
beforeEach(() => {
  vi.resetAllMocks(); mocks.session.mockResolvedValue({ userId: 'user' });
  mocks.upsert.mockResolvedValue({ error: null }); mocks.preferences.mockResolvedValue({});
  mocks.from.mockReturnValue({ upsert: mocks.upsert });
});
it('saves the browser subscription and updates the delivery preference on explicit enable', async () => {
  expect((await POST(request(true))).status).toBe(200);
  expect(mocks.from).toHaveBeenCalledWith('push_subscriptions');
  expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'user', endpoint: payload.endpoint }), { onConflict: 'endpoint' });
  expect(mocks.preferences).toHaveBeenCalledWith('user', { browserPushEnabled: true });
});
it('preserves an intentional disable when restoring an existing subscription', async () => {
  expect((await POST(request())).status).toBe(200);expect(mocks.preferences).not.toHaveBeenCalled();
});
it('reports a subscription persistence failure without enabling push', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.upsert.mockResolvedValue({ error: { message: 'Write failed' } });
  try { expect((await POST(request(true))).status).toBe(500);expect(mocks.preferences).not.toHaveBeenCalled(); }
  finally { log.mockRestore(); }
});
