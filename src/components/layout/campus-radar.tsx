'use client';

import { RefreshCw, CheckCircle2, Radio, Layers, Sparkles } from 'lucide-react';
import { cn, timeAgo } from '@/lib/utils';
import { useSync } from '@/context/sync-context';

export interface CampusRadarProps {
  className?: string;
  compact?: boolean;
}

/**
 * CampusRadar Component
 * Dedicated placement scanning radar & sync station.
 * Provides high-fidelity live telemetry during syncs (pages, accounts, email counters, live subjects)
 * and seamless background status tracking.
 */
export default function CampusRadar({ className, compact = false }: CampusRadarProps) {
  const {
    isSyncing,
    syncProgress,
    progressPercent,
    lastSyncAt,
    startSync,
    syncResult,
  } = useSync();

  const currentPage = (syncProgress?.currentPageIndex ?? 0) + 1;
  const totalPages = syncProgress?.totalPagesCount ?? 1;
  const hasMultiplePages = totalPages > 1;

  return (
    <div
      className={cn(
        'rounded-2xl border p-3.5 transition-all duration-300 shadow-md select-none',
        isSyncing
          ? 'border-emerald-500/40 bg-emerald-950/25 shadow-[0_0_24px_rgba(16,185,129,0.12)]'
          : 'border-zinc-800/90 bg-zinc-900/50 hover:border-zinc-700/80',
        className
      )}
    >
      {/* Header Row: Radar status badge & Sync button */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
          <span className="relative flex h-2 w-2">
            <span
              className={cn(
                'absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75',
                isSyncing ? 'animate-ping' : 'animate-ping'
              )}
            />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          </span>
          <span className="tracking-tight font-medium">Campus Radar</span>
        </div>

        {isSyncing ? (
          <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/35 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-mono font-semibold text-emerald-300">
            <RefreshCw className="h-2.5 w-2.5 text-emerald-400 animate-spin shrink-0" />
            <span>
              {hasMultiplePages
                ? `P${currentPage}/${totalPages}`
                : progressPercent > 0
                  ? `${progressPercent}%`
                  : 'Syncing'}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => startSync(false)}
            disabled={isSyncing}
            className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-mono text-emerald-300 hover:bg-emerald-500/20 active:scale-95 transition-all cursor-pointer disabled:opacity-50"
            title={
              lastSyncAt
                ? `Last synced ${timeAgo(lastSyncAt)} · Click to rescan inboxes`
                : 'Click to sync Gmail inboxes'
            }
          >
            <RefreshCw className="h-3 w-3 text-emerald-400" />
            <span>Sync</span>
          </button>
        )}
      </div>

      {/* Active Live Sync Telemetry */}
      {isSyncing ? (
        <div className="mt-3 space-y-2.5 animate-fade-in">
          {/* Animated Progress Bar */}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800/90">
            <div
              className="h-full bg-linear-to-r from-emerald-500 via-teal-400 to-emerald-300 transition-all duration-300 shadow-[0_0_8px_rgba(52,211,153,0.7)]"
              style={{ width: `${Math.max(progressPercent, 6)}%` }}
            />
          </div>

          {/* Page Badge & Count Row */}
          <div className="flex items-center justify-between text-[10px] font-mono">
            <div className="flex items-center gap-1.5 min-w-0">
              {hasMultiplePages && (
                <span className="shrink-0 px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 font-bold text-[9px]">
                  PAGE {currentPage}/{totalPages}
                </span>
              )}
              <span className="truncate text-emerald-400 font-medium">
                {syncProgress?.phase === 'initializing'
                  ? 'Connecting inboxes…'
                  : syncProgress?.phase === 'fetching'
                    ? `Scanning ${syncProgress.accountType === 'personal' ? 'Personal' : 'College'}…`
                    : syncProgress?.phase === 'processing'
                      ? `${syncProgress.accountType === 'personal' ? 'Personal' : 'College'} Inbox`
                      : syncProgress?.phase === 'complete'
                        ? 'Finalizing index…'
                        : 'Syncing inboxes…'}
              </span>
            </div>

            {syncProgress && syncProgress.totalMessages > 0 && (
              <span className="text-zinc-400 shrink-0 ml-1 font-semibold">
                {syncProgress.processedMessages}/{syncProgress.totalMessages}
              </span>
            )}
          </div>

          {/* Live Subject Snippet */}
          {syncProgress?.currentSubject && (
            <div className="flex items-center gap-1.5 rounded-lg bg-black/50 border border-zinc-800/80 px-2.5 py-1.5 text-[10px] font-mono text-zinc-300">
              <span className="text-emerald-400 shrink-0">📄</span>
              <span className="truncate">{syncProgress.currentSubject}</span>
            </div>
          )}

          {/* Discovered Drives & Updates Badge */}
          {((syncProgress?.newEmails ?? 0) > 0 || (syncProgress?.newCompanies ?? 0) > 0) && (
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-emerald-400/90 pt-0.5">
              <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span>+{syncProgress?.newEmails} updates</span>
              {(syncProgress?.newCompanies ?? 0) > 0 && (
                <span>· +{syncProgress?.newCompanies} companies</span>
              )}
            </div>
          )}
        </div>
      ) : syncResult?.show && syncResult.success ? (
        /* Completed Result Banner */
        <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1.5 text-[10px] font-mono text-emerald-300 animate-fade-in">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
          <span className="truncate">
            {syncResult.newEmails} updates · {syncResult.newCompanies} companies indexed
          </span>
        </div>
      ) : (
        /* Idle Telemetry View */
        <div className="mt-2.5 space-y-1.5">
          <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
            <span>{lastSyncAt ? `Synced ${timeAgo(lastSyncAt)}` : 'Live radar active'}</span>
            <span className="text-emerald-400/80 font-medium">15m cron</span>
          </div>
          <p className="text-[10px] text-zinc-500 leading-tight">
            Continuous radar indexing official CDC announcements and test circulars.
          </p>
        </div>
      )}
    </div>
  );
}
