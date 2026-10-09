import { expect, it, vi } from 'vitest';
import { describeError, diagnosticForStorage, diagnosticMessage } from './error-diagnostics';

it('retains plain PostgREST fields instead of coercing the object to a string', () => {
  const error = { code: '23505', message: 'Duplicate row', details: 'Key already exists', hint: 'Check identity' };
  expect(describeError(error)).toEqual(error);
  expect(diagnosticMessage(describeError(error))).toBe('Duplicate row');
  expect(JSON.parse(diagnosticForStorage(describeError(error)))).toEqual(error);
});

it('retains non-enumerable Error stack/message and nested causes', () => {
  const error = new Error('RPC failed', { cause: { code: '57014', message: 'Query timed out' } });
  expect(describeError(error)).toMatchObject({ name: 'Error', message: 'RPC failed', stack: expect.stringContaining('RPC failed'), cause: { code: '57014', message: 'Query timed out' } });
});

it('retains Google quota details without request headers, tokens or mail bodies', () => {
  const error = Object.assign(new Error('Quota exceeded'), {
    code: 429,
    config: { headers: { Authorization: 'Bearer secret' }, data: 'private mail' },
    response: { status: 429, headers: { 'set-cookie': 'secret' }, data: { messages: ['private mail'], error: { code: 429, message: 'Rate limit', errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded', message: 'Retry later' }] } } },
  });
  expect(describeError(error)).toMatchObject({ code: 429, response: { status: 429, error: { errors: [{ reason: 'rateLimitExceeded' }] } } });
  expect(JSON.stringify(describeError(error))).not.toMatch(/private mail|Authorization|secret|set-cookie/);
});

it('handles circular causes, bigint, undefined, and hostile accessors without throwing', () => {
  const error = { message: 'Circular', cause: null as unknown, toJSON: () => { throw Error('unsafe'); } };
  error.cause = error;
  Object.defineProperty(error, 'code', { get() { throw Error('unsafe'); } });
  expect(describeError(error)).toEqual({ message: 'Circular', cause: { message: '[Circular error]' } });
  expect(describeError(BigInt(42))).toEqual({ message: '42' });
  expect(describeError(undefined)).toEqual({ message: 'undefined' });
  expect(describeError({})).toEqual({ message: 'Unknown object error' });
});

it('redacts credentials even when present in selected diagnostic strings', () => {
  const text = JSON.stringify(describeError({ message: 'Bearer credential', details: 'access_token=secret&client_secret=hidden' }));
  expect(text).not.toMatch(/credential|secret&|hidden/);
  expect(text).toContain('[REDACTED]');
});

it('keeps stored diagnostics valid and within the existing 2,000-character limit', () => {
  const diagnostic = describeError({ code: '57014', message: 'm'.repeat(5000), details: 'd'.repeat(5000), hint: 'h'.repeat(5000), cause: new Error('c'.repeat(5000)) });
  const text = diagnosticForStorage({ operation: 'personal_sync', error: diagnostic });
  expect(text.length).toBeLessThanOrEqual(2000);
  expect(JSON.parse(text)).toMatchObject({ operation: 'personal_sync', error: { code: '57014' } });
  expect(text).not.toContain('stack');
});

it('redacts configured credentials, encoded passwords and credentials embedded in URLs', () => {
  vi.stubEnv('TEST_API_KEY', 'configured-secret-value');
  try {
    const text = JSON.stringify(describeError({ message: 'Failed configured-secret-value https://example.test?token=hidden-value', details: 'postgresql://postgres:db-password@database.test/postgres' }));
    expect(text).not.toMatch(/configured-secret-value|hidden-value|db-password/);
    expect(text).toContain('[REDACTED]');
  } finally { vi.unstubAllEnvs(); }
});
