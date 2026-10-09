import { afterEach, expect, it, vi } from 'vitest';
import { createAdminClient } from './admin';
import { withOwnedMutationLease } from '../sync/lease-context';
import { reuseRunRead } from '../sync/run-reads';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('invalidates routing on both sides of a canonical write and retains the lease header', async () => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.invalid');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-key');
  let finish!: (value: Response) => void;
  let started!: () => void;
  const startedWrite = new Promise<void>(resolve => { started = resolve; });
  const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
    expect(init?.method).toBe('PATCH');
    expect(new Headers(init?.headers).get('x-sync-run-id')).toBe('owned');
    started();
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  vi.stubGlobal('fetch', fetch);
  const read = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('during-write').mockResolvedValueOnce('committed');
  await withOwnedMutationLease('alice', 'owned', async () => {
    expect(await reuseRunRead(null, 'circular-routing', read)).toBe('old');
    const write = createAdminClient().from('college_emails').update({ parsed_company_name: 'Company' }).eq('id', 'canonical').then(result => result);
    await startedWrite;
    expect(await reuseRunRead(null, 'circular-routing', read)).toBe('during-write');
    finish(new Response(null, { status: 204 }));
    expect((await write).error).toBeNull();
    expect(await reuseRunRead(null, 'circular-routing', read)).toBe('committed');
    expect(read).toHaveBeenCalledTimes(3); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
