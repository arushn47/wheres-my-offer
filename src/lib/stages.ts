import { deriveEventEndTime } from '@/lib/event-duration';
import { parseEliminationToken, parseAnnouncedProcessToken, deriveStageId, deriveStageLabelFromId } from '@/lib/sync/round-identity';

export interface StageDefinition {
  id: string;
  label: string;
  shortLabel: string;
}

export const STAGES: StageDefinition[] = [
  { id: 'applied', label: 'Applied', shortLabel: 'Applied' },
  { id: 'ppt', label: 'PPT Scheduled', shortLabel: 'PPT' },
  { id: 'test', label: 'Shortlisted for Test', shortLabel: 'Test' },
  { id: 'interview', label: 'Shortlisted for Interview', shortLabel: 'Interview' },
  { id: 'offer', label: 'Selected / Offer', shortLabel: 'Offer' },
];

export const STAGE_ACTIVE_STYLES: Record<
  number,
  {
    circle: string;
    ripple: string;
    text: string;
  }
> = {
  0: { // Applied
    circle: 'border-emerald-400 bg-emerald-500/20 text-emerald-100 ring-2 ring-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.35)]',
    ripple: 'bg-emerald-400/30',
    text: 'text-emerald-300 font-semibold',
  },
  1: { // PPT
    circle: 'border-emerald-400 bg-emerald-500/20 text-emerald-100 ring-2 ring-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.35)]',
    ripple: 'bg-emerald-400/30',
    text: 'text-emerald-300 font-semibold',
  },
  2: { // Test
    circle: 'border-emerald-400 bg-emerald-500/20 text-emerald-100 ring-2 ring-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.35)]',
    ripple: 'bg-emerald-400/30',
    text: 'text-emerald-300 font-semibold',
  },
  3: { // Interview
    circle: 'border-emerald-400 bg-emerald-500/20 text-emerald-100 ring-2 ring-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.35)]',
    ripple: 'bg-emerald-400/30',
    text: 'text-emerald-300 font-semibold',
  },
  4: { // Offer
    circle: 'border-emerald-400 bg-emerald-500/25 text-emerald-100 ring-2 ring-emerald-500/50 shadow-[0_0_16px_rgba(16,185,129,0.5)]',
    ripple: 'bg-emerald-400/40',
    text: 'text-emerald-300 font-semibold',
  },
};

export function getStageIndex(status: string): number {
  const s = (status || '').toLowerCase();
  if (['selected', 'offer', 'offer_received'].includes(s)) return 4;
  if (['interview_scheduled', 'interview', 'interview_completed', 'interview_ongoing'].includes(s)) return 3;
  if (['test_scheduled', 'shortlisted', 'test_completed', 'test_ongoing'].includes(s)) return 2;
  if (['ppt_scheduled', 'ppt', 'ppt_completed', 'ppt_ongoing'].includes(s)) return 1;
  return 0;
}

export interface EventLike {
  event_type?: string;
  eventType?: string;
  title?: string | null;
  start_time?: string | Date | null;
  startTime?: string | Date | null;
  end_time?: string | Date | null;
  endTime?: string | Date | null;
  /** Round number within this event type for this drive (1-based). Populated after migration. */
  round_number?: number | null;
}

export interface EffectiveStageResult {
  stageIndex: number;
  effectiveStatus: string;
  eliminatedStage: number; // -1 if not eliminated, 0 = screening, 1 = PPT, 2 = test, 3 = interview
  furthestPassedStage: number; // index of furthest passed stage (-1 if screened out at start)
  statusSubtitle: string;
  hasPpt: boolean;
  hasTest: boolean;
  hasInterview: boolean;
  isTestCompleted: boolean;
  isPptCompleted: boolean;
  isInterviewCompleted: boolean;
  isTestOngoing?: boolean;
  isPptOngoing?: boolean;
  isInterviewOngoing?: boolean;
  /** Canonical stage ID where elimination occurred, e.g. 'group_discussion_r1'. null if not eliminated or round unknown. */
  eliminatedStageId?: string | null;
  /** Human-readable label for the elimination round, e.g. 'Eliminated in Group Discussion'. null if not eliminated or unknown. */
  eliminationLabel?: string | null;
}

/**
 * Derives the exact recruitment stage and elimination point by taking into account
 * application status and the company's real event timeline (PPT, Test, Interview),
 * including smart past-event awareness (Test Completed, PPT Completed).
 */
