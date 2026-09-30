'use client';

import { CheckCircle2, RefreshCw, X, AlertCircle } from 'lucide-react';
import { useSync } from '@/context/sync-context';
import { cn } from '@/lib/utils';

/**
 * Floating reprocess progress card.
 * Rendered at the layout level so it persists when the user navigates away from Settings.
 * Dismissed via the ✕ button or auto-hides 8 seconds after completion.
 */
export default function ReprocessCard() {
  const { reprocessState, dismissReprocess } = useSync();

  if (!reprocessState) return null;

  const { active, step, totalSteps, message, result } = reprocessState;
  const percent = totalSteps > 0 ? Math.min(100, Math.round((step / totalSteps) * 100)) : 0;
  const isDone = !active && result !== undefined;
  const isError = !active && !result && step === 0;

  return (
    <div
      className={cn(
        'fixed bottom-20 right-4 z-50 w-72 rounded-xl border shadow-xl backdrop-blur-md transition-all duration-300',
        'bg-zinc-900/95 border-zinc-700/60',
        active && 'border-indigo-500/40 shadow-indigo-900/20',
        isDone && !isError && 'border-emerald-500/40',
        isError && 'border-red-500/40',
        'lg:bottom-4'
      )}
      role="status"
      aria-live="polite"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-zinc-800/60">
        <div className="flex items-center gap-1.5">
          {active ? (
            <RefreshCw className="h-3 w-3 animate-spin text-indigo-400 shrink-0" />
          ) : isError ? (
            <AlertCircle className="h-3 w-3 text-red-400 shrink-0" />
          ) : (
            <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
          )}
          <span className="text-[11px] font-semibold text-zinc-200">
            {active ? 'Re-indexing Placement Data' : isError ? 'Re-index Failed' : 'Re-index Complete'}
          </span>
        </div>
        <button
          type="button"
          onClick={dismissReprocess}
          className="flex items-center justify-center h-4 w-4 rounded text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
          aria-label="Dismiss"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* Body */}
      <div className="px-3 py-2.5 space-y-2">
        <p className="text-[10px] text-zinc-400 truncate">{message}</p>

        {active && (
          <>
            <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-indigo-500 transition-all duration-500"
                style={{ width: `${Math.max(percent, 5)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[9px] text-zinc-600">
              <span>Step {step} of {totalSteps}</span>
              <span className="font-mono">{percent}%</span>
            </div>
          </>
        )}

        {isDone && result && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
            {(result.neoPatDrivesCount ?? 0) > 0 && (
              <span className="text-emerald-400">{result.neoPatDrivesCount} drives tracked</span>
            )}
            {(result.updatedApplications ?? 0) > 0 && (
              <span className="text-emerald-400">{result.updatedApplications} apps updated</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
