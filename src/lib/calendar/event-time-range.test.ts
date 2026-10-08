import { describe, expect, it } from 'vitest';
import { formatEventTimeRange } from '@/app/(dashboard)/calendar/_components/calendar-client';

describe('formatEventTimeRange', () => {
  it('formats time range when explicit endTime is provided on the same day', () => {
    const start = new Date(2026, 9, 4, 0, 1); // 12:01 AM
    const end = new Date(2026, 9, 4, 23, 59); // 11:59 PM
    expect(formatEventTimeRange(start, end, 'online_test')).toBe('12:01 AM – 11:59 PM');
  });

  it('assumes 2 hours fallback when endTime is missing for tests', () => {
    const start = new Date(2026, 9, 4, 10, 0); // 10:00 AM
    expect(formatEventTimeRange(start, null, 'online_test')).toBe('10:00 AM – 12:00 PM');
    expect(formatEventTimeRange(start, undefined, 'assessment')).toBe('10:00 AM – 12:00 PM');
  });

  it('does NOT fabricate 2 hours duration for registration deadlines', () => {
    const deadline = new Date(2026, 9, 6, 13, 0); // 1:00 PM
    expect(formatEventTimeRange(deadline, null, 'registration_deadline')).toBe('1:00 PM');
    expect(formatEventTimeRange(deadline, null, 'deadline')).toBe('1:00 PM');
  });

  it('adds (+1d) marker when event ends past midnight on the next calendar day', () => {
    const start = new Date(2026, 9, 4, 23, 0); // 11:00 PM
    const end = new Date(2026, 9, 5, 1, 0);   // 1:00 AM next day
    expect(formatEventTimeRange(start, end, 'online_test')).toBe('11:00 PM – 1:00 AM (+1d)');
  });

  it('adds (+1d) marker when fallback 2 hours crosses midnight', () => {
    const start = new Date(2026, 9, 4, 23, 0); // 11:00 PM -> ends 1:00 AM next day
    expect(formatEventTimeRange(start, null, 'online_test')).toBe('11:00 PM – 1:00 AM (+1d)');
  });

  it('returns null if start time is invalid or null', () => {
    expect(formatEventTimeRange(null, null)).toBeNull();
    expect(formatEventTimeRange('invalid date', null)).toBeNull();
  });
});
