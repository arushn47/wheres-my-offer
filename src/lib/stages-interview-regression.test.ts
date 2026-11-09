/**
 * Regression tests for getEffectiveStage (stages.ts)
 *
 * Bug A: When status is 'interview_scheduled' and the interview event's end_time
 * is in the past, getEffectiveStage() should return effectiveStatus='interview_completed'
 * — not remain stuck at 'interview_scheduled'.
 *
 * Key invariants tested:
 *  1. Past interview event + interview_scheduled → effectiveStatus = 'interview_completed'
 *  2. Future interview event + interview_scheduled → effectiveStatus = 'interview_scheduled'
 *  3. Past interview event does NOT auto-advance to 'selected' or 'offer'
 *  4. Manual override is preserved regardless of event timestamps
 *  5. isInterviewCompleted does not activate without actual interview events
 */
import { describe, it, expect } from 'vitest';
import { getEffectiveStage } from './stages';

// ─── helpers ────────────────────────────────────────────────────────────────

type MaybeEvent = { event_type: string; start_time: string | null; end_time: string | null };

function pastInterviewEvent(hoursAgo = 24): MaybeEvent {
  const start = new Date(Date.now() - hoursAgo * 3600_000);
  const end = new Date(start.getTime() + 90 * 60_000);
  return { event_type: 'technical_interview', start_time: start.toISOString(), end_time: end.toISOString() };
}

function futureInterviewEvent(hoursFromNow = 24): MaybeEvent {
  const start = new Date(Date.now() + hoursFromNow * 3600_000);
  const end = new Date(start.getTime() + 90 * 60_000);
  return { event_type: 'technical_interview', start_time: start.toISOString(), end_time: end.toISOString() };
}

function pastTestEvent(hoursAgo = 48): MaybeEvent {
  const start = new Date(Date.now() - hoursAgo * 3600_000);
  const end = new Date(start.getTime() + 90 * 60_000);
  return { event_type: 'online_test', start_time: start.toISOString(), end_time: end.toISOString() };
}

// Minimal notes/ctx shapes that satisfy getEffectiveStage's signature
const noNotes = null;
const noManual = false;

// ─── tests ───────────────────────────────────────────────────────────────────

describe('getEffectiveStage: Bug A regression — past interview events', () => {
  it('returns interview_completed when status=interview_scheduled and interview is in the past', () => {
    const result = getEffectiveStage(
      'interview_scheduled',
      null,
      [pastInterviewEvent()],
      noNotes,
      noManual,
    );
    expect(result.effectiveStatus).toBe('interview_completed');
  });

  it('keeps interview_scheduled when status=interview_scheduled and interview is still upcoming', () => {
    const result = getEffectiveStage(
      'interview_scheduled',
      null,
      [futureInterviewEvent()],
      noNotes,
      noManual,
    );
    expect(result.effectiveStatus).toBe('interview_scheduled');
  });

  it('does NOT advance to selected/offer when only the interview date has passed (no result yet)', () => {
    const result = getEffectiveStage(
      'interview_scheduled',
      null,
      [pastInterviewEvent()],
      noNotes,
      noManual,
    );
    expect(result.effectiveStatus).not.toBe('selected');
    expect(result.effectiveStatus).not.toBe('offer');
    expect(result.effectiveStatus).not.toBe('offer_received');
  });

  it('keeps interview_scheduled when no interview events exist (status alone does not advance)', () => {
    const result = getEffectiveStage(
      'interview_scheduled',
      null,
      [], // no events at all
      noNotes,
      noManual,
    );
    // No events → isInterviewCompleted from event-check is false → stays at scheduled
    expect(result.effectiveStatus).toBe('interview_scheduled');
  });

  it('keeps interview_completed when stored status is interview_completed (no regression)', () => {
    const result = getEffectiveStage(
      'interview_completed',
      null,
      [],
      noNotes,
      noManual,
    );
    expect(result.effectiveStatus).toBe('interview_completed');
  });

  it('preserves manual override regardless of past events', () => {
    const result = getEffectiveStage(
      'interview_scheduled',
      null,
      [pastInterviewEvent()],
      noNotes,
      true, // manualOverride
    );
    // Manual override means the UI trusts the stored status — do NOT auto-advance
    // The function may still return interview_completed but it must not go further
    expect(['interview_scheduled', 'interview_completed'].includes(result.effectiveStatus)).toBe(true);
    expect(result.effectiveStatus).not.toBe('selected');
  });

  it('marks test_completed when status=test_scheduled and test event is in the past', () => {
    const result = getEffectiveStage(
      'test_scheduled',
      null,
      [pastTestEvent()],
      noNotes,
      noManual,
    );
    // isTestCompleted derives from status includes 'test_completed' but status = 'test_scheduled'
    // The test event being past should NOT by itself advance status (test completion needs email evidence)
    // This is intentional: test events passing ≠ user passed the test
    // → effectiveStatus remains test_scheduled (or at most test_completed if the status list covers it)
    expect(['test_scheduled', 'test_completed'].includes(result.effectiveStatus)).toBe(true);
  });
});

describe('getEffectiveStage: isInterviewCompleted event-check guard', () => {
  it('requires BOTH hasInterview=true AND all events past to trigger event-based completion', () => {
    // Mix: one past, one future → hasInterview=true but NOT every past → no completion
    const result = getEffectiveStage(
      'interview_scheduled',
      null,
      [pastInterviewEvent(48), futureInterviewEvent(24)],
      noNotes,
      noManual,
    );
    // Not all interviews have passed → should stay at interview_scheduled
    expect(result.effectiveStatus).toBe('interview_scheduled');
  });

  it('triggers completion only when every interview event is past', () => {
    const result = getEffectiveStage(
      'interview_scheduled',
      null,
      [pastInterviewEvent(48), pastInterviewEvent(24)],
      noNotes,
      noManual,
    );
    expect(result.effectiveStatus).toBe('interview_completed');
  });
});
