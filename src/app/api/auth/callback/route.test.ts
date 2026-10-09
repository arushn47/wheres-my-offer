import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ cookieGet: vi.fn(), cookieSet: vi.fn(), exchange: vi.fn(), userinfo: vi.fn(), from: vi.fn(), maybeSingle: vi.fn(), admin: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookieGet, set: mocks.cookieSet }) }));
vi.mock('googleapis', () => ({ google: {
  auth: { OAuth2: vi.fn(function () { return { getToken: mocks.exchange, setCredentials: vi.fn() }; }) },
  oauth2: () => ({ userinfo: { get: mocks.userinfo } }),
} }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.admin }));
import { signSessionToken } from '@/lib/security/session';
import { GET } from './route';
const callback = () => new Request('https://www.wheresmyoffer.in/api/auth/callback?code=code&state=expected');
let cookies: Record<string, string>;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
  cookies = { oauth_state: 'expected', oauth_account_type: 'college', oauth_code_verifier: 'pkce-verifier' };
  mocks.cookieGet.mockImplementation((key: string) => cookies[key] ? { value: cookies[key] } : undefined);
  mocks.exchange.mockResolvedValue({ tokens: { access_token: 'private-token' } });
  mocks.userinfo.mockResolvedValue({ data: { id: 'google-user', email: 'student@vitbhopal.ac.in', verified_email: true } });
  mocks.admin.mockReturnValue({ from: mocks.from });
  mocks.from.mockImplementation(() => {
    const q = { select: () => q, eq: () => q, neq: () => q, limit: () => q, maybeSingle: mocks.maybeSingle };
    return q;
  });
});
afterEach(() => vi.unstubAllEnvs());
it('rejects a callback without its PKCE verifier before exchanging credentials', async () => {
  delete cookies.oauth_code_verifier;
  expect((await GET(callback())).headers.get('location')).toContain('invalid_oauth_state');
  expect(mocks.exchange).not.toHaveBeenCalled();
});
it('rejects an unverified Google email before using privileged database access', async () => {
  mocks.userinfo.mockResolvedValue({ data: { id: 'google-user', email: 'student@vitbhopal.ac.in', verified_email: false } });
  await GET(callback());
  expect(mocks.exchange).toHaveBeenCalledWith({ code: 'code', codeVerifier: 'pkce-verifier' });
  expect(mocks.admin).not.toHaveBeenCalled();
});
it('rejects linking a Google identity owned by another account', async () => {
  cookies.session = await signSessionToken({ userId: '40000000-0000-4000-8000-000000000004', email: 'student@example.test', name: null, avatar: null });
  mocks.maybeSingle.mockResolvedValue({ data: { user_id: 'other-user' }, error: null });
  expect((await GET(callback())).headers.get('location')).toContain('account_already_linked');
  expect(mocks.from.mock.calls.map(args => args[0])).toEqual(['gmail_accounts', 'users']);
  expect(mocks.cookieSet).toHaveBeenCalledWith('oauth_code_verifier', '', expect.objectContaining({ maxAge: 0 }));
});
