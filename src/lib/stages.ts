import { deriveEventEndTime } from '@/lib/event-duration';

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
  const isNotesInterview = /eliminated.*interview|interview.*eliminated|interviewed.*not\s*selected|rejected.*interview/i.test(notesText);
  const isNotesTest = /eliminated.*test|test.*eliminated|rejected.*test|test.*rejected/i.test(notesText);

  // ─── MANUAL OVERRIDE FAST PATH ──────────────────────────────────────────
  // If the application status was manually set by the user, honor it strictly!
  // Do NOT let company-wide broadcast events hijack a manually specified status.
  if (manualOverride) {
    if (s === 'not_shortlisted') {
      return {
        stageIndex: 2,
        effectiveStatus: 'not_shortlisted',
        eliminatedStage: 2,
        furthestPassedStage: hasPpt ? 1 : 0,
        statusSubtitle: hasPpt ? 'Not Shortlisted for Test (Post-PPT)' : 'Screened Out · Eligibility / PPT',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
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
      };
    }

    if (s === 'rejected') {
      return {
        stageIndex: 2,
        effectiveStatus: 'not_shortlisted',
        eliminatedStage: 2,
        furthestPassedStage: hasPpt ? 1 : 0,
        statusSubtitle: hasPpt ? 'Not Shortlisted for Test (Post-PPT)' : 'Screened Out · Eligibility / PPT',
        hasPpt,
        hasTest,
        hasInterview,
        isTestCompleted,
        isPptCompleted,
        isInterviewCompleted,
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
    };
  }

  // ─── AUTOMATED INFERRED STAGE PATH ────────────────────────────────────────

  // 1. Not Shortlisted: candidate applied but was screened out before test round (Pre-Test Screening)
  if (s === 'not_shortlisted') {
    return {
      stageIndex: 2,
      effectiveStatus: 'not_shortlisted',
      eliminatedStage: 2,
      furthestPassedStage: hasPpt ? 1 : 0, // Passed Applied (0) and PPT (1 if attended)
      statusSubtitle: hasPpt ? 'Not Shortlisted for Test (Post-PPT)' : 'Screened Out · Eligibility / PPT',
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted,
      isInterviewCompleted,
    };
  }

  // 2. Eliminated in Interview Round (Interviewed · Not Selected)
  if (s === 'rejected_interview' || (s === 'rejected' && isNotesInterview)) {
    return {
      stageIndex: 4,
      effectiveStatus: 'rejected_interview',
      eliminatedStage: 4,
      furthestPassedStage: 3, // Passed Applied (0), PPT (1), Test (2), and Interview (3)
      statusSubtitle: 'Interviewed · Not Selected',
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted,
      isInterviewCompleted,
    };
  }

  // 3. Eliminated in Test Round (Post-Test)
  if (
    s === 'rejected_test' ||
    s === 'test_eliminated' ||
    (s === 'rejected' && isNotesTest)
  ) {
    return {
      stageIndex: 3,
      effectiveStatus: 'rejected_test',
      eliminatedStage: 3,
      furthestPassedStage: 2, // Passed Applied (0), PPT (1), and Test (2)
      statusSubtitle: 'Eliminated in Test Round',
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted,
      isInterviewCompleted,
    };
  }

  // 4. Generic Rejected fallback (no notes, no events -> screened out before test)
  if (s === 'rejected') {
    if (hasInterview && isInterviewCompleted) {
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
      };
    }
    if (hasTest && isTestCompleted) {
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
      };
    }
    return {
      stageIndex: 2,
      effectiveStatus: 'not_shortlisted',
      eliminatedStage: 2,
      furthestPassedStage: hasPpt ? 1 : 0,
      statusSubtitle: hasPpt ? 'Not Shortlisted for Test (Post-PPT)' : 'Screened Out · Eligibility / PPT',
      hasPpt,
      hasTest,
      hasInterview,
      isTestCompleted,
      isPptCompleted,
      isInterviewCompleted,
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
  };
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
