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

  // ── Derive dynamic stage list from events (multi-round / non-standard pipelines) ──
  // Only derive when we have real event data. Falls back to static STAGES if empty.
  // NOTE: Dynamic stages are display-only — they never feed back into status logic.
  const allEvents: EventLike[] = [
    ...(latestEvent ? [latestEvent] : []),
    ...(events || []),
  ];
  const derivedStages = (allEvents.length > 0 && !isWithdrawn && !isRegistrationOpen && !isNotApplied)
    ? deriveStagesFromEvents(allEvents)
    : undefined;

  // Use derived stages when the pipeline is genuinely non-standard:
  //   • Drive has a Group Discussion event (GD sits between Test and Interview in some companies)
  //   • Any event has round_number >= 2 (multi-round test or multi-round interview)
  //   • Otherwise fall back to the standard 5-stage static display
  const hasGdEvent = allEvents.some((e) =>
    /group_discussion/i.test(e.event_type || e.eventType || '')
  );
  const hasMultiRound = allEvents.some((e) => (e.round_number ?? 1) >= 2);
  const hasDynamicPipeline = derivedStages != null && (hasGdEvent || hasMultiRound);
  const stageList: (typeof STAGES[0] | DerivedStage)[] = hasDynamicPipeline ? derivedStages! : STAGES;

  // ── Compute eliminatedStageIndex for dynamic pipeline ──────────────────────
  // For dynamic pipelines, find which stage index the candidate was eliminated at
  // by matching effective.eliminatedStageId against derived stage IDs.
  const eliminatedStageId = effective.eliminatedStageId;
  let dynamicEliminatedIdx = -1;
  if (hasDynamicPipeline && eliminatedStage !== -1 && eliminatedStageId) {
    const idx = stageList.findIndex((s) => s.id === eliminatedStageId);
    dynamicEliminatedIdx = idx >= 0 ? idx : eliminatedStage;
  } else if (hasDynamicPipeline && eliminatedStage !== -1) {
    // Fallback: map legacy eliminatedStage index proportionally
    dynamicEliminatedIdx = Math.min(eliminatedStage, stageList.length - 1);
  }
  const activeEliminatedStage = hasDynamicPipeline ? dynamicEliminatedIdx : eliminatedStage;

  // For dynamic pipelines, current stage index needs to be mapped too.
  // Use the eliminatedStageId if known, else proportional mapping.
  const activeFurthestPassed = hasDynamicPipeline
    ? Math.min(furthestPassed, stageList.length - 1)
    : furthestPassed;
  const activeCurrentStage = hasDynamicPipeline
    ? Math.min(currentStage, stageList.length - 1)
    : currentStage;

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
        // For dynamic pipelines: use stage.label / stage.shortLabel directly (already set from events).
        // For static pipeline: apply legacy override labels for eliminated stages.
        let displayLabel = compact ? s.shortLabel : s.label;
        if (!hasDynamicPipeline && !isEliminated) {
          if (i === 1 && effective.isPptCompleted) {
            displayLabel = compact ? 'PPT Done' : 'PPT Completed';
          }
        } else if (!hasDynamicPipeline && isEliminated) {
          if (i === 0) {
            displayLabel = compact ? 'Screening' : 'Screened Out';
          } else if (i === 2) {
            displayLabel = compact ? 'Shortlist' : 'Not Shortlisted';
          } else if (i === 3) {
            // Use the structured elimination label when available for precision
            const elimLabel = effective.eliminationLabel;
            displayLabel = elimLabel
              ? (compact ? elimLabel.split(' ').slice(-2).join(' ') : elimLabel)
              : (compact ? 'Eliminated' : 'Eliminated (Test)');
          } else if (i === 4) {
            const elimLabel = effective.eliminationLabel;
            displayLabel = elimLabel
              ? (compact ? 'Not Selected' : elimLabel)
              : (compact ? 'Not Selected' : 'Not Selected (Interview)');
          }
        } else if (hasDynamicPipeline && isEliminated) {
          // Dynamic pipeline: eliminated stage label is always the stage's own label
          // (the elimination is precisely at this stage)
          displayLabel = compact ? s.shortLabel : s.label;
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
