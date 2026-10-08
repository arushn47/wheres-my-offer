import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ after: vi.fn(), rpc: vi.fn(), runSync: vi.fn(), shared: vi.fn(), verify: vi.fn() }));
vi.mock('next/server', () => ({ after: mocks.after, NextResponse: { json: (data: unknown, init?: ResponseInit) => new Response(JSON.stringify(data), init) } }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: mocks.rpc, from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { user_id: 'user-one', account_type: 'personal' }, error: null }) }) }) }) }) }) }));
vi.mock('@/lib/sync/engine', () => ({ runSync: mocks.runSync }));
vi.mock('@/lib/sync/canonical/shared-college-sync', () => ({ runSharedCollegeSync: mocks.shared }));
vi.mock('google-auth-library', () => ({ OAuth2Client: class { verifyIdToken = mocks.verify; } }));
import { POST } from './route';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('GOOGLE_PUBSUB_AUDIENCE', 'audience');
  vi.stubEnv('GOOGLE_PUBSUB_SERVICE_ACCOUNT', 'push@example.test');
  mocks.verify.mockResolvedValue({ getPayload: () => ({ iss: 'https://accounts.google.com', email: 'push@example.test' }) });
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.runSync.mockResolvedValue({ errors: [], hasMorePagesPending: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function background() {
  const request = new Request('https://example.test/api/webhooks/gmail', {
    method: 'POST', headers: { authorization: 'Bearer test' }, body: JSON.stringify({ subscription: 'subscription-one', message: { messageId: 'message-one', data: Buffer.from(JSON.stringify({ emailAddress: 'user@example.test', historyId: '123' })).toString('base64') } }),
  });
  expect((await POST(request as NextRequest)).status).toBe(200);
  expect(mocks.runSync).not.toHaveBeenCalled();
  await expect(mocks.after.mock.calls[0][0]()).resolves.toBeUndefined();
}

it('logs and stores plain database error fields with the sync operation and message identity', async () => {
  const error = { code: '57014', message: 'Query canceled', details: 'Statement timeout', hint: 'Retry' };
  mocks.runSync.mockRejectedValue(error);
  await background();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Background sync failed'), 'Query canceled', expect.objectContaining({ operation: 'personal_sync', messageId: 'message-one', runId: expect.any(String), error }));
  const call = mocks.rpc.mock.calls.find(([name]) => name === 'fail_gmail_pubsub_message');
  expect(JSON.parse(call![1].p_error)).toMatchObject({ operation: 'personal_sync', messageId: 'message-one', error });
});

it('identifies a completion RPC failure separately from a successful budget-limited sync', async () => {
  const error = { code: 'PGRST000', message: 'Connection failed', details: 'Pool unavailable' };
  mocks.rpc.mockImplementation(async (name: string) => ({ data: true, error: name === 'complete_gmail_pubsub_message' ? error : null }));
  await background();
  expect(console.error).toHaveBeenCalledWith(expect.any(String), 'Connection failed', expect.objectContaining({ operation: 'complete_gmail_pubsub_message', error }));
  const call = mocks.rpc.mock.calls.find(([name]) => name === 'fail_gmail_pubsub_message');
  expect(JSON.parse(call![1].p_error).operation).toBe('complete_gmail_pubsub_message');
});

it('preserves terminal setup acknowledgement without recording a retryable failure', async () => {
  mocks.runSync.mockRejectedValue(new Error('Complete setup to sync: Please add College Gmail in Settings.'));
  await background();
  expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(['claim_gmail_pubsub_message', 'complete_gmail_pubsub_message']);
});

it('logs both errors if persisting the failure also fails, without rejecting after()', async () => {
  mocks.runSync.mockRejectedValue(new Error('Original failure'));
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'fail_gmail_pubsub_message') throw { code: 'NETWORK', message: 'Recorder unavailable' };
    return { data: true, error: null };
  });
  await background();
  expect(console.error).toHaveBeenCalledWith('[Pub/Sub] Failed to record background outcome:', expect.objectContaining({ originalError: expect.objectContaining({ message: 'Original failure' }), error: expect.objectContaining({ code: 'NETWORK', message: 'Recorder unavailable' }) }));
});

it('also reports returned PostgREST errors when recording a failure', async () => {
  mocks.runSync.mockRejectedValue({ message: 'Sync failed', code: '57014' });
  mocks.rpc.mockImplementation(async (name: string) => ({ data: true, error: name === 'fail_gmail_pubsub_message' ? { code: 'PGRST000', message: 'Recorder unavailable' } : null }));
  await background();
  expect(console.error).toHaveBeenCalledWith('[Pub/Sub] Failed to record background outcome:', expect.objectContaining({ error: expect.objectContaining({ code: 'PGRST000' }) }));
});

it('does not turn a normal time-budget checkpoint into a failure', async () => {
  await background();
  expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(['claim_gmail_pubsub_message', 'complete_gmail_pubsub_message']);
  expect(console.error).not.toHaveBeenCalled();
});
