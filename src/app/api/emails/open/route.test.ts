import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), resolve: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getSession: mocks.session }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
vi.mock('@/lib/gmail/original-email', () => ({ resolveOriginalEmail: mocks.resolve }));
import { GET } from './route';
const request = () => new Request('https://www.wheresmyoffer.in/api/emails/open?source=college&id=00000000-0000-4000-a000-000000000001');
beforeEach(() => { vi.clearAllMocks(); delete process.env.DATABASE_WRITES_PAUSED; mocks.session.mockResolvedValue({ userId: 'owner' }); });
it('requires authentication', async () => {
  mocks.session.mockResolvedValue(null);
  expect((await GET(request())).status).toBe(401); expect(mocks.resolve).not.toHaveBeenCalled();
});
it('honors the maintenance writer fence even for direct handler calls', async () => {
  process.env.DATABASE_WRITES_PAUSED = 'true';
  expect((await GET(request())).status).toBe(503); expect(mocks.resolve).not.toHaveBeenCalled();
});
it('does not accept a client-provided redirect or RFC identifier as its source', async () => {
  expect((await GET(new Request('https://example.test/api/emails/open?source=college&id=https://evil.test'))).status).toBe(400);
  expect(mocks.resolve).not.toHaveBeenCalled();
});
it('redirects a verified target without public caching', async () => {
  mocks.resolve.mockResolvedValue({ kind: 'direct', url: 'https://mail.google.com/mail/u/?authuser=college@test.com#all/18fc123456789abc' });
  const response = await GET(request());
  expect(response.status).toBe(307); expect(response.headers.get('location')).toContain('https://mail.google.com/');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});
it('offers an escaped fallback without silently opening another message', async () => {
  mocks.resolve.mockResolvedValue({ kind: 'fallback', url: 'https://mail.google.com/mail/u/?authuser=college@test.com#search/exact', reason: '<script>private</script>' });
  const response = await GET(request()); const body = await response.text();
  expect(response.status).toBe(200); expect(response.headers.get('location')).toBeNull();
  expect(body).toContain('&lt;script&gt;'); expect(body).not.toContain('<script>');
});
