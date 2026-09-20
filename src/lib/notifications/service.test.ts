import { describe, expect, it } from 'vitest';
import { buildDeadlineNotificationDedupeKey } from './service';

describe('deadline notification identity', () => {
  it('is stable when the underlying event row is recreated', () => {
    const first = buildDeadlineNotificationDedupeKey({
      userId: 'user-1',
      placementDriveId: 'drive-1204',
      deadline: '2026-09-19T08:30:00.000Z',
      leadMinutes: 1440,
    });
    const recreated = buildDeadlineNotificationDedupeKey({
      userId: 'user-1',
      placementDriveId: 'drive-1204',
      deadline: new Date('2026-09-19T08:30:00.000Z'),
      leadMinutes: 1440,
    });
    expect(recreated).toBe(first);
  });

  it('does not collide across drives of the same company', () => {
    const driveA = buildDeadlineNotificationDedupeKey({
      userId: 'user-1',
      placementDriveId: 'drive-1204',
      companyId: 'company',
      deadline: '2026-09-19T08:30:00.000Z',
      leadMinutes: 120,
    });
    const driveB = buildDeadlineNotificationDedupeKey({
      userId: 'user-1',
      placementDriveId: 'drive-1317',
      companyId: 'company',
      deadline: '2026-09-19T08:30:00.000Z',
      leadMinutes: 120,
    });
    expect(driveA).not.toBe(driveB);
  });

  it('uses explicit legacy identity when no drive exists', () => {
    const key = buildDeadlineNotificationDedupeKey({
      userId: 'user-1',
      companyId: 'company',
      deadline: '2026-09-19T08:30:00.000Z',
      leadMinutes: 15,
    });
    expect(key).toContain('legacy:company');
  });
});
