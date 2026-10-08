import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ list: vi.fn(), credentials: vi.fn() }));
vi.mock('googleapis', () => ({ google: { auth: { OAuth2: class { setCredentials = mock.credentials; } }, gmail: () => ({ users: { messages: { list: mock.list } } }) } }));
vi.mock('@/lib/crypto/tokens', () => ({ decrypt: (s: string) => s }));
import { resolveOriginalEmail } from './original-email';
import type { createAdminClient } from '@/lib/supabase/admin';

const owner = 'user-one', college = 'college-one';
const id = '00000000-0000-4000-a000-000000000001';
const account = { id: college, user_id: owner, email: 'one@vitbhopal.ac.in', account_type: 'college', is_connected: true, google_account_id: 'google-one', refresh_token_encrypted: 'refresh-one', access_token_encrypted: 'access-one' };
function database(options: { personal?: Record<string, unknown>[]; accounts?: Record<string, unknown>[]; canonical?: Record<string, unknown>[]; cache?: Record<string, unknown>; cacheError?: unknown } = {}) {
  const calls: Array<{ table: string; filters: Record<string, unknown>; select?: string }> = [];
  const rows: Record<string, Record<string, unknown>[]> = { personal_emails: options.personal || [], gmail_accounts: options.accounts || [account], college_emails: options.canonical || [{ id, message_id: '<exact@sender.test>', classification: 'registration' }] };
  const rpc = vi.fn(async (name: string) => name === 'claim_original_email_lookup' ? { data: options.cache || { state: 'lookup' }, error: options.cacheError } : { error: null });
  const from = (table: string) => {
    const call = { table, filters: {} as Record<string, unknown>, select: '' }; calls.push(call);
    let limit = Infinity, either: string | undefined;
    const result = () => rows[table].filter(r => Object.entries(call.filters).every(([k, v]) => r[k] === v)).filter(r => !either || either.split(',').some(part => { const [key, , value] = part.split('.'); return r[key] === value; })).slice(0, limit);
    const query = { select(s: string) { call.select = s; return query; }, eq(k: string, v: unknown) { call.filters[k] = v; return query; }, or(s: string) { either = s; return query; }, limit(n: number) { limit = n; return query; }, maybeSingle: async () => ({ data: result()[0] || null, error: null }), then: (done: (value: unknown) => unknown) => Promise.resolve(done({ data: result(), error: null })) };
    return query;
  };
  return { admin: { from, rpc } as unknown as ReturnType<typeof createAdminClient>, calls, rpc };
}
beforeEach(() => { vi.clearAllMocks(); mock.list.mockResolvedValue({ data: { messages: [{ id: '18fc123456789abc', threadId: '18fc123456789def' }] } }); });
describe('authenticated click-only original email resolution', () => {
  it('never uses another user’s personal receipt or token', async () => {
    const db = database({ personal: [{ id, user_id: 'user-two', gmail_account_id: 'other', thread_id: '18fc123456789abc' }] });
    expect(await resolveOriginalEmail(db.admin, owner, 'personal', id)).toEqual({ kind: 'missing' });
    expect(mock.list).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
  });
  it('opens a personal receipt directly only in its owning account', async () => {
    const db = database({ personal: [{ id, user_id: owner, gmail_account_id: college, thread_id: '18fc123456789abc' }] });
    expect(await resolveOriginalEmail(db.admin, owner, 'personal', id)).toMatchObject({ kind: 'direct', url: expect.stringContaining('authuser=one%40vitbhopal.ac.in#all/18fc123456789abc') });
    expect(mock.list).not.toHaveBeenCalled();
  });
  it('resolves canonical identity only in the authenticated user’s college mailbox, with no body fetch', async () => {
    const db = database();
    expect(await resolveOriginalEmail(db.admin, owner, 'college', id)).toMatchObject({ kind: 'direct' });
    expect(mock.list).toHaveBeenCalledOnce();
    expect(mock.list).toHaveBeenCalledWith({ userId: 'me', q: 'rfc822msgid:<exact@sender.test>', maxResults: 2, includeSpamTrash: true, fields: 'messages(id,threadId),nextPageToken' }, { timeout: 10000, retry: false });
    expect(mock.credentials).toHaveBeenCalledWith(expect.objectContaining({ refresh_token: 'refresh-one' }));
    expect(db.calls.every(c => !/body|snippet/.test(c.select || ''))).toBe(true);
    expect(db.rpc.mock.calls.map(c => c[0])).toEqual(['claim_original_email_lookup', 'complete_original_email_lookup']);
  });
  it('does not reuse the shared source account’s Gmail ids', async () => {
    const db = database({ personal: [{ id: 'shared-receipt', user_id: 'admin', gmail_account_id: 'shared', college_email_id: id, thread_id: '9999999999999999' }] });
    const result = await resolveOriginalEmail(db.admin, owner, 'college', id);
    expect(result).toMatchObject({ kind: 'direct', url: expect.not.stringContaining('9999999999999999') });
    expect(mock.list).toHaveBeenCalledOnce();
  });
  it('prefers an existing mapping for this exact connected recipient account', async () => {
    const db = database({ personal: [{ user_id: owner, gmail_account_id: college, college_email_id: id, thread_id: '18fc123456789abc' }] });
    expect(await resolveOriginalEmail(db.admin, owner, 'college', id)).toMatchObject({ kind: 'direct', url: expect.stringContaining('18fc123456789abc') });
    expect(mock.list).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
  });
  it('uses a private positive cache without a Gmail request', async () => {
    const db = database({ cache: { state: 'ready', threadId: '18fc123456789abc' } });
    expect(await resolveOriginalEmail(db.admin, owner, 'college', id)).toMatchObject({ kind: 'direct' });
    expect(mock.list).not.toHaveBeenCalled();
  });
  it.each([{ state: 'wait' }, { state: 'ready', threadId: 'https://evil.test' }])('never retries a negative/rate-limited cache or redirects an invalid id', async cache => {
    const db = database({ cache });
    expect(await resolveOriginalEmail(db.admin, owner, 'college', id)).toMatchObject({ kind: 'fallback', url: expect.stringContaining('#search/') });
    expect(mock.list).not.toHaveBeenCalled();
  });
  it.each([{ messages: [] }, { messages: [{ id: '18fc123456789abc' }, { id: '18fc123456789def' }] }])('offers an explicit fallback for absent/ambiguous Gmail results', async data => {
    mock.list.mockResolvedValue({ data });
    expect(await resolveOriginalEmail(database().admin, owner, 'college', id)).toMatchObject({ kind: 'fallback', url: expect.stringContaining('#search/') });
  });
  it('handles revoked credentials/quota with no sync, notification or account-state mutation', async () => {
    mock.list.mockRejectedValue({ response: { status: 429 }, message: 'Quota exceeded' });
    const db = database();
    expect(await resolveOriginalEmail(db.admin, owner, 'college', id)).toMatchObject({ kind: 'fallback' });
    expect(db.rpc.mock.calls.map(c => c[0])).toEqual(['claim_original_email_lookup', 'complete_original_email_lookup']);
  });
  it('works without the cache migration by offering the existing exact-message search', async () => {
    const db = database({ cacheError: { code: 'PGRST202' } });
    expect(await resolveOriginalEmail(db.admin, owner, 'college', id)).toMatchObject({ kind: 'fallback' });
    expect(mock.list).not.toHaveBeenCalled();
  });
  it('does not resolve disconnected or missing accounts', async () => {
    expect(await resolveOriginalEmail(database({ accounts: [{ ...account, is_connected: false }] }).admin, owner, 'college', id)).toMatchObject({ kind: 'fallback' });
    expect(await resolveOriginalEmail(database({ accounts: [] }).admin, owner, 'college', id)).toEqual({ kind: 'missing' });
    expect(mock.list).not.toHaveBeenCalled();
  });
});
