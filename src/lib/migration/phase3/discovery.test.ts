import { describe, expect, it } from 'vitest';
import { buildUserDiscoveryBundle } from './discovery';

const USER_A = 'user-a';
const COMPANY_1 = 'company-1';
const COMPANY_2 = 'company-2';

describe('buildUserDiscoveryBundle — legacy record selection', () => {
  it('only includes rows with a null placement_drive_id as legacy candidates', () => {
    const bundle = buildUserDiscoveryBundle({
      userId: USER_A,
      userDrives: [],
      emails: [],
      applications: [
        { id: 'app-1', userId: USER_A, companyId: COMPANY_1, placementDriveId: null },
        { id: 'app-2', userId: USER_A, companyId: COMPANY_1, placementDriveId: 'already-drive' },
      ],
      events: [],
      notifications: [],
      candidateMatches: [],
    });

    expect(bundle.legacyRecords).toHaveLength(1);
    expect(bundle.legacyRecords[0]).toMatchObject({ recordType: 'application', id: 'app-1' });
  });

  it('skips notifications with no company_id and records them as unscoped', () => {
    const bundle = buildUserDiscoveryBundle({
      userId: USER_A,
      userDrives: [],
      emails: [],
      applications: [],
      events: [],
      notifications: [{ id: 'n-1', userId: USER_A, companyId: null, placementDriveId: null }],
      candidateMatches: [],
    });

    expect(bundle.legacyRecords).toHaveLength(0);
    expect(bundle.unscopedRecords).toEqual([
      { recordType: 'notification', recordId: 'n-1', userId: USER_A, reason: expect.stringContaining('no company_id') },
    ]);
  });

  it('skips emails with no company_id and records them as unscoped', () => {
    const bundle = buildUserDiscoveryBundle({
      userId: USER_A,
      userDrives: [],
      emails: [{ id: 'e-1', userId: USER_A, companyId: null, placementDriveId: null, subject: null, bodySnippet: null }],
      applications: [],
      events: [],
      notifications: [],
      candidateMatches: [],
    });

    expect(bundle.legacyRecords).toHaveLength(0);
    expect(bundle.unscopedRecords[0].recordType).toBe('email');
  });
});

describe('buildUserDiscoveryBundle — email own-evidence extraction', () => {
  it('extracts drive numbers from an email\'s own subject/body as ownDriveNumbers', () => {
    const bundle = buildUserDiscoveryBundle({
      userId: USER_A,
      userDrives: [],
      emails: [
        {
          id: 'e-1',
          userId: USER_A,
          companyId: COMPANY_1,
          placementDriveId: null,
          subject: 'Regarding drive pat-PL-2026-1234',
          bodySnippet: null,
        },
      ],
      applications: [],
      events: [],
      notifications: [],
      candidateMatches: [],
    });

    const email = bundle.legacyRecords.find((r) => r.recordType === 'email');
    expect(email?.ownDriveNumbers).toContain('pat-pl-2026-1234');
  });
});

describe('buildUserDiscoveryBundle — textless records remain unassigned', () => {
  it('does not feed sibling email drive numbers into applications/events/notifications', () => {
    const bundle = buildUserDiscoveryBundle({
      userId: USER_A,
      userDrives: [],
      emails: [
        {
          id: 'e-1',
          userId: USER_A,
          companyId: COMPANY_1,
          placementDriveId: null,
          subject: 'pat-PL-2026-9999',
          bodySnippet: null,
        },
      ],
      applications: [{ id: 'app-1', userId: USER_A, companyId: COMPANY_1, placementDriveId: null }],
      events: [{ id: 'ev-1', userId: USER_A, companyId: COMPANY_1, placementDriveId: null }],
      notifications: [{ id: 'n-1', userId: USER_A, companyId: COMPANY_1, placementDriveId: null }],
      candidateMatches: [],
    });

    const app = bundle.legacyRecords.find((r) => r.recordType === 'application');
    const ev = bundle.legacyRecords.find((r) => r.recordType === 'event');
    const notif = bundle.legacyRecords.find((r) => r.recordType === 'notification');
    expect(app?.ownDriveNumbers).toEqual([]);
    expect(ev?.ownDriveNumbers).toEqual([]);
    expect(notif?.ownDriveNumbers).toEqual([]);
  });

  it('never leaks a different company\'s discovered drive numbers into this company\'s records', () => {
    const bundle = buildUserDiscoveryBundle({
      userId: USER_A,
      userDrives: [],
      emails: [
        { id: 'e-1', userId: USER_A, companyId: COMPANY_1, placementDriveId: null, subject: 'pat-PL-2026-1111', bodySnippet: null },
        { id: 'e-2', userId: USER_A, companyId: COMPANY_2, placementDriveId: null, subject: 'pat-PL-2026-2222', bodySnippet: null },
      ],
      applications: [{ id: 'app-1', userId: USER_A, companyId: COMPANY_1, placementDriveId: null }],
      events: [],
      notifications: [],
      candidateMatches: [],
    });

    const app = bundle.legacyRecords.find((r) => r.recordType === 'application');
    expect(app?.ownDriveNumbers).toEqual([]);
  });
});

