import { afterEach, describe, expect, it, vi } from 'vitest';
import { measuredAdminFetch, withQueryMetrics } from './query-metrics';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('aggregate query metrics', () => {
  it('passes through the original response when disabled', async () => {
    vi.stubEnv('SUPABASE_QUERY_METRICS', 'false');
    const response = new Response('original');
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await withQueryMetrics('sync', () => measuredAdminFetch('https://example.com/rest/v1/emails'))).toBe(response);
    expect(log).not.toHaveBeenCalled();
  });
  it('counts consumed UTF-8 bytes, preserves response data, and never logs sensitive filters or content', async () => {
    vi.stubEnv('SUPABASE_QUERY_METRICS', 'true');
    const body = JSON.stringify({ secret: 'private email 🔒' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {status:200,headers:{'content-type':'application/json'}})));
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const data = await withQueryMetrics('sync', () => withQueryMetrics('recalculation', async () => {
      const response = await measuredAdminFetch('https://private-ref.supabase.co/rest/v1/personal_emails?user_id=eq.private-user', {headers:{Authorization:'secret-token'}});
      expect(response.headers.get('content-type')).toBe('application/json');
      return response.json();
    }));
    expect(data).toEqual(JSON.parse(body));
    expect(log).toHaveBeenCalledTimes(1);
    const summary = JSON.parse(log.mock.calls[0][1]);
    expect(summary.operations['GET personal_emails']).toMatchObject({requests:1,bytes:Buffer.byteLength(body),failures:0});
    const serialized = JSON.stringify(log.mock.calls);
    for (const privateValue of ['private-ref','private-user','secret-token','private email']) expect(serialized).not.toContain(privateValue);
  });
  it('records failures and preserves the original exception', async () => {
    vi.stubEnv('SUPABASE_QUERY_METRICS', 'true');
    const error = new Error('network failed');
    vi.stubGlobal('fetch', vi.fn(async () => { throw error; }));
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(withQueryMetrics('sync', () => measuredAdminFetch('https://example.com/rest/v1/emails'))).rejects.toBe(error);
    expect(JSON.parse(log.mock.calls[0][1])).toMatchObject({failed:true,operations:{'GET emails':{failures:1}}});
  });
  it('isolates concurrently running jobs', async () => {
    vi.stubEnv('SUPABASE_QUERY_METRICS', 'true');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('abc')));
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    await Promise.all(['emails','events'].map(resource => withQueryMetrics('sync', async () => {
      await (await measuredAdminFetch(`https://example.com/rest/v1/${resource}`)).text();
    })));
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map(call => Object.keys(JSON.parse(call[1]).operations))).toEqual([['GET emails'],['GET events']]);
  });
});
