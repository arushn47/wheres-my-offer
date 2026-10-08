import { describe, expect, it } from 'vitest';
import { shouldPauseRequest } from './write-pause';

describe('cutover writer fence', () => {
  it('leaves all existing requests unchanged unless explicitly enabled', () => {
    for (const path of ['/companies', '/api/webhooks/gmail', '/api/cron/sync', '/api/auth/callback']) {
      for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']) {
        expect(shouldPauseRequest(path, method, false)).toBe(false);
      }
    }
  });

  it('rejects Pub/Sub before its claim or acknowledgment and blocks GET writers', () => {
    expect(shouldPauseRequest('/api/webhooks/gmail', 'POST', true)).toBe(true);
    for (const path of ['/api/cron/sync', '/api/cron/sync/', '/api/auth/callback', '/api/sync/reprocess']) {
      expect(shouldPauseRequest(path, 'GET', true)).toBe(true);
    }
  });

  it('blocks server actions and mutations even on otherwise readable paths', () => {
    for (const path of ['/companies', '/settings', '/api/notifications', '/api/sync/status', '/api/sync/updates']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(shouldPauseRequest(path, method, true)).toBe(true);
      }
    }
  });

  it('keeps existing pages and audited progress APIs readable', () => {
    for (const path of ['/companies', '/companies/drive-id', '/login', '/api/sync/status', '/api/sync/updates', '/api/sync/shared-status', '/api/notifications']) {
      expect(shouldPauseRequest(path, 'GET', true)).toBe(false);
      expect(shouldPauseRequest(path, 'HEAD', true)).toBe(false);
    }
  });
});
