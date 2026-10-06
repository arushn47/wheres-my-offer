import { describe, expect, it, vi, beforeEach } from 'vitest';
import { catchUpMissingNotifications } from '@/lib/sync/reprocess';

vi.mock('@/lib/sync/round-verdict-service', () => ({ dispatchRoundNotificationOutbox: vi.fn().mockResolvedValue(undefined) }));

// Mock notification services
vi.mock('@/lib/notifications/service', () => ({
  notifyNewDrive: vi.fn().mockResolvedValue({ inAppCreated: true, pushSent: true }),
  notifyEventScheduled: vi.fn().mockResolvedValue({ inAppCreated: true, pushSent: true }),
  notifyShortlistMatch: vi.fn().mockResolvedValue({ inAppCreated: true, pushSent: true }),
}));

vi.mock('@/lib/sync/user-identity', () => ({
  loadUserCandidateIdentity: vi.fn().mockResolvedValue({
    neoId: '23BCE10472',
    emails: ['arush.23bce10472@vitbhopal.ac.in'],
  }),
}));

vi.mock('@/lib/utils', () => ({
  getDriveMode: vi.fn().mockReturnValue('Online'),
}));

describe('catchUpMissingNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('catches up missing new drive notification for a recent drive', async () => {
    const { notifyNewDrive } = await import('@/lib/notifications/service');
    const recentDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'applications') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: 'app-1',
                    placement_drive_id: 'drive-recent',
                    status: 'not_applied',
                    role: 'Graduate Trainee',
                    ctc: '7 LPA',
                    stipend: null,
                    location: 'Pune',
                    notes: '',
                    category: 'Dream',
                  },
                ],
              }),
            }),
          };
        }
        if (table === 'placement_drives') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: 'drive-recent',
                    drive_name: 'Mercedes Benz',
                    company_id: 'comp-1',
                    created_at: recentDate,
                    source_college_email_id: 'col-1',
                  },
                ],
              }),
            }),
          };
        }
        if (table === 'companies') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [{ id: 'comp-1', name: 'Mercedes Benz' }],
              }),
            }),
          };
        }
        if (table === 'notifications') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: [], // No prior notifications
              }),
            }),
          };
        }
        if (table === 'personal_emails') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  gte: vi.fn().mockReturnValue({
                    order: vi.fn().mockReturnValue({
                      limit: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({
                          data: { id: 'p-1', received_at: recentDate },
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'college_emails') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                gte: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'col-1', received_at: recentDate },
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'events') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({
                  data: [],
                }),
              }),
            }),
          };
        }
        if (table === 'candidate_matches') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [],
                  }),
                }),
              }),
            }),
          };
        }
        return { select: vi.fn() };
      }),
    };

    const result = await catchUpMissingNotifications(mockSupabase as any, 'user-123');
    expect(result.newDrivesNotified).toBe(1);
    expect(notifyNewDrive).toHaveBeenCalledTimes(1);
    expect(notifyNewDrive).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-123',
        placementDriveId: 'drive-recent',
        companyName: 'Mercedes Benz',
        role: 'Graduate Trainee',
        ctc: '7 LPA',
      })
    );
  });

  it('skips new drive notification if dedupe_key already exists in notifications table', async () => {
    const { notifyNewDrive } = await import('@/lib/notifications/service');
    const recentDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'applications') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: 'app-1',
                    placement_drive_id: 'drive-recent',
                    status: 'not_applied',
                    role: 'Graduate Trainee',
                  },
                ],
              }),
            }),
          };
        }
        if (table === 'placement_drives') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: 'drive-recent',
                    drive_name: 'Mercedes Benz',
                    company_id: 'comp-1',
                    created_at: recentDate,
                  },
                ],
              }),
            }),
          };
        }
        if (table === 'companies') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [{ id: 'comp-1', name: 'Mercedes Benz' }],
              }),
            }),
          };
        }
        if (table === 'notifications') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: [{ dedupe_key: 'new_drive:user-123:drive-recent' }], // Already notified!
              }),
            }),
          };
        }
        if (table === 'events') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ data: [] }),
              }),
            }),
          };
        }
        if (table === 'candidate_matches') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({ data: [] }),
                }),
              }),
            }),
          };
        }
        return { select: vi.fn() };
      }),
    };

    const result = await catchUpMissingNotifications(mockSupabase as any, 'user-123');
    expect(result.newDrivesNotified).toBe(0);
    expect(notifyNewDrive).not.toHaveBeenCalled();
  });

  it('catches up upcoming event notification if un-notified', async () => {
    const { notifyEventScheduled } = await import('@/lib/notifications/service');
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // Tomorrow

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'applications') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: 'app-1',
                    placement_drive_id: 'drive-1',
                    status: 'shortlisted',
                  },
                ],
              }),
            }),
          };
        }
        if (table === 'placement_drives') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: 'drive-1',
                    drive_name: 'LTM',
                    company_id: 'comp-1',
                    created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // old drive
                  },
                ],
              }),
            }),
          };
        }
        if (table === 'companies') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [{ id: 'comp-1', name: 'LTM' }],
              }),
            }),
          };
        }
        if (table === 'notifications') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: [{ dedupe_key: 'new_drive:user-123:drive-1' }], // new_drive was already notified
              }),
            }),
          };
        }
        if (table === 'events') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({
                  data: [
                    {
                      id: 'evt-1',
                      event_type: 'online_test',
                      title: 'LTM - Online Assessment',
                      start_time: futureDate.toISOString(),
                      venue: 'Own Location',
                      mode: 'online',
                    },
                  ],
                }),
              }),
            }),
          };
        }
        if (table === 'candidate_matches') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({ data: [] }),
                }),
              }),
            }),
          };
        }
        return { select: vi.fn() };
      }),
    };

    const result = await catchUpMissingNotifications(mockSupabase as any, 'user-123');
    expect(result.eventsNotified).toBe(1);
    expect(notifyEventScheduled).toHaveBeenCalledTimes(1);
    expect(notifyEventScheduled).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-123',
        placementDriveId: 'drive-1',
        companyName: 'LTM',
        eventType: 'online_test',
        venue: 'Own Location',
        candidateConfirmed: true,
      })
    );
  });
});
