import { describe, it, expect, vi } from 'vitest';
import {
  getStartOfRegistrationDate,
  formatIstDate,
  isEmailAllowedByDriveBoundary,
  getDriveRegistrationDateBoundary,
} from './drive-temporal-boundary';

describe('drive-temporal-boundary', () => {
  describe('getStartOfRegistrationDate', () => {
    it('calculates 00:00:00 IST for a given date in UTC', () => {
      // 2026-09-29T04:30:54Z is 10:00:54 IST on 2026-09-29
      const d = new Date('2026-09-29T04:30:54.000Z');
      const startOfDay = getStartOfRegistrationDate(d);
      // 2026-09-29T00:00:00+05:30 in UTC is 2026-09-28T18:30:00.000Z
      expect(startOfDay.toISOString()).toBe('2026-09-28T18:30:00.000Z');
    });

    it('calculates the same start of day across different times of the same IST calendar day', () => {
      const earlyMorning = new Date('2026-09-28T19:00:00.000Z'); // 00:30 IST on Sept 29
      const lateNight = new Date('2026-09-29T18:00:00.000Z'); // 23:30 IST on Sept 29
      expect(getStartOfRegistrationDate(earlyMorning).toISOString()).toBe('2026-09-28T18:30:00.000Z');
      expect(getStartOfRegistrationDate(lateNight).toISOString()).toBe('2026-09-28T18:30:00.000Z');
    });
  });

  describe('formatIstDate', () => {
    it('formats dates in Indian locale IST correctly', () => {
      const d = new Date('2026-09-29T04:30:54.000Z');
      const formatted = formatIstDate(d);
      expect(formatted).toMatch(/29\s+Sep[t]?\s+2026/i);
    });
  });

  describe('isEmailAllowedByDriveBoundary', () => {
    const minAllowedDate = new Date('2026-09-28T18:30:00.000Z'); // 2026-09-29 00:00:00 IST

    it('allows emails received on or after minAllowedDate', () => {
      // Exactly at 00:00:00 IST
      expect(isEmailAllowedByDriveBoundary('2026-09-28T18:30:00.000Z', minAllowedDate)).toBe(true);
      // 1 minute before the personal email was sent (e.g. college circular at 09:59 IST on Sept 29)
      expect(isEmailAllowedByDriveBoundary('2026-09-29T04:29:08.000Z', minAllowedDate)).toBe(true);
      // Days after
      expect(isEmailAllowedByDriveBoundary('2026-10-05T12:00:00.000Z', minAllowedDate)).toBe(true);
    });

    it('blocks emails received prior to minAllowedDate', () => {
      // 6 days prior (e.g. Sept 23 Deloitte circulars from previous cycle)
      expect(isEmailAllowedByDriveBoundary('2026-09-23T09:37:12.000Z', minAllowedDate)).toBe(false);
      // Just 1 second before midnight IST
      expect(isEmailAllowedByDriveBoundary('2026-09-28T18:29:59.000Z', minAllowedDate)).toBe(false);
    });

    it('returns true when minAllowedDate is null (no boundary restriction)', () => {
      expect(isEmailAllowedByDriveBoundary('2026-09-23T09:37:12.000Z', null)).toBe(true);
      expect(isEmailAllowedByDriveBoundary(null, null)).toBe(true);
    });

    it('returns false when emailDate is missing/invalid but boundary exists', () => {
      expect(isEmailAllowedByDriveBoundary(null, minAllowedDate)).toBe(false);
      expect(isEmailAllowedByDriveBoundary(undefined, minAllowedDate)).toBe(false);
      expect(isEmailAllowedByDriveBoundary('invalid-date', minAllowedDate)).toBe(false);
    });
  });

  describe('getDriveRegistrationDateBoundary', () => {
    it('returns nulls when targetDriveIds is empty', async () => {
      const mockSupabase = {} as any;
      const res = await getDriveRegistrationDateBoundary(mockSupabase, []);
      expect(res.minAllowedDate).toBeNull();
      expect(res.registrationDate).toBeNull();
      expect(res.formattedRegistrationDate).toBeNull();
    });

    it('resolves boundary from personal_emails registration record', async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'personal_emails') {
            return {
              select: vi.fn().mockReturnThis(),
              in: vi.fn().mockReturnThis(),
              or: vi.fn().mockReturnThis(),
              not: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockResolvedValue({
                data: [{ received_at: '2026-09-29T04:30:54.000Z' }],
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      } as any;

      const res = await getDriveRegistrationDateBoundary(mockSupabase, ['drive-123']);
      expect(res.registrationDate?.toISOString()).toBe('2026-09-29T04:30:54.000Z');
      expect(res.minAllowedDate?.toISOString()).toBe('2026-09-28T18:30:00.000Z');
      expect(res.formattedRegistrationDate).toMatch(/29\s+Sep[t]?\s+2026/i);
    });

    it('falls back to placement_drives created_at if no emails found', async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'personal_emails') {
            return {
              select: vi.fn().mockReturnThis(),
              in: vi.fn().mockReturnThis(),
              or: vi.fn().mockReturnThis(),
              not: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockResolvedValue({ data: [] }),
            };
          }
          if (table === 'placement_drives') {
            return {
              select: vi.fn().mockReturnThis(),
              in: vi.fn().mockResolvedValue({
                data: [{ source_email_id: null, created_at: '2026-09-29T05:00:00.000Z' }],
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      } as any;

      const res = await getDriveRegistrationDateBoundary(mockSupabase, ['drive-123']);
      expect(res.registrationDate?.toISOString()).toBe('2026-09-29T05:00:00.000Z');
      expect(res.minAllowedDate?.toISOString()).toBe('2026-09-28T18:30:00.000Z');
    });
  });
});
