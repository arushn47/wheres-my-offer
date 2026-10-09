import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ after: vi.fn(), rpc: vi.fn(), runSync: vi.fn(), shared: vi.fn(), verify: vi.fn(),query:vi.fn() }));
vi.mock('next/server', () => ({ after: mocks.after, NextResponse: { json: (data: unknown, init?: ResponseInit) => new Response(JSON.stringify(data), init) } }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: mocks.rpc, from:mocks.query }) }));
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
  mocks.runSync.mockResolvedValue({ errors: [], hasMorePagesPending: false });
  mocks.query.mockImplementation((table:string)=>{
    const result={data:table==='gmail_accounts'?{id:'account',user_id:'user-one',account_type:'personal',last_history_id:'123'}:null,error:null};
    const query={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),single:async()=>result,maybeSingle:async()=>result};
    return query;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function background(status=503) {
  const request = new Request('https://example.test/api/webhooks/gmail', {
    method: 'POST', headers: { authorization: 'Bearer test' }, body: JSON.stringify({ subscription: 'subscription-one', message: { messageId: 'message-one', data: Buffer.from(JSON.stringify({ emailAddress: 'user@example.test', historyId: '123' })).toString('base64') } }),
  });
  expect((await POST(request as NextRequest)).status).toBe(status);
  expect(mocks.after).not.toHaveBeenCalled();
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
  await background(200);
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
  mocks.runSync.mockResolvedValueOnce({errors:[],hasMorePagesPending:true}).mockResolvedValueOnce({errors:[],hasMorePagesPending:false});
  await background(200);
  expect(mocks.runSync).toHaveBeenCalledTimes(2);
  expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(['claim_gmail_pubsub_message', 'complete_gmail_pubsub_message']);
  expect(console.error).not.toHaveBeenCalled();
});
it('requests a retry instead of acknowledging another live inbox lease',async()=>{
  mocks.rpc.mockResolvedValueOnce({data:false,error:null});
  await background(503);expect(mocks.runSync).not.toHaveBeenCalled();
});
it('does not reacquire a completed push on duplicate delivery',async()=>{
  mocks.query.mockReturnValue({select:()=>({eq:()=>({eq:()=>({maybeSingle:async()=>({data:{status:'completed'},error:null})})})})});
  await background(200);expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.runSync).not.toHaveBeenCalled();
});
it('retries a database account lookup failure instead of treating the account as disconnected', async () => {
  mocks.query.mockImplementation((table: string) => {
    const result = table === 'gmail_accounts'
      ? { data: null, error: { code: '57014', message: 'Statement timeout' } }
      : { data: null, error: null };
    return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: async () => result };
  });
  await background(503);
  expect(mocks.runSync).not.toHaveBeenCalled();
  expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(['claim_gmail_pubsub_message', 'fail_gmail_pubsub_message']);
});

function sharedAccount(cursor = '123') {
  vi.stubEnv('SHARED_COLLEGE_EMAIL', 'user@example.test');
  mocks.query.mockImplementation((table: string) => {
    const result = { data: table === 'gmail_accounts' ? { id: 'account', user_id: 'user-one', account_type: 'college', last_history_id: cursor } : null, error: null };
    return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: async () => result };
  });
}
it.each([
  { alreadyRunning: true, failed: 0, hasMore: true },
  { alreadyRunning: false, failed: 1, hasMore: false },
  { alreadyRunning: false, failed: 0, hasMore: true, userWorkPending: true },
])('requests a retry for unfinished shared College ingestion: %j', async result => {
  sharedAccount(); mocks.shared.mockResolvedValue(result);
  await background(503);
  expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(['claim_gmail_pubsub_message', 'fail_gmail_pubsub_message']);
});
it('waits for all shared College batches before acknowledging', async () => {
  sharedAccount();
  mocks.shared.mockResolvedValueOnce({ alreadyRunning: false, failed: 0, hasMore: true }).mockResolvedValueOnce({ alreadyRunning: false, failed: 0, hasMore: false });
  await background(200);
  expect(mocks.shared).toHaveBeenCalledTimes(2);
  expect(mocks.shared).toHaveBeenCalledWith(expect.objectContaining({ globalDeadline: expect.any(Number) }));
  expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(['claim_gmail_pubsub_message', 'complete_gmail_pubsub_message']);
});
it('does not acknowledge a shared history cursor behind the incoming push', async () => {
  sharedAccount('122'); mocks.shared.mockResolvedValue({ alreadyRunning: false, failed: 0, hasMore: false });
  await background(503);
  expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(['claim_gmail_pubsub_message', 'fail_gmail_pubsub_message']);
});
