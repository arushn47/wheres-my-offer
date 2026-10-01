'use client';

import React from 'react';
import { Ban, FileX2, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

export * from '@/lib/stages';
import {
  STAGES,
  STAGE_ACTIVE_STYLES,
  type EventLike,
  type DerivedStage,
  getEffectiveStage,
  deriveStagesFromEvents,
} from '@/lib/stages';
import { parseAnnouncedProcessToken } from '@/lib/sync/round-identity';



export interface StageStepperProps {
  status: string;
  stage?: number;
  latestEvent?: EventLike | null;
  events?: EventLike[] | null;
  notes?: string | null;
  manualOverride?: boolean;
  compact?: boolean;
  className?: string;
}

export function getPipelineStages({
  effective,
  currentStage,
  furthestPassed,
  eliminatedStage,
  allEvents = [],
  notes,
}: {
  effective: ReturnType<typeof getEffectiveStage>;
  currentStage: number;
  furthestPassed: number;
  eliminatedStage: number;
  allEvents?: EventLike[];
  notes?: string | null;
}): Array<{ id: string; label: string; shortLabel: string }> {

  // ── Announced process pipeline (high-confidence structured rounds from circular) ──
  // When a circular explicitly lists the recruitment schedule (e.g. Axxela:
  // "Test 1 (Online)" -> "Test 2 (in campus)" -> "Game Round" -> "Interview"),
  // we render those exact rounds so candidates see the actual process they're going
  // through instead of the generic template.
  const announcedRounds = parseAnnouncedProcessToken(notes);
  if (announcedRounds && announcedRounds.length >= 2) {
    const pipeline: Array<{ id: string; label: string; shortLabel: string }> = [
      { id: 'applied', label: 'Applied', shortLabel: 'Applied' },
    ];
    for (const r of announcedRounds) {
      pipeline.push({ id: r.id, label: r.label, shortLabel: r.shortLabel });
    }
    pipeline.push({ id: 'offer', label: 'Selected / Offer', shortLabel: 'Offer' });
    return pipeline;
  }

  // ── Standard pipeline (fallback when no announced process is detected) ────────
  // Applied -> PPT -> Test -> Interview -> Offer
  //
  // User Requirement:
  // "if test round is done without ppt then remove ppt not remove further rounds, keep a basic ui atleast"
  //
  // 1. Keep the standard basic recruitment UI intact — do NOT remove upcoming future rounds.
  // 2. If the recruitment process has reached Test or beyond WITHOUT ever having a PPT event,
  //    we omit the PPT circle from the pipeline.
  // 3. Otherwise (e.g. at Applied stage, or when PPT did occur/is scheduled), PPT is included.
  const hasPptEvent = Boolean(
    effective.hasPpt ||
    effective.isPptCompleted ||
    currentStage === 1 ||
    eliminatedStage === 1 ||
    allEvents.some((e) => /ppt|pre[\s-]*placement/i.test(e.event_type || e.eventType || ''))
  );

  const hasReachedTestOrBeyond = Boolean(
    currentStage >= 2 ||
    furthestPassed >= 2 ||
    eliminatedStage >= 2 ||
    effective.hasTest ||
    effective.hasInterview ||
    effective.isTestCompleted ||
    effective.isInterviewCompleted
  );

  const includePpt = hasReachedTestOrBeyond ? hasPptEvent : true;

  const stageList: Array<{ id: string; label: string; shortLabel: string }> = [
    { id: 'applied', label: 'Applied', shortLabel: 'Applied' },
  ];

  if (includePpt) {
    stageList.push({ id: 'ppt', label: 'PPT Scheduled', shortLabel: 'PPT' });
  }

  // Always keep future rounds so candidates see their recruitment roadmap
  stageList.push({ id: 'test', label: 'Shortlisted for Test', shortLabel: 'Test' });
  stageList.push({ id: 'interview', label: 'Shortlisted for Interview', shortLabel: 'Interview' });
  stageList.push({ id: 'offer', label: 'Selected / Offer', shortLabel: 'Offer' });

  return stageList;
}


export function StageStepper({
  status,
  stage: stageProp,
  latestEvent,
  events,
  notes,
  manualOverride,
  compact = false,
  className,
}: StageStepperProps) {
  const effective = getEffectiveStage(status, latestEvent, events, notes, manualOverride);
  const currentStage = stageProp ?? effective.stageIndex;
  const eliminatedStage = effective.eliminatedStage;
  const furthestPassed = effective.furthestPassedStage;

  const isWithdrawn = (effective.effectiveStatus === 'withdrawn' || effective.effectiveStatus === 'declined');
  const isRegistrationOpen = (effective.effectiveStatus === 'registration_open');
  const isNotApplied = (effective.effectiveStatus === 'not_applied');

  const allEvents: EventLike[] = [
    ...(latestEvent ? [latestEvent] : []),
    ...(events || []),
  ];

  const stageList = getPipelineStages({
    effective,
    currentStage,
    furthestPassed,
    eliminatedStage,
    allEvents,
    notes,
  });

  // Pre-parse announced rounds once for use in both mapIndexToStageId and
  // getEliminatedStageId so we don't call parseAnnouncedProcessToken repeatedly.
  const announcedRoundsForMap = parseAnnouncedProcessToken(notes);
  const isAnnouncedPipeline = announcedRoundsForMap && announcedRoundsForMap.length >= 2;

  // ── Map static 5-stage indices to our dynamic pipeline ──────────────────────
  // When an announced process is active (stageList built from round tokens),
  // we map semantic type indices to the first announced round of that type.
  // Fallback: standard 5-stage index mapping.
  const mapIndexToStageId = (idx: number): string => {
    if (idx === 0) return 'applied';
    if (idx === 4) return 'offer';
    if (isAnnouncedPipeline && announcedRoundsForMap) {
      // idx 1 → PPT or first test, idx 2 → test, idx 3 → interview
      // Map by finding the first announced round of the matching semantic type
      if (idx === 1) {
        const firstPpt = announcedRoundsForMap.find(r => r.roundType === 'ppt');
        if (firstPpt) return firstPpt.id;
        const firstTest = announcedRoundsForMap.find(r => r.roundType === 'test');
        if (firstTest) return firstTest.id;
      }
      if (idx === 2) {
        const firstTest = announcedRoundsForMap.find(r => r.roundType === 'test');
        if (firstTest) return firstTest.id;
      }
      if (idx === 3) {
        const firstInterview = announcedRoundsForMap.find(r => r.roundType === 'interview');
        if (firstInterview) return firstInterview.id;
      }
    }
    // Standard mapping
    if (idx === 1) return 'ppt';
    if (idx === 2) return 'test';
    if (idx === 3) return 'interview';
    return 'applied';
  };

  const activeStageId = mapIndexToStageId(currentStage);
  const furthestPassedStageId = furthestPassed !== -1 ? mapIndexToStageId(furthestPassed) : null;

  const eliminatedStageId = (() => {
    if (eliminatedStage === -1) return null;
    // Announced pipeline: resolve by round type
    if (isAnnouncedPipeline && announcedRoundsForMap) {
      if (effective.eliminatedStageId) {
        // Try to find exact match in announced rounds
        const exactMatch = announcedRoundsForMap.find(r => r.id === effective.eliminatedStageId);
        if (exactMatch) return exactMatch.id;
        // Fall back to type-based match
        if (effective.eliminatedStageId.startsWith('interview')) {
          const r = announcedRoundsForMap.find(r => r.roundType === 'interview');
          if (r) return r.id;
        }
        if (effective.eliminatedStageId.startsWith('test')) {
          const r = announcedRoundsForMap.find(r => r.roundType === 'test');
          if (r) return r.id;
        }
      }
      if (effective.effectiveStatus === 'rejected_interview') {
        const r = announcedRoundsForMap.find(r => r.roundType === 'interview');
        if (r) return r.id;
      }
      if (effective.effectiveStatus === 'rejected_test' || effective.effectiveStatus === 'not_shortlisted') {
        const r = announcedRoundsForMap.find(r => r.roundType === 'test');
        if (r) return r.id;
      }
    }
    // Standard pipeline elimination mapping
    if (effective.eliminatedStageId) {
      if (effective.eliminatedStageId.startsWith('interview')) return 'interview';
      if (effective.eliminatedStageId.startsWith('test')) return 'test';
      if (effective.eliminatedStageId.startsWith('ppt')) return 'ppt';
      if (effective.eliminatedStageId.startsWith('applied')) return 'applied';
    }
    if (effective.effectiveStatus === 'rejected_interview') return 'interview';
    if (effective.effectiveStatus === 'rejected_test' || effective.effectiveStatus === 'not_shortlisted') return 'test';
    if (eliminatedStage === 0) return 'applied';
    if (eliminatedStage === 1) return 'ppt';
    if (eliminatedStage === 2 || eliminatedStage === 3) return 'test';
    if (eliminatedStage === 4) return 'interview';
    return mapIndexToStageId(eliminatedStage);
  })();

  let activeCurrentStage = stageList.findIndex(s => s.id === activeStageId);
  if (activeCurrentStage === -1) activeCurrentStage = 0;

  let activeFurthestPassed = -1;
  if (furthestPassedStageId) {
    activeFurthestPassed = stageList.findIndex(s => s.id === furthestPassedStageId);
  }

  let activeEliminatedStage = -1;
  if (eliminatedStageId) {
    activeEliminatedStage = stageList.findIndex(s => s.id === eliminatedStageId);
  }

  // Dedicated UI Banner for Registration Open
  if (isRegistrationOpen) {
    if (compact) {
      return (
        <div
          data-testid="stage-stepper-registration-open"
          className={cn(
            'flex items-center gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 select-none',
            className
          )}
        >
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-amber-500/40 bg-amber-500/20 text-amber-400">
            <Clock className="h-3 w-3 text-amber-400 animate-pulse" />
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <span className="truncate text-[11px] font-medium text-amber-300">
              Apply on NeoPAT · {effective.statusSubtitle}
            </span>
          </div>
        </div>
      );
    }

    return (
      <div
        data-testid="stage-stepper-registration-open"
        className={cn(
          'flex items-center gap-3.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 select-none',
          className
        )}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/20 text-amber-400">
          <Clock className="h-4 w-4 animate-pulse" />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-amber-200">Registration Window Open</h4>
          <p className="mt-0.5 text-xs text-amber-300/90">
            {effective.statusSubtitle} — Complete your registration on the NeoPAT portal before the deadline expires.
          </p>
        </div>
      </div>
    );
  }

  // Dedicated UI Banner for Withdrawn / Opted Out drives
  if (isWithdrawn) {
    if (compact) {
      return (
        <div
          data-testid="stage-stepper-withdrawn"
          className={cn(
            'flex items-center gap-2.5 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2 select-none',
            className
          )}
        >
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-700/60 bg-zinc-800/80 text-zinc-400">
            <Ban className="h-3 w-3 text-zinc-400" />
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <span className="truncate text-[11px] font-medium text-zinc-400">
              Registration Withdrawn · Opted Out on NeoPAT
            </span>
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-zinc-500">
              Opted Out
            </span>
          </div>
        </div>
      );
    }

    return (
      <div
        data-testid="stage-stepper-withdrawn"
        className={cn(
          'flex items-center gap-3.5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 select-none',
          className
        )}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700/60 bg-zinc-800 text-zinc-400">
          <Ban className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-zinc-200">Registration Withdrawn · Opted Out</h4>
            <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">NeoPAT Opt-Out</span>
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            You opted out of this drive on NeoPAT and did not participate in subsequent recruitment rounds.
          </p>
        </div>
      </div>
    );
  }

  // Dedicated UI Banner for Not Applied / Unregistered circulars
  if (isNotApplied) {
    if (compact) {
      return (
        <div
          data-testid="stage-stepper-not-applied"
          className={cn(
            'flex items-center gap-2.5 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2 select-none',
            className
          )}
        >
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-700/60 bg-zinc-800/80 text-zinc-400">
            <FileX2 className="h-3 w-3 text-zinc-400" />
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <span className="truncate text-[11px] font-medium text-zinc-400">
              Eligible Circular · No Application Submitted
            </span>
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-zinc-500">
              Not Applied
            </span>
          </div>
        </div>
      );
    }

    return (
      <div
        data-testid="stage-stepper-not-applied"
        className={cn(
          'flex items-center gap-3.5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 select-none',
          className
        )}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700/60 bg-zinc-800 text-zinc-400">
          <FileX2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-zinc-200">Eligible Circular · Not Registered</h4>
            <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">Unregistered</span>
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            CDC issued an eligibility circular for your branch/batch, but no registration was submitted.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="stage-stepper"
      className={cn('flex items-center w-full min-w-0 select-none', className)}
    >
      {stageList.map((s, i) => {
        const isEliminated = i === activeEliminatedStage;

        // Is this the currently active round or milestone?
        const isCurrent =
          !isEliminated &&
          !isWithdrawn &&
          activeEliminatedStage === -1 &&
          i === activeCurrentStage;

        // Historical passed stage (completed before current stage)
        const isHistoricalPassed = !isEliminated && !isCurrent && i < activeCurrentStage && i <= activeFurthestPassed;

        // Has this stage been completed (either in past or as current completed milestone)?
        const isCompleted = !isEliminated && i <= activeFurthestPassed;

        // ── Display label for this stage ───────────────────────────────────────
        let displayLabel = compact ? s.shortLabel : s.label;
        
        // Append explicit round/test numbers if there are multiple events of this type
        // to address user feedback: "if there are 2 tests or interviews dont need to show two diff circles but you could mention the test no"
        if (s.id === 'test' && effective.hasTest) {
          const testCount = allEvents.filter(e => /online_test|coding_test|assessment/i.test(e.event_type || e.eventType || '')).length;
          if (testCount > 1) {
            displayLabel = compact ? `Test (${testCount})` : `Test (Round ${testCount})`;
          }
        }
        if (s.id === 'interview' && effective.hasInterview) {
          const intCount = allEvents.filter(e => /interview/i.test(e.event_type || e.eventType || '')).length;
          if (intCount > 1) {
            displayLabel = compact ? `Interview (${intCount})` : `Interview (Round ${intCount})`;
          }
        }

        // Locate this stage in the announced rounds list if applicable
        const announcedRound = isAnnouncedPipeline
          ? announcedRoundsForMap!.find(r => r.id === s.id)
          : null;

        if (!isEliminated) {
          if (announcedRound) {
            const isRoundCompleted = isHistoricalPassed || (isCurrent && (
              (announcedRound.roundType === 'test' && (effective.isTestCompleted || status === 'test_completed')) ||
              (announcedRound.roundType === 'interview' && (effective.isInterviewCompleted || status === 'interview_completed')) ||
              (announcedRound.roundType === 'ppt' && (effective.isPptCompleted || status === 'ppt_completed')) ||
              isCompleted
            ));

            if (isRoundCompleted) {
              displayLabel = compact ? `${announcedRound.shortLabel} Done` : `${announcedRound.shortLabel} Completed`;
            } else if (isCurrent) {
              // Keep the announced round's own label as active label
              displayLabel = compact ? announcedRound.shortLabel : announcedRound.label;
            }
          } else {
            // Standard pipeline completed state labels
            if (s.id === 'ppt' && effective.isPptCompleted) {
              displayLabel = compact ? 'PPT Done' : 'PPT Completed';
            } else if (s.id === 'test' && (effective.isTestCompleted || status === 'test_completed')) {
              displayLabel = compact ? 'Test Done' : 'Test Completed';
            }
          }
        } else if (isEliminated) {
          if (announcedRound) {
            // Announced pipeline elimination: use the round's own label
            const elimLabel = effective.eliminationLabel;
            displayLabel = elimLabel
              ? (compact ? `Not in ${announcedRound.shortLabel}` : elimLabel)
              : (compact ? `Out at ${announcedRound.shortLabel}` : `Eliminated at ${announcedRound.label}`);
          } else if (s.id === 'applied') {
            displayLabel = compact ? 'Screening' : 'Screened Out';
          } else if (s.id === 'test') {
            const elimLabel = effective.eliminationLabel;
            displayLabel = elimLabel
              ? (compact ? elimLabel.split(' ').slice(-2).join(' ') : elimLabel)
              : (compact ? 'Eliminated' : 'Eliminated (Test)');
          } else if (s.id === 'interview') {
            const elimLabel = effective.eliminationLabel;
            displayLabel = elimLabel
              ? (compact ? 'Not Selected' : elimLabel)
              : (compact ? 'Not Selected' : 'Not Selected (Interview)');
          } else {
            displayLabel = compact ? s.shortLabel : s.label;
          }
        }


        // Map stage index to STAGE_ACTIVE_STYLES (clamp to avoid out-of-bounds).
        const stageStyleKeys = Object.keys(STAGE_ACTIVE_STYLES).length;
        const styleIdx = Math.min(i, stageStyleKeys - 1);
        const activeStyle = STAGE_ACTIVE_STYLES[styleIdx] || STAGE_ACTIVE_STYLES[0];

        return (
          <div key={s.id} className="flex flex-1 items-center last:flex-none min-w-0">
            <div className="flex flex-col items-center flex-1 min-w-0">
              <div className="relative flex items-center justify-center">
                {isCurrent && (
                  <span
                    className={cn(
                      'absolute -inset-1 rounded-full animate-ping pointer-events-none opacity-40',
                      activeStyle.ripple
                    )}
                    style={{ animationDuration: '2.5s' }}
                  />
                )}
                <div
                  className={cn(
                    'relative z-10 flex items-center justify-center rounded-full border font-mono font-bold transition-all shrink-0',
                    compact ? 'h-6 w-6 text-[9px]' : 'h-7 w-7 text-[10px]',
                    isEliminated
                      ? 'border-rose-400 bg-rose-500/25 text-rose-300 ring-2 ring-rose-500/50 shadow-[0_0_12px_rgba(244,63,94,0.45)]'
                      : isCurrent
                        ? activeStyle.circle
                        : isHistoricalPassed
                          ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-400/80'
                          : isWithdrawn && i <= activeFurthestPassed
                            ? 'border-zinc-600 bg-zinc-800 text-zinc-300'
                            : 'border-zinc-700 bg-[#141418] text-zinc-400'
                  )}
                >
                  {isEliminated ? '✕' : (isCompleted || isHistoricalPassed) ? '✓' : i + 1}
                </div>
              </div>
              <span
                title={s.label}
                className={cn(
                  'truncate max-w-full text-center transition-colors',
                  compact ? 'text-[8px] sm:text-[8.5px] tracking-tighter sm:tracking-normal mt-1' : 'text-[10px] mt-1.5 hidden sm:block',
                  isEliminated
                    ? 'text-rose-300 font-bold'
                    : isCurrent
                      ? activeStyle.text
                      : isHistoricalPassed
                        ? 'text-emerald-400/75 font-medium'
                        : 'text-zinc-400 font-medium'
                )}
              >
                {displayLabel}
              </span>
            </div>
            {i < stageList.length - 1 && (
              <div
                className={cn(
                  'mx-1 sm:mx-1.5 h-px flex-1 transition-colors',
                  compact ? 'mb-3.5' : 'mb-0 sm:mb-4',
                  activeEliminatedStage !== -1 && i === activeEliminatedStage - 1
                    ? 'bg-rose-500/70'
                    : i < activeCurrentStage
                      ? 'bg-emerald-500/45'
                      : 'bg-zinc-700/70'
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default StageStepper;
