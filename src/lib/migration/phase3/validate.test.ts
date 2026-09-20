import { describe, expect, it } from 'vitest';
import { canProceedToExecution, classifyCandidateMatchEmailConsistency, evaluatePreflight } from './validate';
import type { PreflightCheckRow } from './rpc-client';

function row(checkName: string, status: PreflightCheckRow['status']): PreflightCheckRow {
  return { checkName, status, details: 'details' };
}

describe('evaluatePreflight', () => {
  it('is READY when every check passes', () => {
    const result = evaluatePreflight([row('a', 'PASS'), row('b', 'PASS')]);
    expect(result.status).toBe('READY');
    expect(result.blocked).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('is REVIEW_REQUIRED when there are only warnings', () => {
    const result = evaluatePreflight([row('a', 'PASS'), row('b', 'WARN')]);
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.warnings).toHaveLength(1);
  });

  it('is BLOCKED when any check is BLOCKED, even alongside warnings/passes', () => {
    const result = evaluatePreflight([row('a', 'PASS'), row('b', 'WARN'), row('c', 'BLOCKED')]);
    expect(result.status).toBe('BLOCKED');
    expect(result.blocked).toHaveLength(1);
  });

  it('treats an empty check list as READY', () => {
    expect(evaluatePreflight([]).status).toBe('READY');
  });
});

describe('canProceedToExecution', () => {
  it('is false only when BLOCKED', () => {
    expect(canProceedToExecution(evaluatePreflight([row('a', 'BLOCKED')]))).toBe(false);
    expect(canProceedToExecution(evaluatePreflight([row('a', 'WARN')]))).toBe(true);
    expect(canProceedToExecution(evaluatePreflight([row('a', 'PASS')]))).toBe(true);
  });
});

describe('candidate match/source email consistency', () => {
  it('treats a valid candidate drive with a null source email drive as historical evidence', () => {
    expect(classifyCandidateMatchEmailConsistency({
      candidateDriveId: 'drive-a',
      emailDriveId: null,
      candidateUserIdMatches: true,
      candidateCompanyMatches: true,
    })).toBe('warn_legacy_source_email');
  });

  it('blocks a non-null candidate/source email drive mismatch', () => {
    expect(classifyCandidateMatchEmailConsistency({
      candidateDriveId: 'drive-a',
      emailDriveId: 'drive-b',
      candidateUserIdMatches: true,
      candidateCompanyMatches: true,
    })).toBe('blocked_drive_mismatch');
  });

  it('blocks invalid tenant/company ownership', () => {
    expect(classifyCandidateMatchEmailConsistency({
      candidateDriveId: 'drive-a',
      emailDriveId: null,
      candidateUserIdMatches: false,
      candidateCompanyMatches: false,
    })).toBe('blocked_invalid_source_scope');
  });
});
