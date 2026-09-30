import { describe, expect, it } from 'vitest';
import { deriveShortlistVerificationState, evaluateCachedShortlistRosters, getVerifiedShortlistStatus, resolveDriveVerification, shouldPublishNotShortlisted } from './shortlist-verification';

describe('evidence-aware shortlist verification', () => {
  it('keeps a drive pending until a relevant roster is parsed', () => {
    const result = deriveShortlistVerificationState([{ relevant: true, parsed: false, candidatePresent: false }]);
    expect(result.state).toBe('deferred');
    expect(shouldPublishNotShortlisted({ verificationState: result.state, hasPositiveMatch: false })).toBe(false);
    expect(getVerifiedShortlistStatus({ verificationState: result.state, hasPositiveMatch: false, currentStatus: 'applied' })).toBeNull();
  });

  it('does not treat an applied-list-only archive as a shortlist absence', () => {
    const result = deriveShortlistVerificationState([]);
    expect(result.state).toBe('not_published');
    expect(shouldPublishNotShortlisted({ verificationState: result.state, hasPositiveMatch: false })).toBe(false);
  });

  it('keeps an otherwise absent ID deferred until the shared archive scan completes', () => {
    const scans = [{ relevant: true, parsed: true, candidatePresent: false }];
    expect(resolveDriveVerification({ scans, archiveComplete: false }).state).toBe('deferred');
    expect(resolveDriveVerification({ scans, archiveComplete: true }).state).toBe('verified_absent');
  });

  it('publishes Not Shortlisted only after the correct parsed roster excludes the NeoID', () => {
    const evaluated = evaluateCachedShortlistRosters({
      rosters: [{
        filename: 'Northstar test shortlist.xlsx',
        collegeEmailId: 'college-email-1',
        parseStatus: 'complete',
        extractedRows: [{ sheetName: 'Test Shortlist', rows: [['Neo ID'], ['X4W0P0K8']] }],
      }],
      shortlistContext: true,
      identityTokens: ['I4W0P0K8'],
    });
    const result = deriveShortlistVerificationState([
      { relevant: true, parsed: evaluated.state === 'verified_absent', candidatePresent: evaluated.state === 'verified_present' },
    ]);
    expect(result.state).toBe('verified_absent');
    expect(result.checkedRosterCount).toBe(1);
    expect(shouldPublishNotShortlisted({ verificationState: result.state, hasPositiveMatch: false })).toBe(true);
    expect(getVerifiedShortlistStatus({ verificationState: result.state, hasPositiveMatch: false, currentStatus: 'applied' })).toBe('not_shortlisted');
    expect(getVerifiedShortlistStatus({ verificationState: result.state, hasPositiveMatch: false, currentStatus: 'not_applied' })).toBeNull();
  });

  it('defers absence if another relevant roster for the drive failed parsing', () => {
    const result = deriveShortlistVerificationState([
      { relevant: true, parsed: true, candidatePresent: false },
      { relevant: true, parsed: false, candidatePresent: false },
    ]);
    expect(result.state).toBe('deferred');
    expect(getVerifiedShortlistStatus({ verificationState: result.state, hasPositiveMatch: false, currentStatus: 'applied' })).toBeNull();
  });

  it('records a parsed shortlist match as positive evidence with sheet and row detail', () => {
    const evaluated = evaluateCachedShortlistRosters({
      rosters: [{
        filename: 'Northstar test shortlist.xlsx',
        collegeEmailId: 'college-email-1',
        parseStatus: 'complete',
        extractedRows: [{ sheetName: 'Test Shortlist', rows: [['Neo ID'], [' I4W0P0K8 ']] }],
      }],
      shortlistContext: true,
      identityTokens: ['I4W0P0K8'],
    });
    expect(evaluated.state).toBe('verified_present');
    // The match carries the exact sheet + 1-indexed row so the drive UI can show it.
    expect(evaluated.matchingRoster?.details).toBe('Matched in Northstar test shortlist.xlsx (Test Shortlist!row 2)');
    const result = deriveShortlistVerificationState([
      { relevant: true, parsed: evaluated.state === 'verified_present', candidatePresent: evaluated.state === 'verified_present' },
    ]);
    expect(result.state).toBe('verified_present');
    expect(shouldPublishNotShortlisted({ verificationState: result.state, hasPositiveMatch: true })).toBe(false);
    expect(getVerifiedShortlistStatus({ verificationState: result.state, hasPositiveMatch: true, currentStatus: 'applied' })).toBe('shortlisted');
    expect(getVerifiedShortlistStatus({ verificationState: result.state, hasPositiveMatch: true, currentStatus: 'test_completed' })).toBeNull();
  });

  it('keeps the drive pending when a relevant shortlist scan is deferred', () => {
    const result = deriveShortlistVerificationState([
      { relevant: true, parsed: false, candidatePresent: false },
    ], true);
    expect(result.state).toBe('deferred');
    expect(shouldPublishNotShortlisted({ verificationState: result.state, hasPositiveMatch: false })).toBe(false);
    expect(getVerifiedShortlistStatus({ verificationState: result.state, hasPositiveMatch: false, currentStatus: 'applied' })).toBeNull();
  });

  it('defers a failed parse of a named shortlist workbook', () => {
    const result = evaluateCachedShortlistRosters({
      rosters: [{ filename: 'Northstar shortlist.xlsx', parseStatus: 'error', extractedRows: null }],
      shortlistContext: true,
      identityTokens: ['I4W0P0K8'],
    });
    expect(result.state).toBe('deferred');
    expect(getVerifiedShortlistStatus({ verificationState: result.state, hasPositiveMatch: false, currentStatus: 'applied' })).toBeNull();
  });

  it('does not mark the drive absent if even one sibling shortlist is unparsed', () => {
    const result = deriveShortlistVerificationState([
      { relevant: true, parsed: true, candidatePresent: false },
      { relevant: true, parsed: false, candidatePresent: false },
    ]);
    expect(result.state).toBe('deferred');
    expect(shouldPublishNotShortlisted({ verificationState: result.state, hasPositiveMatch: false })).toBe(false);
  });

  it('keeps a missing or ambiguous roster mapping from becoming a negative', () => {
    const result = deriveShortlistVerificationState([
      { relevant: true, parsed: false, candidatePresent: false },
    ], true);
    expect(getVerifiedShortlistStatus({ verificationState: result.state, hasPositiveMatch: false, currentStatus: 'applied' })).toBeNull();
  });

  it('does not classify an opt-in workbook as a shortlist even when NeoID is present', () => {
    const result = evaluateCachedShortlistRosters({
      rosters: [{
        filename: 'Northstar Opt-in List.xlsx',
        collegeEmailId: 'college-email-opt-in',
        parseStatus: 'complete',
        extractedRows: [{ sheetName: 'Applied', rows: [['Neo ID'], ['I4W0P0K8']] }],
      }],
      shortlistContext: true,
      identityTokens: ['I4W0P0K8'],
    });
    expect(result.state).toBe('not_published');
  });
});
