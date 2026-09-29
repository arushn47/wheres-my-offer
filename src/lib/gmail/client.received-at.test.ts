import { describe, expect, it } from 'vitest';
import { resolveReceivedAt } from './client';

describe('resolveReceivedAt', () => {
  it('prefers Gmail internalDate (authoritative mailbox receipt) over the sender Date header', () => {
    const internal = Date.UTC(2026, 7, 14, 4, 16, 51); // 2026-08-14T04:16:51Z
    const resolved = resolveReceivedAt(
      String(internal),
      'Thu, 13 Aug 2026 23:59:00 +0530' // sender claims a different day
    );
    expect(resolved.receivedAt.getTime()).toBe(internal);
    expect(resolved.internalDate?.getTime()).toBe(internal);
    expect(resolved.dateHeader?.toISOString()).toBe('2026-08-13T18:29:00.000Z');
  });

  it('falls back to the Date header only when Gmail omits internalDate', () => {
    const resolved = resolveReceivedAt(null, 'Fri, 14 Aug 2026 09:46:51 +0530');
    expect(resolved.internalDate).toBeNull();
    expect(resolved.receivedAt.toISOString()).toBe('2026-08-14T04:16:51.000Z');
  });

  it('never stores an invalid date, and ignores an unparseable Date header', () => {
    const resolved = resolveReceivedAt(undefined, 'not a date');
    expect(Number.isNaN(resolved.receivedAt.getTime())).toBe(false);
    expect(resolved.internalDate).toBeNull();
    expect(resolved.dateHeader).toBeNull();
  });

  it('accepts numeric internalDate as well as the string form Gmail returns', () => {
    const numeric = resolveReceivedAt(1755145011000, null);
    expect(numeric.receivedAt.getTime()).toBe(1755145011000);
  });
});
