import { describe, expect, it } from 'vitest';
import { getVerifiedPipelineState } from './round-pipeline';

describe('verified recruitment pipeline', () => {
  it('keeps the cross on the first entry round when PPT follows Test', () => {
    const stages = [
      { id: 'applied', label: 'Applied', shortLabel: 'Applied' },
      { id: 'test_1', label: 'Test 1', shortLabel: 'Test 1' },
      { id: 'ppt', label: 'PPT', shortLabel: 'PPT' },
      { id: 'interview', label: 'Interview', shortLabel: 'Interview' },
      { id: 'offer', label: 'Selected / Offer', shortLabel: 'Offer' },
    ];
    const state = getVerifiedPipelineState({ stages, status: 'not_shortlisted', pptCompleted: false, decisions: [
      { roundKey: 'test:1', roundType: 'test', state: 'verified_absent', eligible: false, finalNegative: true, sourceReceivedAt: '2026-10-06T10:00:00Z', parserVersion: 4, isCurrent: true },
    ] });
    expect(state?.currentIndex).toBe(1);
    expect([...state!.verified]).toEqual([0]);
  });

  it('marks only the checked round absent and leaves future rounds unearned', () => {
    const stages = [
      { id: 'applied', label: 'Applied', shortLabel: 'Applied' },
      { id: 'test', label: 'Test', shortLabel: 'Test' },
      { id: 'interview', label: 'Interview', shortLabel: 'Interview' },
      { id: 'offer', label: 'Selected / Offer', shortLabel: 'Offer' },
    ];
    const state = getVerifiedPipelineState({ stages, status: 'not_shortlisted', decisions: [{ roundKey: 'test:1', roundType: 'test', state: 'verified_absent', eligible: false, finalNegative: false, sourceReceivedAt: '2026-10-06T10:00:00Z', parserVersion: 3, isCurrent: true }], pptCompleted: false });
    expect(state?.currentIndex).toBe(1);
    expect([...state!.verified]).toEqual([0]);
  });

  it('does not map elimination to offer stage if candidate never qualified for interview', () => {
    const stages = [
      { id: 'applied', label: 'Applied', shortLabel: 'Applied' },
      { id: 'test', label: 'Test', shortLabel: 'Test' },
      { id: 'interview', label: 'Interview', shortLabel: 'Interview' },
      { id: 'offer', label: 'Selected / Offer', shortLabel: 'Offer' },
    ];
    // Candidate passed test, absent from interview, selected circular arrives:
    const decisions = [
      { roundKey: 'test:1', roundType: 'test' as const, state: 'verified_present', eligible: true, finalNegative: false, sourceReceivedAt: '2026-09-01T10:00:00Z', parserVersion: 3 },
      { roundKey: 'interview:1', roundType: 'interview' as const, state: 'verified_absent', eligible: false, finalNegative: true, sourceReceivedAt: '2026-09-05T10:00:00Z', parserVersion: 3 },
      { roundKey: 'selected', roundType: 'selected' as const, state: 'verified_absent', eligible: false, finalNegative: true, sourceReceivedAt: '2026-09-10T10:00:00Z', parserVersion: 3, isCurrent: true },
    ];
    const state = getVerifiedPipelineState({ stages, status: 'rejected', decisions, pptCompleted: false });
    // The missing interview shortlist means elimination happened in the prior test.
    expect(state?.currentIndex).toBe(1);
    expect(state?.verified.has(0)).toBe(true); // applied verified
    expect(state?.verified.has(1)).toBe(false); // test is the elimination point
    expect(state?.verified.has(2)).toBe(false); // interview absent (eliminated)
    expect(state?.verified.has(3)).toBe(false); // offer unreached
  });

  it('maps to test stage when candidate was screened out before test even if selection circular exists', () => {
    const stages = [
      { id: 'applied', label: 'Applied', shortLabel: 'Applied' },
      { id: 'test', label: 'Test', shortLabel: 'Test' },
      { id: 'interview', label: 'Interview', shortLabel: 'Interview' },
      { id: 'offer', label: 'Selected / Offer', shortLabel: 'Offer' },
    ];
    const decisions = [
      { roundKey: 'test:1', roundType: 'test' as const, state: 'verified_absent', eligible: false, finalNegative: true, sourceReceivedAt: '2026-09-01T10:00:00Z', parserVersion: 3 },
      { roundKey: 'selected', roundType: 'selected' as const, state: 'verified_absent', eligible: false, finalNegative: true, sourceReceivedAt: '2026-09-10T10:00:00Z', parserVersion: 3, isCurrent: true },
    ];
    const state = getVerifiedPipelineState({ stages, status: 'not_shortlisted', decisions, pptCompleted: false });
    // Must map to test (index 1), NOT offer (index 3)
    expect(state?.currentIndex).toBe(1);
    expect([...state!.verified]).toEqual([0]);
  });

  it('marks the game round as the elimination point after a verified game shortlist', () => {
    const stages = [
      { id: 'applied', label: 'Applied', shortLabel: 'Applied' },
      { id: 'test_1', label: 'Test 1', shortLabel: 'Test 1' },
      { id: 'game', label: 'Game Round', shortLabel: 'Game' },
      { id: 'test_2', label: 'Test 2', shortLabel: 'Test 2' },
      { id: 'interview', label: 'Interview', shortLabel: 'Interview' },
      { id: 'offer', label: 'Selected / Offer', shortLabel: 'Offer' },
    ];
    const decisions = [
      { roundKey: 'test:1', roundType: 'test' as const, state: 'verified_present', eligible: true, finalNegative: false, sourceReceivedAt: '2026-10-01T08:54:29Z', parserVersion: 4 },
      { roundKey: 'game', roundType: 'game' as const, state: 'verified_present', eligible: true, finalNegative: false, sourceReceivedAt: '2026-10-05T06:08:01Z', parserVersion: 4 },
      { roundKey: 'test:2026-10-07', roundType: 'test' as const, state: 'verified_absent', eligible: false, finalNegative: true, sourceReceivedAt: '2026-10-06T10:07:26Z', parserVersion: 4, isCurrent: true },
    ];
    const state = getVerifiedPipelineState({ stages, status: 'rejected_test', decisions, pptCompleted: false });
    expect(state?.currentIndex).toBe(2);
    expect(state?.verified.has(1)).toBe(true);
    expect(state?.verified.has(2)).toBe(false);
    expect(state?.verified.has(3)).toBe(false);
  });
});
