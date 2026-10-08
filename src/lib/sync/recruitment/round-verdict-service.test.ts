import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCandidateIdentity } from '../identity/user-identity';
import { loadCandidateRosters } from '../attachments/roster-lookup';
import { calculateDriveRoundVerdicts } from './round-verdict-service';
import type { createAdminClient } from '@/lib/supabase/admin';

vi.mock('../identity/user-identity', async importOriginal => ({
  ...await importOriginal<typeof import('../identity/user-identity')>(),
  loadUserCandidateIdentity: vi.fn(async () => buildCandidateIdentity({ neoId: 'SAMPLE123' })),
}));
vi.mock('../attachments/roster-lookup', () => ({ loadCandidateRosters: vi.fn() }));
vi.mock('@/lib/notifications/service', () => ({ sendNotification: vi.fn() }));

const admin = {
  from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }) }),
} as unknown as ReturnType<typeof createAdminClient>;

beforeEach(() => {
  vi.mocked(loadCandidateRosters).mockResolvedValue([{
    collegeEmailId: 'next', filename: 'shortlisted.xlsx', parseStatus: 'complete',
    sourceKind: 'attachment', sourceKey: 'attachment-next', sizeBytes: 100,
    extractedRows: [{ sheetName: 'Sheet1', rows: [['Neo ID'], ['OTHER123']] }],
  }]);
});

describe('PPT and later selection round classification', () => {
  it.each(['', 'Update (Venue Change): '])('keeps %sFoodhub next-round interview evidence distinct from PPT-only lists', async prefix => {
    const verdicts = await calculateDriveRoundVerdicts(admin, 'user', 'drive', [{
      id: 'next', college_email_id: 'next', received_at: '2026-08-14T13:17:33Z',
      subject: `${prefix}Foodhub PPT & Next round of selection process is scheduled on (20-08-2026) 08:00 AM`,
      body_text: 'Please find the attached list of students who have been shortlisted based on the HackerEarth assessment. Only the shortlisted candidates should report for the interview.',
    }]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ roundType: 'interview', state: 'verified_absent', eligible: false });
  });

  it('keeps a PPT-only shortlist scoped to PPT even when the body lists a later interview agenda', async () => {
    const verdicts = await calculateDriveRoundVerdicts(admin, 'user', 'drive', [{
      id: 'next', college_email_id: 'next', received_at: '2026-08-14T13:17:33Z',
      subject: 'Company PPT shortlisted candidates',
      body_text: 'Please find the attached shortlisted students list for the PPT. Selection process: PPT, test, interview.',
    }]);
    expect(verdicts[0]).toMatchObject({ roundType: 'ppt', state: 'verified_absent', eligible: false });
  });
});
