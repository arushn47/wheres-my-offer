import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { signSessionToken, verifySessionToken } from './session';
import { contentSecurityPolicy, isAllowedMutation, isPublicPath } from './request-policy';
import { RateLimiter } from './rate-limit';
import { bodyWithinLimit } from './body-limit';
import { applicationStatusInput, feedbackInput, notificationPreferencesInput } from './input';
import { encrypt, decrypt } from '@/lib/crypto/tokens';
import { getAppUrl, getOAuthRedirectUri } from '@/lib/auth';
afterEach(() => vi.unstubAllEnvs());
const session = { userId: '10000000-0000-4000-8000-000000000001', email: 'student@example.test', name: 'Student', avatar: null };
describe('session boundary', () => {
  it('preserves existing HS256 encoding and rejects missing or malformed configuration', async () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
    const token = await signSessionToken(session);
    expect(await verifySessionToken(token)).toEqual(session);
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', '');
    expect(await verifySessionToken(token)).toBeNull();
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'x'.repeat(64));
    expect(await verifySessionToken(token)).toBeNull();
    expect(() => encrypt('value')).toThrow();
  });
  it('rejects expired, timeless, wrong-algorithm and malformed-identity tokens', async () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
    const key = new TextEncoder().encode('a'.repeat(64));
    const tokens = [
      await new SignJWT({ ...session }).setProtectedHeader({ alg: 'HS256' }).sign(key),
      await new SignJWT({ ...session }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('0s').sign(key),
      await new SignJWT({ ...session }).setProtectedHeader({ alg: 'HS384' }).setIssuedAt().setExpirationTime('1h').sign(key),
      await signSessionToken({ ...session, userId: 'victim-id' }),
      await signSessionToken({ ...session, email: 'a\" onclick=\"bad@example.test' }),
    ];
    for (const token of tokens) expect(await verifySessionToken(token)).toBeNull();
  });
  it('authenticates ciphertext and does not silently decrypt tampering', () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
    const encoded = encrypt('private refresh credential');
    expect(decrypt(encoded)).toBe('private refresh credential');
    const bytes = Buffer.from(encoded, 'base64'); bytes[20] ^= 1;
    expect(() => decrypt(bytes.toString('base64'))).toThrow();
  });
});
describe('request boundaries', () => {
  it('does not use forwarded hosts or localhost lookalikes for OAuth redirects', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(getAppUrl(new Request('https://localhost.attacker.test/api/auth/google', { headers: { 'x-forwarded-host': 'localhost.attacker.test' } }))).toBe('https://www.wheresmyoffer.in');
    expect(getOAuthRedirectUri(new Request('http://localhost:3000/api/auth/google', { headers: { 'x-forwarded-host': 'attacker.test' } }))).toBe('http://localhost:3000/api/auth/callback');
    vi.stubEnv('NODE_ENV', 'production');
    expect(getAppUrl(new Request('http://localhost:3000/api/auth/google'))).toBe('https://www.wheresmyoffer.in');
  });
  it('does not treat dotted URLs, prefix lookalikes or extra admin paths as public', () => {
    for (const path of ['/api/user/account.json', '/api/auth/google-extra', '/api/admin/migration/phase3/anything', '/api/sync/reprocess/status', '/login-admin']) expect(isPublicPath(path)).toBe(false);
    expect(isPublicPath('/sw.js')).toBe(true);
    expect(isPublicPath('/api/webhooks/gmail')).toBe(true);
  });
  it('rejects cross-site and origin-less cookie writes while allowing same-origin and authenticated worker requests', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const request = (path: string, headers: Record<string, string>) => new Request(`https://www.wheresmyoffer.in${path}`, { method: 'POST', headers });
    expect(isAllowedMutation(request('/api/user/account', { origin: 'https://attacker.test' }))).toBe(false);
    expect(isAllowedMutation(request('/api/user/account', {}))).toBe(false);
    expect(isAllowedMutation(request('/api/user/account', { origin: 'https://www.wheresmyoffer.in' }))).toBe(true);
    expect(isAllowedMutation(request('/api/webhooks/gmail', { authorization: 'Bearer credential' }))).toBe(true);
    expect(isAllowedMutation(request('/api/webhooks/gmail', { authorization: 'Bearer credential', origin: 'https://attacker.test' }))).toBe(false);
  });
  it('enforces streamed body limits even without Content-Length and preserves a valid body', async () => {
    const valid = new Request('http://localhost/api/test', { method: 'POST', body: '{"a":1}' });
    expect(await bodyWithinLimit(valid, 20)).toBe(true);
    expect(await valid.json()).toEqual({ a: 1 });
    expect(await bodyWithinLimit(new Request('http://localhost/api/test', { method: 'POST', body: 'x'.repeat(100) }), 10)).toBe(false);
  });
  it('limits a bucket across calls, separates identities, resets, and bounds memory without evicting active limits', () => {
    const limiter = new RateLimiter(2);
    expect(limiter.consume('a', 1, 1000, 0).allowed).toBe(true);
    expect(limiter.consume('a', 1, 1000, 100)).toEqual({ allowed: false, retryAfter: 1 });
    expect(limiter.consume('b', 1, 1000, 0).allowed).toBe(true);
    expect(limiter.consume('c', 1, 1000, 0).allowed).toBe(false);
    expect(limiter.consume('a', 1, 1000, 1001).allowed).toBe(true);
  });
  it('requires a nonce for executable inline content in production', () => {
    const csp = contentSecurityPolicy('randomnonce', false);
    expect(csp).toContain("script-src 'self' 'nonce-randomnonce' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
describe('form inputs', () => {
  it('rejects malformed, empty and oversized feedback but safely retains plain-text characters', () => {
    for (const body of [null, { subject: 123, message: 'text' }, { subject: '', message: 'text' }, { subject: 's', message: 'a'.repeat(10001) }]) expect(feedbackInput.safeParse(body).success).toBe(false);
    const parsed = feedbackInput.parse({ subject: ' A < B ', message: 'Text', metadata: { path: '/', arbitrary: 'ignored' }, user_id: 'victim' });
    expect(parsed.subject).toBe('A < B');
    expect(parsed.metadata).toEqual({ path: '/' });
    expect(parsed).not.toHaveProperty('user_id');
  });
  it('rejects role injection and invalid preference values and preserves supported statuses', () => {
    expect(notificationPreferencesInput.safeParse({ userId: 'victim', notifyTests: true }).success).toBe(false);
    expect(notificationPreferencesInput.safeParse({ notifyTests: 'false' }).success).toBe(false);
    expect(notificationPreferencesInput.safeParse({ reminderLeadTimeMins: [-1] }).success).toBe(false);
    for (const status of ['ppt_scheduled', 'shortlisted', 'declined', 'not_shortlisted_post_ppt']) expect(applicationStatusInput.safeParse({ status }).success).toBe(true);
    expect(applicationStatusInput.safeParse({ status: 'admin' }).success).toBe(false);
  });
});
