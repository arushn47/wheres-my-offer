'use client';

import { useState } from 'react';
import {
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Users,
  Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ReprocessProgressState {
  isActive: boolean;
  mode: 'all' | 'user';
  currentUser?: string;
  currentUserIndex?: number;
  totalUsers?: number;
  step?: number;
  totalSteps?: number;
  stageMessage?: string;
  totalApplicationsUpdated?: number;
  recentLogs?: string[];
  error?: string | null;
  completed?: boolean;
}

export default function ReprocessProgressToast({
  state,
  onDismiss,
}: {
  state: ReprocessProgressState | null;
  onDismiss: () => void;
}) {
  const [minimized, setMinimized] = useState(false);

  if (!state || (!state.isActive && !state.completed)) return null;

  const totalUsers = state.totalUsers || 1;
  const currentIndex = state.currentUserIndex || 1;
  const currentStep = state.step || 1;
  const totalSteps = state.totalSteps || 5;

  const percent = state.mode === 'all'
    ? Math.min(100, Math.max(5, Math.round((((currentIndex - 1) * totalSteps + currentStep) / (totalUsers * totalSteps)) * 100)))
    : Math.min(100, Math.max(10, Math.round((currentStep / totalSteps) * 100)));

  return (
    <div className="fixed bottom-6 right-4 sm:right-6 z-50 max-w-md w-[calc(100vw-2rem)] sm:w-full animate-slide-up pointer-events-auto">
      <div
        className={cn(
          'bg-zinc-950/95 border rounded-2xl shadow-2xl backdrop-blur-xl transition-all duration-300 overflow-hidden',
          state.completed
            ? 'border-emerald-500/40 shadow-emerald-500/10'
            : state.error
            ? 'border-red-500/40 shadow-red-500/10'
            : 'border-indigo-500/40 shadow-indigo-500/10'
        )}
      >
        {/* Header Bar */}
        <div className="p-3.5 sm:p-4 flex items-center justify-between gap-3 bg-zinc-900/60 border-b border-zinc-800/80">
          <div className="flex items-center gap-2.5 min-w-0">
            {state.completed ? (
              <div className="w-8 h-8 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
                <CheckCircle2 className="w-4 h-4" />
              </div>
            ) : state.error ? (
              <div className="w-8 h-8 rounded-xl bg-red-500/15 border border-red-500/30 flex items-center justify-center text-red-400 shrink-0">
                <AlertCircle className="w-4 h-4" />
              </div>
            ) : (
              <div className="w-8 h-8 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0 relative">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-indigo-400 animate-ping" />
              </div>
            )}

            <div className="min-w-0">
              <h4 className="font-semibold text-white text-xs sm:text-sm truncate">
                {state.completed
                  ? 'Reprocess Completed'
                  : state.error
                  ? 'Reprocess Interrupted'
                  : state.mode === 'all'
                  ? `Reprocessing Students (${currentIndex}/${totalUsers})`
                  : `Reprocessing ${state.currentUser || 'Student'}`}
              </h4>
              <p className="text-[11px] text-zinc-400 truncate">
                {state.completed
                  ? `${state.totalApplicationsUpdated ?? 0} application stage(s) re-evaluated.`
                  : state.currentUser
                  ? `Active target: ${state.currentUser}`
                  : 'Multi-tenant placement pipeline'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {!state.completed && (
              <button
                type="button"
                onClick={() => setMinimized(!minimized)}
                className="p-1 text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800 transition-colors cursor-pointer"
                title={minimized ? 'Expand details' : 'Minimize'}
              >
                {minimized ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            )}

            {state.completed && (
              <button
                type="button"
                onClick={onDismiss}
                className="px-2.5 py-1 text-xs font-semibold text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-lg border border-zinc-700/60 transition-colors cursor-pointer"
              >
                Close
              </button>
            )}
          </div>
        </div>

        {/* Expandable Body */}
        {!minimized && (
          <div className="p-3.5 sm:p-4 space-y-3 font-sans">
            {/* Stage Badge & Step Message */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded-full">
                  <Sparkles className="w-3 h-3 text-indigo-400" />
                  Stage {currentStep} of {totalSteps}
                </span>

                <span className="font-mono text-xs text-zinc-400 font-bold">
                  {state.completed ? '100%' : `${percent}%`}
                </span>
              </div>

              <p className="text-xs text-zinc-200 font-medium leading-relaxed bg-zinc-900/80 p-2.5 rounded-xl border border-zinc-800/80 shadow-inner">
                {state.stageMessage || 'Initializing reprocess heuristics…'}
              </p>
            </div>

            {/* Glowing Animated Progress Bar */}
            <div className="w-full h-2 rounded-full bg-zinc-800/80 overflow-hidden relative">
              <div
                className={cn(
                  'h-full transition-all duration-300 rounded-full',
                  state.completed
                    ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]'
                    : 'bg-gradient-to-r from-indigo-500 via-purple-500 to-amber-500 shadow-[0_0_12px_rgba(99,102,241,0.6)]'
                )}
                style={{ width: `${state.completed ? 100 : percent}%` }}
              />
            </div>

            {/* Live Stats Ticker */}
            <div className="grid grid-cols-2 gap-2 text-xs pt-0.5">
              <div className="p-2 rounded-lg bg-zinc-900/50 border border-zinc-800/60 flex flex-col">
                <span className="text-[10px] text-zinc-500 uppercase font-semibold">Stage Updates</span>
                <span className="font-mono text-sm font-bold text-amber-300 mt-0.5">
                  {state.totalApplicationsUpdated ?? 0} applications
                </span>
              </div>

              <div className="p-2 rounded-lg bg-zinc-900/50 border border-zinc-800/60 flex flex-col">
                <span className="text-[10px] text-zinc-500 uppercase font-semibold">Pipeline Scope</span>
                <span className="font-mono text-sm font-bold text-indigo-300 mt-0.5">
                  {state.mode === 'all' ? `${totalUsers} Students` : 'Single Account'}
                </span>
              </div>
            </div>

            {/* Live Logs Stream */}
            {state.recentLogs && state.recentLogs.length > 0 && (
              <div className="space-y-1 pt-1">
                <span className="text-[10px] text-zinc-500 uppercase font-semibold tracking-wider">Completed Stages:</span>
                <div className="space-y-1 max-h-24 overflow-y-auto pr-1">
                  {state.recentLogs.slice(-3).map((log, i) => (
                    <div
                      key={i}
                      className="text-[11px] font-mono text-zinc-400 bg-zinc-950/60 border border-zinc-800/60 px-2 py-1 rounded truncate flex items-center gap-1.5"
                    >
                      <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                      <span className="truncate">{log}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