export function getEffectiveStage(
  status: string,
  latestEvent?: EventLike | null,
  events?: EventLike[] | null,
  notes?: string | null,
  manualOverride?: boolean
): EffectiveStageResult {
  // Parse elimination context from notes (structured token or legacy freeform)
  const eliminationCtx = parseEliminationToken(notes);
  const s = (status || '').toLowerCase();

  const allEvents: EventLike[] = [
    ...(latestEvent ? [latestEvent] : []),
    ...(events || []),
  ];

  const getEvtType = (e: EventLike) =>
    `${e.event_type || e.eventType || ''} ${e.title || ''}`.toLowerCase();

  const now = new Date();
  const getEventTime = (e: EventLike) => {
    const t = e.start_time || e.startTime;
    return t ? new Date(t).getTime() : null;
  };

  // Canonical fallback durations live in one place so the database, sync
  // engine, reprocess engine and UI derive the same end time:
  // PPT = 1.5h, tests/assessments = 2h, interviews = 1.5h.
  const getEventEndTime = (e: EventLike) => {
    const endT = e.end_time || e.endTime;
    if (endT) {
      const t = new Date(endT).getTime();
      if (!isNaN(t)) return t;
    }
    const startT = getEventTime(e);
    if (startT === null) return null;
    const derived = deriveEventEndTime(getEvtType(e), getEvtType(e), new Date(startT));
    return derived ? derived.getTime() : null;
  };

  const isEventOngoing = (e: EventLike) => {
    const startT = getEventTime(e);
    const endT = getEventEndTime(e);
    if (startT === null || endT === null) return false;
    const nowMs = now.getTime();
    return nowMs >= startT && nowMs < endT;
  };

  const isEventPast = (e: EventLike) => {
    const endT = getEventEndTime(e);
    if (endT !== null) {
      return now.getTime() >= endT;
    }
    const startT = getEventTime(e);
    return startT !== null && startT < now.getTime();
  };

  const pptEvents = allEvents.filter((e) => /ppt|pre[\s-]*placement/i.test(getEvtType(e)));
  const testEvents = allEvents.filter((e) =>
    /online_test|coding_test|assessment|test_scheduled|coding|hackerearth|mettl|shl/i.test(getEvtType(e))
  );
  const intEvents = allEvents.filter((e) => /interview/i.test(getEvtType(e)));

  const hasPpt = pptEvents.length > 0;
  const hasTest = testEvents.length > 0;
  const hasInterview = intEvents.length > 0;

  // Ongoing event awareness: true if the event window is happening right now
  const isPptOngoing = hasPpt && pptEvents.some(isEventOngoing);
  const isTestOngoing = hasTest && testEvents.some(isEventOngoing);
  const isInterviewOngoing = hasInterview && intEvents.some(isEventOngoing);

  // Past event awareness: true only if scheduled events have completely elapsed
  const isPptCompleted = hasPpt && pptEvents.every(isEventPast);
  const isTestCompleted = hasTest && testEvents.every(isEventPast);
  const isInterviewCompleted = hasInterview && intEvents.every(isEventPast);

  const notesText = notes || '';
  const isNotesInterview =
    eliminationCtx.roundType === 'interview' || eliminationCtx.roundType === 'interview_r2' ||
    /eliminated.*interview|interview.*eliminated|interviewed.*not\s*selected|rejected.*interview/i.test(notesText);
  const isNotesTest =
    eliminationCtx.roundType === 'test' || eliminationCtx.roundType === 'test_r2' ||
    /eliminated.*test|test.*eliminated|rejected.*test|test.*rejected/i.test(notesText);

  // Check announced recruitment process tokens from notes
  const announcedRounds = parseAnnouncedProcessToken(notes);
  const hasAnnouncedPpt = Boolean(announcedRounds?.some((r) => r.roundType === 'ppt'));

  const isExplicitPostPpt =
    s === 'not_shortlisted_post_ppt' ||
    eliminationCtx.roundType === 'post_ppt' ||
    /not\s*shortlisted\s*\(post\s*ppt\)|not\s*shortlisted\s*post[\s-]*ppt|not\s*shortlisted\s*after\s*ppt|post[\s-]*ppt|after\s*ppt/i.test(notesText);

  const hasFuturePpt = pptEvents.some((e) => !isEventPast(e));

  const effectiveHasPpt = hasPpt || hasAnnouncedPpt || isExplicitPostPpt;
  const effectiveIsPptCompleted =
    !hasFuturePpt &&
    (isPptCompleted ||
      isExplicitPostPpt ||
      (hasAnnouncedPpt &&
        ['not_shortlisted', 'not_shortlisted_post_ppt', 'rejected', 'test_scheduled', 'test_completed', 'interview_scheduled', 'interview_completed', 'selected', 'offer', 'offer_received'].includes(s)));

  const notShortlistedSubtitle = effectiveIsPptCompleted
    ? 'Not Shortlisted · Post-PPT'
    : 'Not Shortlisted · In Screening';

  // Derive eliminatedStageId from events when elimination label provides a round type.
  // This maps the round type to the actual event in the drive (if present).
  const computeEliminatedStageId = (): string | null => {
    if (!eliminationCtx.roundType) return null;
    const ROUND_TYPE_TO_EVENT_TYPE: Partial<Record<string, string>> = {
      test:         'online_test',
      test_r2:      'online_test',
      gd:           'group_discussion',
      ppt:          'ppt',
      post_ppt:     'online_test',
      interview:    'technical_interview',
      interview_r2: 'technical_interview',
    };
    const targetEventType = ROUND_TYPE_TO_EVENT_TYPE[eliminationCtx.roundType];
    if (!targetEventType) return null;
    // For r2 variants, look for round_number=2 events; otherwise round_number=1.
    const targetRoundNumber = eliminationCtx.roundType.endsWith('_r2') ? 2 : 1;
    // Find the matching event to get its round_number (prefer explicit match).
    const matchingEvent = allEvents.find((e) => {
      const et = (e.event_type || e.eventType || '').toLowerCase();
      if (et !== targetEventType) return false;
      if (e.round_number != null) return e.round_number === targetRoundNumber;
      return true; // fallback: accept first matching type
    });
    if (!matchingEvent) return deriveStageId(targetEventType, targetRoundNumber);
    return deriveStageId(targetEventType, matchingEvent.round_number ?? targetRoundNumber);
  };

  // ─── MANUAL OVERRIDE FAST PATH ──────────────────────────────────────────
  // If the application status was manually set by the user, honor it strictly!
  // Do NOT let company-wide broadcast events hijack a manually specified status.
  if (manualOverride) {
    if (s === 'not_shortlisted' || s === 'not_shortlisted_post_ppt') {
      return {
        stageIndex: 2,
        effectiveStatus: 'not_shortlisted',
        eliminatedStage: 2,
        furthestPassedStage: effectiveIsPptCompleted ? 1 : 0,
        statusSubtitle: notShortlistedSubtitle,
        hasPpt: effectiveHasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted: effectiveIsPptCompleted,
        isInterviewCompleted,
        eliminatedStageId: null,
        eliminationLabel: null,
      };
    }

    if (s === 'rejected_interview' || (s === 'rejected' && isNotesInterview)) {
      return {
        stageIndex: 4,
        effectiveStatus: 'rejected_interview',
        eliminatedStage: 4,
        furthestPassedStage: 3,
        statusSubtitle: 'Interviewed · Not Selected',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }

    if (s === 'rejected_test' || s === 'test_eliminated' || (s === 'rejected' && isNotesTest)) {
      return {
        stageIndex: 3,
        effectiveStatus: 'rejected_test',
        eliminatedStage: 3,
        furthestPassedStage: 2,
        statusSubtitle: 'Eliminated in Test Round',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }

    if (s === 'rejected') {
      return {
        stageIndex: 2,
        effectiveStatus: 'not_shortlisted',
        eliminatedStage: 2,
        furthestPassedStage: isPptCompleted ? 1 : 0,
        statusSubtitle: notShortlistedSubtitle,
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }

    if (s === 'withdrawn' || s === 'declined') {
      return {
        stageIndex: 0,
        effectiveStatus: s,
        eliminatedStage: -1,
        furthestPassedStage: hasInterview ? 2 : hasTest ? 1 : 0,
        statusSubtitle: 'Withdrawn by Candidate',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }

    if (s === 'not_applied' || s === 'unknown' || s === 'registration_open') {
      // Check if there is an upcoming registration deadline event
      const regDeadlineEvt = allEvents.find((e) => {
        const typeStr = getEvtType(e);
        return typeStr.includes('registration_deadline') || typeStr.includes('deadline');
      });
      const regTime = regDeadlineEvt ? getEventTime(regDeadlineEvt) : null;
      const isRegOpen = regTime !== null && regTime > now.getTime();

      if (isRegOpen && regTime !== null) {
        const diffMs = regTime - now.getTime();
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffMins = Math.round((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        const countdownStr =
          diffHours >= 24
            ? `${Math.round(diffMs / (1000 * 60 * 60 * 24))}d`
            : diffHours > 0
            ? `${diffHours}h ${diffMins}m`
            : `${diffMins}m`;

        return {
          stageIndex: 0,
          effectiveStatus: 'registration_open',
          eliminatedStage: -1,
          furthestPassedStage: -1,
          statusSubtitle: `Closes in ${countdownStr}`,
          hasPpt,
          hasTest,
          hasInterview,
          isTestCompleted,
          isPptCompleted,
          isInterviewCompleted,
        eliminatedStageId: null,
        eliminationLabel: null,
        };
      }

      if (s === 'registration_open') {
        return {
          stageIndex: 0,
          effectiveStatus: 'registration_open',
          eliminatedStage: -1,
          furthestPassedStage: -1,
          statusSubtitle: 'Registration Open',
          hasPpt,
          hasTest,
          hasInterview,
          isTestCompleted,
          isPptCompleted,
          isInterviewCompleted,
          eliminatedStageId: null,
          eliminationLabel: null,
        };
      }

      return {
        stageIndex: 0,
        effectiveStatus: 'not_applied',
        eliminatedStage: -1,
        furthestPassedStage: -1,
        statusSubtitle: 'Not Registered',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }

    if (['selected', 'offer', 'offer_received'].includes(s)) {
      return {
        stageIndex: 4,
        effectiveStatus: 'selected',
        eliminatedStage: -1,
        furthestPassedStage: 4,
        statusSubtitle: 'Selected · Offer Received 🎉',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }

    if (s === 'interview_completed') {
      return {
        stageIndex: 3,
        effectiveStatus: 'interview_completed',
        eliminatedStage: -1,
        furthestPassedStage: 3,
        statusSubtitle: 'Interview Completed · Results Awaited',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted: true,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }

    if (['interview_scheduled', 'interview', 'interview_ongoing'].includes(s)) {
      return {
        stageIndex: 3,
        effectiveStatus: isInterviewOngoing ? 'interview_ongoing' : 'interview_scheduled',
        eliminatedStage: -1,
        furthestPassedStage: 2,
        statusSubtitle: isInterviewOngoing ? 'Interview in Progress · Live Now' : 'Shortlisted for Interview',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
        isInterviewOngoing,
      };
    }

    if (s === 'test_completed') {
      return {
        stageIndex: 2,
        effectiveStatus: 'test_completed',
        eliminatedStage: -1,
        furthestPassedStage: 2,
        statusSubtitle: 'Test Completed · Awaiting Results',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted: true,
        isPptCompleted,
        isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }

    if (['test_scheduled', 'shortlisted', 'test_ongoing', 'test'].includes(s)) {
      const isShortlistOnly = s === 'shortlisted';
      return {
        stageIndex: 2,
        effectiveStatus: isTestOngoing ? 'test_ongoing' : isShortlistOnly ? 'shortlisted' : 'test_scheduled',
        eliminatedStage: -1,
        furthestPassedStage: hasPpt ? 1 : 0,
        statusSubtitle: isTestOngoing ? 'Assessment in Progress · Live Now' : 'Shortlisted for Test',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
        isTestOngoing,
      };
    }

    if (s === 'ppt_completed') {
      return {
        stageIndex: 1,
        effectiveStatus: 'ppt_completed',
        eliminatedStage: -1,
        furthestPassedStage: 1,
        statusSubtitle: 'PPT Completed · Test Shortlist Awaited',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted: true,
        isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }

    if (['ppt_scheduled', 'ppt', 'ppt_ongoing'].includes(s)) {
      return {
        stageIndex: 1,
        effectiveStatus: isPptOngoing ? 'ppt_ongoing' : 'ppt_scheduled',
        eliminatedStage: -1,
        furthestPassedStage: 0,
        statusSubtitle: isPptOngoing ? 'Pre-Placement Talk Live Now' : 'Pre-Placement Talk Scheduled',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
        isPptOngoing,
      };
    }

    // Default manual applied — but check if PPT/Test events reveal a further stage
    // (handles the case where status is 'applied' but a PPT event exists)
    if (isPptCompleted) {
      return {
        stageIndex: 1,
        effectiveStatus: 'ppt_completed',
        eliminatedStage: -1,
        furthestPassedStage: 1,
        statusSubtitle: 'PPT Completed · Test Shortlist Awaited',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted: true,
        isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }
    if (isPptOngoing) {
      return {
        stageIndex: 1,
        effectiveStatus: 'ppt_ongoing',
        eliminatedStage: -1,
        furthestPassedStage: 0,
        statusSubtitle: 'Pre-Placement Talk Live Now',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted: false,
        isInterviewCompleted,
        isPptOngoing: true,
      };
    }
    if (hasPpt) {
      return {
        stageIndex: 1,
        effectiveStatus: 'ppt_scheduled',
        eliminatedStage: -1,
        furthestPassedStage: 0,
        statusSubtitle: 'Stage 2 of 5 · PPT Scheduled',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }
    return {
      stageIndex: 0,
      effectiveStatus: 'applied',
      eliminatedStage: -1,
      furthestPassedStage: 0,
      statusSubtitle: 'Stage 1 of 5 · Applied',
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted,
      isInterviewCompleted,
    };
  }

  // ─── AUTOMATED INFERRED STAGE PATH ────────────────────────────────────────

  // 1. Not Shortlisted: candidate applied but was screened out before test round (Pre-Test Screening)
  if (s === 'not_shortlisted' || s === 'not_shortlisted_post_ppt') {
    return {
      stageIndex: 2,
      effectiveStatus: 'not_shortlisted',
      eliminatedStage: 2,
      furthestPassedStage: effectiveIsPptCompleted ? 1 : 0,
      statusSubtitle: notShortlistedSubtitle,
      hasPpt: effectiveHasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted: effectiveIsPptCompleted,
      isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
    };
  }

  // 2. Eliminated in Interview Round (Interviewed · Not Selected)
  if (s === 'rejected_interview' || (s === 'rejected' && isNotesInterview)) {
    const elStageId = computeEliminatedStageId();
    const elLabel = eliminationCtx.label || 'Interviewed · Not Selected';
    return {
      stageIndex: 4,
      effectiveStatus: 'rejected_interview',
      eliminatedStage: 4,
      furthestPassedStage: 3,
      statusSubtitle: elLabel,
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted,
      isInterviewCompleted,
      eliminatedStageId: elStageId,
      eliminationLabel: elLabel,
    };
  }

  // 3. Eliminated in Test Round (Post-Test)
  if (
    s === 'rejected_test' ||
    s === 'test_eliminated' ||
    (s === 'rejected' && isNotesTest)
  ) {
    const elStageId = computeEliminatedStageId();
    const elLabel = eliminationCtx.label || 'Eliminated in Test Round';
    return {
      stageIndex: 3,
      effectiveStatus: 'rejected_test',
      eliminatedStage: 3,
      furthestPassedStage: 2,
      statusSubtitle: elLabel,
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted,
      isInterviewCompleted,
      eliminatedStageId: elStageId,
      eliminationLabel: elLabel,
    };
  }

  // 4. Generic Rejected fallback (no notes, no events → screened out before test)
  if (s === 'rejected') {
    // GD elimination — has its own stageIndex between test and interview
    if (eliminationCtx.roundType === 'gd') {
      const elStageId = computeEliminatedStageId();
      const elLabel = eliminationCtx.label || 'Eliminated in Group Discussion';
      return {
        stageIndex: 3,
        effectiveStatus: 'rejected_test',
        eliminatedStage: 3,
        furthestPassedStage: 2,
        statusSubtitle: elLabel,
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
        eliminatedStageId: elStageId,
        eliminationLabel: elLabel,
      };
    }
    if (hasInterview && isInterviewCompleted) {
      const elStageId = computeEliminatedStageId();
      const elLabel = eliminationCtx.label || 'Interviewed · Not Selected';
      return {
        stageIndex: 4,
        effectiveStatus: 'rejected_interview',
        eliminatedStage: 4,
        furthestPassedStage: 3,
        statusSubtitle: elLabel,
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
        eliminatedStageId: elStageId,
        eliminationLabel: elLabel,
      };
    }
    if (hasTest && isTestCompleted) {
      const elStageId = computeEliminatedStageId();
      const elLabel = eliminationCtx.label || 'Eliminated in Test Round';
      return {
        stageIndex: 3,
        effectiveStatus: 'rejected_test',
        eliminatedStage: 3,
        furthestPassedStage: 2,
        statusSubtitle: elLabel,
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
        eliminatedStageId: elStageId,
        eliminationLabel: elLabel,
      };
    }
    return {
      stageIndex: 2,
      effectiveStatus: 'not_shortlisted',
      eliminatedStage: 2,
      furthestPassedStage: effectiveIsPptCompleted ? 1 : 0,
      statusSubtitle: notShortlistedSubtitle,
      hasPpt: effectiveHasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted: effectiveIsPptCompleted,
      isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
    };
  }

  // 5. Withdrawn / Declined
  if (s === 'withdrawn' || s === 'declined') {
    const passed = hasInterview ? 2 : hasTest ? 1 : 0;
    return {
      stageIndex: 0,
      effectiveStatus: s,
      eliminatedStage: -1,
      furthestPassedStage: passed,
      statusSubtitle: 'Withdrawn by Candidate',
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted,
      isInterviewCompleted,
    };
  }

  // 6. Not applied / registration open
  if (s === 'not_applied' || s === 'unknown' || s === 'registration_open') {
    // Check if there is an upcoming registration deadline event
    const regDeadlineEvt = allEvents.find((e) => {
      const typeStr = getEvtType(e);
      return typeStr.includes('registration_deadline') || typeStr.includes('deadline');
    });
    const regTime = regDeadlineEvt ? getEventTime(regDeadlineEvt) : null;
    const isRegOpen = regTime !== null && regTime > now.getTime();

    if (isRegOpen && regTime !== null) {
      const diffMs = regTime - now.getTime();
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffMins = Math.round((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      const countdownStr =
        diffHours >= 24
          ? `${Math.round(diffMs / (1000 * 60 * 60 * 24))}d`
          : diffHours > 0
          ? `${diffHours}h ${diffMins}m`
          : `${diffMins}m`;

      return {
        stageIndex: 0,
        effectiveStatus: 'registration_open',
        eliminatedStage: -1,
        furthestPassedStage: -1,
        statusSubtitle: `Closes in ${countdownStr}`,
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }

    if (s === 'registration_open') {
      return {
        stageIndex: 0,
        effectiveStatus: 'registration_open',
        eliminatedStage: -1,
        furthestPassedStage: -1,
        statusSubtitle: 'Registration Open',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
        eliminatedStageId: null,
        eliminationLabel: null,
      };
    }

    return {
      stageIndex: 0,
      effectiveStatus: 'not_applied',
      eliminatedStage: -1,
      furthestPassedStage: -1,
      statusSubtitle: 'Not Registered',
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted,
      isInterviewCompleted,
    };
  }

  // 7. Selected / Offer
  if (['selected', 'offer', 'offer_received'].includes(s)) {
    return {
      stageIndex: 4,
      effectiveStatus: 'selected',
      eliminatedStage: -1,
      furthestPassedStage: 4,
      statusSubtitle: 'Selected · Offer Received 🎉',
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted,
      isInterviewCompleted,
    };
  }

  // 8. Interview scheduled / Interview ongoing / Interview completed
  if (['interview_scheduled', 'interview', 'interview_completed', 'interview_ongoing'].includes(s)) {
    if (isInterviewOngoing) {
      return {
        stageIndex: 3,
        effectiveStatus: 'interview_ongoing',
        eliminatedStage: -1,
        furthestPassedStage: 2,
        statusSubtitle: 'Interview in Progress · Live Now',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted: false,
        isInterviewOngoing: true,
      };
    }

    if (isInterviewCompleted || s === 'interview_completed') {
      return {
        stageIndex: 3,
        effectiveStatus: 'interview_completed',
        eliminatedStage: -1,
        furthestPassedStage: 3,
        statusSubtitle: 'Interview Completed · Results Awaited',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted: true,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }

    return {
      stageIndex: 3,
      effectiveStatus: 'interview_scheduled',
      eliminatedStage: -1,
      furthestPassedStage: 2,
      statusSubtitle: 'Shortlisted for Interview',
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted,
      isInterviewCompleted,
    };
  }

  // 9. Test scheduled / Shortlisted for test / Test ongoing / Test completed
  if (['test_scheduled', 'shortlisted', 'test_completed', 'test_ongoing', 'test'].includes(s)) {
    if (isTestOngoing) {
      return {
        stageIndex: 2,
        effectiveStatus: 'test_ongoing',
        eliminatedStage: -1,
        furthestPassedStage: hasPpt ? 1 : 0,
        statusSubtitle: 'Assessment in Progress · Live Now',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted: false,
        isPptCompleted,
        isInterviewCompleted,
        isTestOngoing: true,
      };
    }

    if (isTestCompleted || s === 'test_completed') {
      return {
        stageIndex: 2,
        effectiveStatus: 'test_completed',
        eliminatedStage: -1,
        furthestPassedStage: 2, // Test was completed! Circle 2 is marked with green tick ✓
        statusSubtitle: 'Test Completed · Awaiting Results',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted: true,
        isPptCompleted,
        isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }

    return {
      stageIndex: 2,
      effectiveStatus: s === 'shortlisted' ? 'shortlisted' : 'test_scheduled',
      eliminatedStage: -1,
      furthestPassedStage: hasPpt ? 1 : 0,
      statusSubtitle: 'Shortlisted for Test',
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted,
      isInterviewCompleted,
    };
  }

  // 10. PPT scheduled / PPT ongoing / PPT completed
  if (['ppt_scheduled', 'ppt', 'ppt_completed', 'ppt_ongoing'].includes(s)) {
    if (isPptOngoing) {
      return {
        stageIndex: 1,
        effectiveStatus: 'ppt_ongoing',
        eliminatedStage: -1,
        furthestPassedStage: 0,
        statusSubtitle: 'Pre-Placement Talk Live Now',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted: false,
        isInterviewCompleted,
        isPptOngoing: true,
      };
    }

    if (isPptCompleted || s === 'ppt_completed') {
      return {
        stageIndex: 1,
        effectiveStatus: 'ppt_completed',
        eliminatedStage: -1,
        furthestPassedStage: 1, // PPT was completed! Circle 1 is marked with green tick ✓
        statusSubtitle: 'PPT Completed · Test Shortlist Awaited',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted: true,
        isInterviewCompleted,
      eliminatedStageId: null,
      eliminationLabel: null,
      };
    }

    return {
      stageIndex: 1,
      effectiveStatus: 'ppt_scheduled',
      eliminatedStage: -1,
      furthestPassedStage: 0,
      statusSubtitle: 'Stage 2 of 5 · PPT Scheduled',
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted,
      isInterviewCompleted,
    };
  }

  // 11. Default Applied — but check if PPT/Test events reveal a further stage.
  // This handles companies stored as 'applied' in the DB that have PPT events in the
  // events table which have already passed (isPptCompleted) or are upcoming (hasPpt).
  if (isPptCompleted) {
    return {
      stageIndex: 1,
      effectiveStatus: 'ppt_completed',
      eliminatedStage: -1,
      furthestPassedStage: 1,
      statusSubtitle: 'PPT Completed · Test Shortlist Awaited',
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted: true,
      isInterviewCompleted,
    };
  }
  if (isPptOngoing) {
    return {
      stageIndex: 1,
      effectiveStatus: 'ppt_ongoing',
      eliminatedStage: -1,
      furthestPassedStage: 0,
      statusSubtitle: 'Pre-Placement Talk Live Now',
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted: false,
      isInterviewCompleted,
      isPptOngoing: true,
    };
  }
  if (hasPpt) {
    return {
      stageIndex: 1,
      effectiveStatus: 'ppt_scheduled',
      eliminatedStage: -1,
      furthestPassedStage: 0,
      statusSubtitle: 'Stage 2 of 5 · PPT Scheduled',
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted,
      isInterviewCompleted,
    };
  }
  return {
    stageIndex: 0,
    effectiveStatus: 'applied',
    eliminatedStage: -1,
    furthestPassedStage: 0,
    statusSubtitle: 'Stage 1 of 5 · Applied',
    hasPpt,
    hasTest,
    hasInterview,
    isTestCompleted,
    isPptCompleted,
    isInterviewCompleted,
    eliminatedStageId: null,
    eliminationLabel: null,
  };
}

// ---------------------------------------------------------------------------
// Derived stages builder — for multi-round / non-standard pipelines
// ---------------------------------------------------------------------------

export interface DerivedStage extends StageDefinition {
  eventType?: string;
  roundNumber?: number;
}

const SKIP_EVENT_TYPES = new Set([
  'registration_deadline',
  'result',
  'joining_date',
  'other',
]);

/**
 * Builds an ordered list of stages from the events known for a placement drive.
 * Visual order is by start_time ASC (NULL last), as a display hint only.
 * When no events exist, returns undefined so callers can fall back to STAGES.
 *
 * The returned stages are display-only — they are never fed back into status logic.
 */
export function deriveStagesFromEvents(
  events: EventLike[]
): DerivedStage[] | undefined {
  const relevant = events.filter((e) => {
    const t = (e.event_type || e.eventType || '').toLowerCase();
    return t && !SKIP_EVENT_TYPES.has(t);
  });
  if (relevant.length === 0) return undefined;

  // Sort by start_time ASC for visual ordering only (NULL → end)
  const sorted = [...relevant].sort((a, b) => {
    const ta = a.start_time || a.startTime;
    const tb = b.start_time || b.startTime;
    if (!ta && !tb) return 0;
    if (!ta) return 1;
    if (!tb) return -1;
    return new Date(ta).getTime() - new Date(tb).getTime();
  });

  const stages: DerivedStage[] = [
    { id: 'applied', label: 'Applied', shortLabel: 'Applied' },
  ];

  // Track how many of each event type we've seen (for round numbering display)
  const seen = new Map<string, number>();

  for (const event of sorted) {
    const eventType = (event.event_type || event.eventType || '').toLowerCase();
    if (!eventType) continue;

    // round_number from DB is authoritative; fall back to increment counter
    const dbRound = event.round_number ?? null;
    const seenCount = seen.get(eventType) ?? 0;
    const displayRound = dbRound ?? (seenCount + 1);
    seen.set(eventType, Math.max(seenCount + 1, displayRound));

    const stageId = deriveStageId(eventType, displayRound);
    const { label, shortLabel } = deriveStageLabelFromId(stageId);

    stages.push({
      id: stageId,
      label,
      shortLabel,
      eventType,
      roundNumber: displayRound,
    });
  }

  stages.push({ id: 'offer', label: 'Selected / Offer', shortLabel: 'Offer' });
  return stages;
}

export function getStageStatusLabel(status: string, stageIndex: number): string {
  const s = (status || '').toLowerCase();
  if (s === 'rejected') return 'Eliminated in Round';
  if (s === 'not_shortlisted') return 'Not Shortlisted';
  if (s === 'withdrawn' || s === 'declined') return 'Withdrawn';
  if (s === 'not_applied') return 'Not Registered';
  if (s === 'interview_ongoing') return 'Interview Live Now';
  if (s === 'test_ongoing') return 'Test Live Now';
  if (s === 'ppt_ongoing') return 'PPT Live Now';
  if (s === 'test_completed') return 'Test Completed';
  if (s === 'ppt_completed') return 'PPT Completed';
  if (s === 'interview_completed') return 'Interview Completed';

  switch (stageIndex) {
    case 4:
      return 'Selected · Offer Received 🎉';
    case 3:
      return 'Shortlisted for Interview';
    case 2:
      return 'Shortlisted for Test';
    case 1:
      return 'PPT Scheduled';
    case 0:
    default:
      return 'Applied · In Screening';
  }
}

/**
 * Checks if a status represents an eliminated / rejected candidate at any stage
 * (screening, post-test, or post-interview).
 */
export function isEliminatedStatus(status?: string | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase().trim();
  return (
    s === 'not_shortlisted' ||
    s === 'rejected' ||
    s === 'rejected_test' ||
    s === 'rejected_interview' ||
    s === 'test_eliminated' ||
    s === 'interview_eliminated' ||
    s.startsWith('rejected') ||
    s.includes('eliminated')
  );
}

/**
 * Checks if a status represents an inactive application:
 * eliminated, rejected, not applied/registered, withdrawn, or declined.
 */
export function isInactiveStatus(status?: string | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase().trim();
  return (
    isEliminatedStatus(s) ||
    s === 'not_applied' ||
    s === 'withdrawn' ||
    s === 'declined'
  );
}
