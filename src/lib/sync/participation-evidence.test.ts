import { describe, expect, it } from 'vitest';
import { getMissingPersonalSyncSetup, hasUserPlacementEvidence, isConfirmedShortlistEvidence, isShortlistMatchEvidence } from './participation-evidence';

describe('user placement evidence', () => {
  it('requires Personal Gmail and NeoPAT ID, not an individual College inbox', () => {
    expect(getMissingPersonalSyncSetup({ hasPersonal: true, userNeoId: '23BCE10472' })).toEqual([]);
    expect(getMissingPersonalSyncSetup({ hasPersonal: false, userNeoId: '23BCE10472' })).toEqual(['Personal Gmail (for NeoPAT drives)']);
  });

  it('does not treat a shared College circular alone as user evidence', () => {
    expect(hasUserPlacementEvidence({
      hasPersonalDriveEvidence: false,
      hasConfirmedShortlistMatch: false,
    })).toBe(false);
  });

  it('accepts personal drive evidence, a confirmed shortlist, or a manual override', () => {
    expect(hasUserPlacementEvidence({ hasPersonalDriveEvidence: true, hasConfirmedShortlistMatch: false })).toBe(true);
    expect(hasUserPlacementEvidence({ hasPersonalDriveEvidence: false, hasConfirmedShortlistMatch: true })).toBe(true);
    expect(hasUserPlacementEvidence({ hasPersonalDriveEvidence: false, hasConfirmedShortlistMatch: false, manualOverride: true })).toBe(true);
  });

  it('only treats a matched genuine College shortlist as shortlist evidence', () => {
    const base = {
      isCollegeBroadcast: true,
      isNeoMatched: true,
      isShortlistEmail: true,
      isInAppliedList: false,
      isEliminationEmail: false,
    };
    expect(isConfirmedShortlistEvidence(base)).toBe(true);
    expect(isConfirmedShortlistEvidence({ ...base, isNeoMatched: false })).toBe(false);
    expect(isConfirmedShortlistEvidence({ ...base, isShortlistEmail: false })).toBe(false);
    expect(isConfirmedShortlistEvidence({ ...base, isInAppliedList: true })).toBe(false);
    expect(isConfirmedShortlistEvidence({ ...base, isEliminationEmail: true })).toBe(false);
    expect(isConfirmedShortlistEvidence({ ...base, isCollegeBroadcast: false })).toBe(false);
  });

  it('does not count applied or opt-in roster matches as shortlist evidence', () => {
    expect(isShortlistMatchEvidence({ matchType: 'xlsx_cell', matchedValue: 'Matched in test shortlist' })).toBe(true);
    expect(isShortlistMatchEvidence({ matchType: 'xlsx_applied_list', matchedValue: 'Matched in applied list' })).toBe(false);
    expect(isShortlistMatchEvidence({ matchType: 'email_body', matchedValue: 'registration list' })).toBe(false);
    expect(isShortlistMatchEvidence({ matchType: 'email_body', matchedValue: 'roll number match', matchedRoundType: 'test' })).toBe(true);
  });
});