describe('buildUserDiscoveryBundle — candidate_match tenant resolution', () => {
  it('resolves company via application_id when present', () => {
    const bundle = buildUserDiscoveryBundle({
      userId: USER_A,
      userDrives: [],
      emails: [],
      applications: [{ id: 'app-1', userId: USER_A, companyId: COMPANY_1, placementDriveId: null }],
      events: [],
      notifications: [],
      candidateMatches: [{ id: 'cm-1', userId: USER_A, emailId: null, applicationId: 'app-1', placementDriveId: null }],
    });

    const cm = bundle.legacyRecords.find((r) => r.recordType === 'candidate_match');
    expect(cm?.companyId).toBe(COMPANY_1);
  });

  it('resolves company via email_id when application_id is absent', () => {
    const bundle = buildUserDiscoveryBundle({
      userId: USER_A,
      userDrives: [],
      emails: [{ id: 'e-1', userId: USER_A, companyId: COMPANY_2, placementDriveId: null, subject: null, bodySnippet: null }],
      applications: [],
      events: [],
      notifications: [],
      candidateMatches: [{ id: 'cm-1', userId: USER_A, emailId: 'e-1', applicationId: null, placementDriveId: null }],
    });

    const cm = bundle.legacyRecords.find((r) => r.recordType === 'candidate_match');
    expect(cm?.companyId).toBe(COMPANY_2);
  });

  it('marks a candidate_match unscoped when neither application nor email resolves a company', () => {
    const bundle = buildUserDiscoveryBundle({
      userId: USER_A,
      userDrives: [],
      emails: [],
      applications: [],
      events: [],
      notifications: [],
      candidateMatches: [{ id: 'cm-1', userId: USER_A, emailId: null, applicationId: null, placementDriveId: null }],
    });

    expect(bundle.legacyRecords).toHaveLength(0);
    expect(bundle.unscopedRecords[0]).toMatchObject({ recordType: 'candidate_match', recordId: 'cm-1' });
  });

  it('never assigns a candidate_match to a drive already assigned (idempotent skip at discovery time)', () => {
    const bundle = buildUserDiscoveryBundle({
      userId: USER_A,
      userDrives: [],
      emails: [],
      applications: [],
      events: [],
      notifications: [],
      candidateMatches: [{ id: 'cm-1', userId: USER_A, emailId: null, applicationId: null, placementDriveId: 'drive-1' }],
    });

    expect(bundle.legacyRecords).toHaveLength(0);
    expect(bundle.unscopedRecords).toHaveLength(0);
  });

  it('does not use an existing candidate-match drive to assign its null-drive source email', () => {
    const bundle = buildUserDiscoveryBundle({
      userId: USER_A,
      userDrives: [],
      emails: [{ id: 'e-1', userId: USER_A, companyId: COMPANY_1, placementDriveId: null, subject: 'Historical shortlist', bodySnippet: null }],
      applications: [],
      events: [],
      notifications: [],
      candidateMatches: [{ id: 'cm-1', userId: USER_A, emailId: 'e-1', applicationId: null, placementDriveId: 'drive-a' }],
    });

    const email = bundle.legacyRecords.find((record) => record.recordType === 'email');
    expect(email?.placementDriveId).toBeNull();
    expect(email?.ownDriveNumbers).toEqual([]);
    expect(bundle.legacyRecords.find((record) => record.recordType === 'candidate_match')).toBeUndefined();
  });
});
