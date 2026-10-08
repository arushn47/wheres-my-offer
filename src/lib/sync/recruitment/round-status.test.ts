import { describe, expect, it } from 'vitest';
import { getCurrentRoundDecision, resolveRecruitmentStatus, statusForRoundVerdict } from './round-status';
import { getRoundStatusDisplay } from './status-display';

const absent = { roundKey: 'test:2026-10-07', roundType: 'test' as const, state: 'verified_absent', eligible: false, finalNegative: false, sourceReceivedAt: '2026-10-06T10:00:00Z', parserVersion: 3, isCurrent: true };

describe('round status presentation', () => {
  it('does not reset a checked partial-list absence to applied', () => {
    expect(statusForRoundVerdict(absent, 'test_scheduled')).toBe('not_shortlisted');
  });
  it('does not label checked absence as verification pending', () => {
    expect(getRoundStatusDisplay('applied', [absent])).toMatchObject({ status: 'not_shortlisted' });
  });
  it('selects the newest current decision deterministically', () => {
    expect(getCurrentRoundDecision([{ ...absent, parserVersion: 2 }, { ...absent, parserVersion: 3, roundKey: 'interview:2026-10-08' }])?.roundKey).toBe('interview:2026-10-08');
  });

  it('correctly maps elimination labels based on candidate round history', () => {
    // An interview list alone does not prove earlier test participation.
    const interviewAbsent = { roundKey: 'interview:1', roundType: 'interview' as const, state: 'verified_absent', eligible: false, finalNegative: true, sourceReceivedAt: '2026-10-07T10:00:00Z', parserVersion: 3 };
    expect(resolveRecruitmentStatus('applied', [interviewAbsent])).toBe('not_shortlisted');

    // not shortlisted for test -> not shortlisted
    const testAbsent = { roundKey: 'test:1', roundType: 'test' as const, state: 'verified_absent', eligible: false, finalNegative: true, sourceReceivedAt: '2026-10-07T10:00:00Z', parserVersion: 3 };
    expect(resolveRecruitmentStatus('applied', [testAbsent])).toBe('not_shortlisted');

    // not shortlisted for ppt -> not shortlisted
    const pptAbsent = { roundKey: 'ppt', roundType: 'ppt' as const, state: 'verified_absent', eligible: false, finalNegative: true, sourceReceivedAt: '2026-10-07T10:00:00Z', parserVersion: 3 };
    expect(resolveRecruitmentStatus('applied', [pptAbsent])).toBe('not_shortlisted');

    // Old rejection notes do not prove test participation.
    const selectedAbsent = { roundKey: 'selected', roundType: 'selected' as const, state: 'verified_absent', eligible: false, finalNegative: true, sourceReceivedAt: '2026-10-08T10:00:00Z', parserVersion: 3 };
    expect(resolveRecruitmentStatus('rejected', [selectedAbsent], false, 'Eliminated in Test Round')).toBe('not_shortlisted');

    // selected absent when candidate was screened out -> Not Shortlisted
    expect(resolveRecruitmentStatus('not_shortlisted', [selectedAbsent])).toBe('not_shortlisted');

    // An old rejection code does not prove interview participation.
    expect(resolveRecruitmentStatus('rejected_interview', [selectedAbsent])).toBe('not_shortlisted');
  });

  it('resolves the true terminal round decision instead of broadcast selection circulars', () => {
    const testPresent = { roundKey: 'test:1', roundType: 'test' as const, state: 'verified_present', eligible: true, finalNegative: false, sourceReceivedAt: '2026-09-01T10:00:00Z', parserVersion: 3 };
    const interviewAbsent = { roundKey: 'interview:1', roundType: 'interview' as const, state: 'verified_absent', eligible: false, finalNegative: true, sourceReceivedAt: '2026-09-05T10:00:00Z', parserVersion: 3 };
    const selectedAbsent = { roundKey: 'selected', roundType: 'selected' as const, state: 'verified_absent', eligible: false, finalNegative: true, sourceReceivedAt: '2026-09-10T10:00:00Z', parserVersion: 3 };

    // Candidate passed test, absent from interview, subsequent selection circular arrives:
    // Terminal decision must be the interview elimination, NOT the selection circular!
    const terminal1 = getCurrentRoundDecision([testPresent, interviewAbsent, selectedAbsent]);
    expect(terminal1?.roundKey).toBe('interview:1');

    // Candidate was absent from test (screened out):
    // Terminal decision must be the test elimination!
    const testAbsent = { roundKey: 'test:1', roundType: 'test' as const, state: 'verified_absent', eligible: false, finalNegative: true, sourceReceivedAt: '2026-09-01T10:00:00Z', parserVersion: 3 };
    const terminal2 = getCurrentRoundDecision([testAbsent, interviewAbsent, selectedAbsent]);
    expect(terminal2?.roundKey).toBe('test:1');

    // Candidate passed interview:
    // Terminal decision is the selection circular!
    const interviewPresent = { roundKey: 'interview:1', roundType: 'interview' as const, state: 'verified_present', eligible: true, finalNegative: false, sourceReceivedAt: '2026-09-05T10:00:00Z', parserVersion: 3 };
    const terminal3 = getCurrentRoundDecision([testPresent, interviewPresent, selectedAbsent]);
    expect(terminal3?.roundKey).toBe('selected');
  });
});
