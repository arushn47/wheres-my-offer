'use client';

import { useState } from 'react';
import { CheckCircle2, RefreshCw, X, AlertCircle, Minus, ChevronUp } from 'lucide-react';
import { useSync } from '@/context/sync-context';
import { cn } from '@/lib/utils';

/**
 * Floating reprocess progress card.
 * Rendered at the layout level so it persists when the user navigates away from Settings.
 * Supports expanding/minimizing and dismissal via ✕.
 */
export default function ReprocessCard() {
  const { reprocessState, dismissReprocess } = useSync();
  const [minimized, setMinimized] = useState(false);

  if (!reprocessState) return null;

  const { active, step, totalSteps, message, result } = reprocessState;
  const percent = totalSteps > 0 ? Math.min(100, Math.round((step / totalSteps) * 100)) : 0;
  const isDone = !active && result !== undefined;
  const isError = !active && !result && step === 0;

  // Minimized state: sleek compact pill with live progress
  if (minimized) {
    return (
      <div
        className={cn(
          'fixed bottom-20 right-4 z-50 rounded-xl border shadow-xl backdrop-blur-md transition-all duration-300',
          'bg-zinc-900/95 border-zinc-700/60 overflow-hidden',
          active && 'border-indigo-500/40 shadow-indigo-900/20',
          isDone && !isError && 'border-emerald-500/40',
          isError && 'border-red-500/40',
          'lg:bottom-4'
        )}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-2.5 px-3 py-2">
          <div
            className="flex items-center gap-2 cursor-pointer select-none"
            onClick={() => setMinimized(false)}
            title="Click to expand"
          >
            {active ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin text-indigo-400 shrink-0" />
            ) : isError ? (
              <AlertCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
            )}
            <span className="text-xs font-semibold text-zinc-200">
              {active ? `Re-indexing (${percent}%)` : isError ? 'Re-index Failed' : 'Re-index Complete'}
            </span>
          </div>

          <div className="flex items-center gap-1 border-l border-zinc-800 pl-2">
            <button
              type="button"
              onClick={() => setMinimized(false)}
              className="flex items-center justify-center h-5 w-5 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 transition-colors shrink-0"
              title="Expand"
              aria-label="Expand"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={dismissReprocess}
              className="flex items-center justify-center h-5 w-5 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 transition-colors shrink-0"
              title="Close"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Subtle mini progress bar along bottom edge while active */}
        {active && (
          <div className="h-1 w-full bg-zinc-800">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-emerald-400 transition-all duration-300"
              style={{ width: `${Math.max(percent, 5)}%` }}
            />
          </div>
        )}
      </div>
    );
  }

  // Expanded state: spacious, clear progress, fully legible
  return (
    <div
      className={cn(
        'fixed bottom-20 right-4 z-50 w-[340px] sm:w-[400px] max-w-[calc(100vw-2rem)] rounded-xl border shadow-2xl backdrop-blur-md transition-all duration-300',
        'bg-zinc-900/95 border-zinc-700/60',
        active && 'border-indigo-500/40 shadow-indigo-950/40',
        isDone && !isError && 'border-emerald-500/40',
        isError && 'border-red-500/40',
        'lg:bottom-4'
      )}
      role="status"
      aria-live="polite"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-zinc-800/80">
        <div className="flex items-center gap-2 min-w-0">
          {active ? (
            <RefreshCw className="h-4 w-4 animate-spin text-indigo-400 shrink-0" />
          ) : isError ? (
            <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
          )}
          <span className="text-xs font-semibold text-zinc-200 truncate">
            {active ? 'Re-indexing Placement Data' : isError ? 'Re-index Failed' : 'Re-index Complete'}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setMinimized(true)}
            className="flex items-center justify-center h-6 w-6 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={dismissReprocess}
            className="flex items-center justify-center h-6 w-6 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            title="Close"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="p-3.5 space-y-3">
        <p className="text-xs text-zinc-300 leading-relaxed break-words line-clamp-2">
          {message}
        </p>

        {active && (
          <div className="space-y-1.5">
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800/80">
              <div
                className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-indigo-400 to-emerald-400 transition-all duration-500 shadow-sm"
                style={{ width: `${Math.max(percent, 5)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-zinc-400">
              <span className="font-medium text-zinc-400">Step {step} of {totalSteps}</span>
              <span className="font-mono font-bold text-indigo-300">{percent}%</span>
            </div>
          </div>
        )}

        {isDone && result && (
          <div className="flex flex-wrap gap-2 pt-1 text-xs">
            {(result.neoPatDrivesCount ?? 0) > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-medium">
                {result.neoPatDrivesCount} drives tracked
              </span>
            )}
            {(result.updatedApplications ?? 0) > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-medium">
                {result.updatedApplications} apps updated
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
