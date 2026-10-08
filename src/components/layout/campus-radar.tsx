'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, FileText, RefreshCw } from 'lucide-react';
import { cn, timeAgo } from '@/lib/utils';
import { useSync } from '@/context/sync-context';
import { getSharedStatusPollDelay } from '@/lib/sync/progress/shared-status-polling';

interface SharedCollegeStatus {
  inbox: string | null;
  connected: boolean;
  isSyncing: boolean;
  recentlyUpdated: boolean;
  watchActive: boolean;
  scheduledSweepEnabled: boolean;
  complete: boolean;
  hasMoreArchivePages: boolean;
  pendingMessages: number;
  updatedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  canonicalEmails: number;
}

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
    isPaused,
    syncResult,
  } = useSync();
  const [sharedStatus, setSharedStatus] = useState<SharedCollegeStatus | null>(null);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: number | null = null;
    let initialTimer: number | null = null;
    let controller: AbortController | null = null;
    let wasHidden = document.visibilityState === 'hidden';

    const clearScheduledPoll = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const poll = async () => {
      if (disposed || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      controller = new AbortController();
      try {
        const response = await fetch('/api/sync/shared-status', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Shared status returned ${response.status}`);
        const payload = await response.json();
        if (disposed) return;
        const status = (payload.status || null) as SharedCollegeStatus | null;
        setSharedStatus(status);
        const delay = getSharedStatusPollDelay(status);
        if (delay !== null && !disposed) timer = window.setTimeout(() => void poll(), delay);
      } catch {
        // Retry a failed status read at the queued-work cadence. Only one retry timer exists.
        if (!disposed && !controller.signal.aborted) timer = window.setTimeout(() => void poll(), 10_000);
      } finally {
        inFlight = false;
        controller = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        wasHidden = true;
        clearScheduledPoll();
        return;
      }
      if (!wasHidden) return;
      wasHidden = false;
      if (initialTimer !== null) {
        window.clearTimeout(initialTimer);
        initialTimer = null;
      }
      clearScheduledPoll();
      void poll();
    };

    initialTimer = window.setTimeout(() => {
      initialTimer = null;
      void poll();
    }, 0);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      disposed = true;
      if (initialTimer !== null) window.clearTimeout(initialTimer);
      clearScheduledPoll();
      controller?.abort();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const currentPage = (syncProgress?.currentPageIndex ?? 0) + 1;
  const totalPages = syncProgress?.totalPagesCount ?? 1;
  const hasMultiplePages = totalPages > 1;
  const isSharedMatching = isSyncing && (
    syncProgress?.accountType === 'shared' ||
    /matching shared college shortlist archive/i.test(syncProgress?.currentSubject || '')
  );
  const personalSyncActive = isSyncing && !isSharedMatching;
  const personalStatus = personalSyncActive
    ? syncProgress?.phase === 'fetching' ? 'Checking Gmail' : 'Syncing'
    : isSharedMatching ? 'Inbox scan complete'
    : isPaused ? 'Paused' : 'Idle';
  const sharedProcessing = Boolean(sharedStatus?.isSyncing || isSharedMatching);
  // Distinguish: truly ingesting (has work to do) vs idle lease check (queue=0, no archive pages)
  const sharedActuallyIngesting = sharedProcessing && (
    isSharedMatching ||
    (sharedStatus?.pendingMessages ?? 0) > 0 ||
    Boolean(sharedStatus?.hasMoreArchivePages)
  );
  const personalProgress = syncProgress && syncProgress.totalMessages > 0
    ? Math.min(100, Math.round((syncProgress.processedMessages / syncProgress.totalMessages) * 100))
    : progressPercent;
  const personalActivity = syncProgress?.phase === 'fetching'
    ? syncProgress.totalMessages > 0
      ? `${syncProgress.totalMessages} matching messages found · checking saved mail`
      : 'Searching Personal Gmail for placement updates…'
    : syncProgress?.currentSubject && !/matching shared college shortlist archive/i.test(syncProgress.currentSubject)
      ? syncProgress.currentSubject
      : (syncProgress?.newEmails || 0) > 0
        ? `${syncProgress?.newEmails} new placement updates found so far`
        : (syncProgress?.skippedDuplicates || 0) > 0
          ? `${syncProgress?.skippedDuplicates} saved messages checked · no duplicate imports`
          : 'Checking saved placement emails across your Personal Gmail pages…';

  return (
    <div
      className={cn(
        'rounded-2xl border p-3 transition-all duration-300 shadow-md select-none',
        personalSyncActive || sharedActuallyIngesting
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
                'absolute inline-flex h-full w-full rounded-full opacity-75',
                personalSyncActive || sharedActuallyIngesting ? 'animate-ping bg-emerald-400' : 'bg-zinc-500'
              )}
            />
            <span className={cn('relative inline-flex h-2 w-2 rounded-full', personalSyncActive || sharedActuallyIngesting ? 'bg-emerald-400' : 'bg-zinc-500')} />
          </span>
          <span className="tracking-tight font-medium">Sync Radar</span>
        </div>

        {personalSyncActive ? (
          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/35 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-mono font-semibold text-emerald-300">
              <RefreshCw className="h-2.5 w-2.5 text-emerald-400 animate-spin shrink-0" />
              <span>{hasMultiplePages ? `P${currentPage}/${totalPages}` : 'Syncing'}</span>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => startSync(false)}
            disabled={isSyncing}
            className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-mono text-emerald-300 hover:bg-emerald-500/20 active:scale-95 transition-all cursor-pointer disabled:opacity-50"
            title={lastSyncAt ? `Last Personal Gmail sync ${timeAgo(lastSyncAt)}` : 'Sync Gmail'}
          >
            <RefreshCw className="h-3 w-3 text-emerald-400" />
            <span>Sync</span>
          </button>
        )}
      </div>

      {personalSyncActive ? (
        <div className="mt-2 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.035] px-2.5 py-2" aria-live="polite">
          <div className="flex items-center gap-2">
            <RefreshCw className="h-3 w-3 shrink-0 animate-spin text-emerald-400" />
            <span className="truncate text-[10px] font-medium text-emerald-200" title={personalActivity}>{personalActivity}</span>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[9px] text-zinc-500">
            <span className="truncate">Global sync · {hasMultiplePages ? `page ${currentPage} of ${totalPages}` : 'your drives remain available'}</span>
            {syncProgress?.phase === 'fetching' && syncProgress.totalMessages > 0 ? (
              <span className="shrink-0">{syncProgress.totalMessages} matches to check</span>
            ) : syncProgress && syncProgress.totalMessages > 0 ? (
              <span className="shrink-0 font-mono">{syncProgress.processedMessages}/{syncProgress.totalMessages}</span>
            ) : null}
          </div>
          {!['initializing', 'fetching'].includes(syncProgress?.phase || '') && (
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
              <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${Math.max(personalProgress, 5)}%` }} />
            </div>
          )}
          {syncProgress?.phase === 'fetching' && syncProgress.totalMessages > 0 && (
            <div className="mt-2 flex items-start gap-1.5 rounded-md border border-zinc-800/90 bg-black/25 px-2 py-1.5 text-[9px] leading-snug text-zinc-400">
              <FileText className="mt-px h-3 w-3 shrink-0 text-emerald-500" />
              <span>Matching messages are checked against saved mail; they aren’t all new imports.</span>
            </div>
          )}
        </div>
      ) : (
      <div className={cn('mt-2.5 space-y-2', compact && 'mt-2')}>
        <section className="rounded-xl border border-emerald-500/15 bg-black/20 px-2.5 py-2" aria-label="Personal Gmail sync status">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', personalSyncActive ? 'animate-pulse bg-emerald-400' : isPaused ? 'bg-amber-400' : 'bg-zinc-600')} />
              <span className="text-[10px] font-semibold text-zinc-200">Personal Gmail</span>
            </div>
            <span className={cn('truncate text-right text-[9px] font-medium', personalSyncActive ? 'text-emerald-300' : isPaused ? 'text-amber-300' : 'text-zinc-500')}>
              {personalStatus}{!personalSyncActive && lastSyncAt ? ` · ${timeAgo(lastSyncAt)}` : ''}
            </span>
          </div>
          {personalSyncActive && (
            syncProgress?.phase === 'fetching' && syncProgress.totalMessages > 0 ? (
              <p className="mt-1.5 text-[9px] text-zinc-500">
                {syncProgress.totalMessages} matching messages found · checking saved emails
              </p>
            ) : (
            <div className="mt-1.5 space-y-1">
              <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
                <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${Math.max(personalProgress, 5)}%` }} />
              </div>
              <div className="flex items-center justify-between gap-2 text-[9px] text-zinc-500">
                <span className="truncate">
                  {syncProgress?.phase === 'initializing' ? 'Connecting…' : syncProgress?.phase === 'fetching' ? 'Scanning Personal Gmail…' : 'Checking saved mail…'}
                  {hasMultiplePages ? ` · Page ${currentPage}/${totalPages}` : ''}
                </span>
                {syncProgress && syncProgress.totalMessages > 0 && (
                  <span className="shrink-0 font-mono">
                    {syncProgress.phase === 'fetching'
                      ? `${syncProgress.totalMessages} matches`
                      : `${syncProgress.processedMessages}/${syncProgress.totalMessages}`}
                  </span>
                )}
              </div>
              {syncProgress?.phase === 'fetching' && (syncProgress.totalMessages > 0) ? (
                <p className="text-[9px] text-zinc-500">Matching messages are checked against saved mail; they aren’t all new imports.</p>
              ) : syncProgress?.skippedDuplicates ? (
                <p className="text-[9px] text-zinc-500">{syncProgress.skippedDuplicates} already saved · skipped</p>
              ) : null}
              {syncProgress?.currentSubject && !/matching shared college shortlist archive/i.test(syncProgress.currentSubject) && (
                <p className="truncate text-[9px] text-zinc-500" title={syncProgress.currentSubject}>{syncProgress.currentSubject}</p>
              )}
              {((syncProgress?.newEmails ?? 0) > 0 || (syncProgress?.newCompanies ?? 0) > 0) && (
                <p className="text-[9px] text-emerald-400">+{syncProgress?.newEmails ?? 0} updates · +{syncProgress?.newCompanies ?? 0} drives</p>
              )}
            </div>
            )
          )}
          {!personalSyncActive && syncResult?.show && syncResult.success && (
            <div className="mt-1 flex items-center gap-1 text-[9px] text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> {syncResult.newEmails} updates · {syncResult.newCompanies} drives indexed
            </div>
          )}
        </section>

        {sharedProcessing && (
          sharedActuallyIngesting ? (
            <div className="flex items-center gap-1.5 rounded-md border border-emerald-500/15 bg-emerald-500/[0.025] px-2 py-1.5 text-[9px] text-emerald-300" aria-live="polite">
              <RefreshCw className="h-2.5 w-2.5 shrink-0 animate-spin" />
              <span className="truncate">{isSharedMatching ? 'Matching cached College updates to your drives…' : 'New College updates are processing in the background…'}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-1 py-1 text-[9px] text-zinc-500" aria-live="polite">
              <RefreshCw className="h-2.5 w-2.5 shrink-0 animate-spin opacity-50" />
              <span className="truncate">Checking college inbox for new circulars…</span>
            </div>
          )
        )}
      </div>
      )}

      {!personalSyncActive && !sharedProcessing && sharedStatus &&
        (sharedStatus.lastError || (sharedStatus.pendingMessages ?? 0) > 0) && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md border border-zinc-800 bg-black/20 px-2 py-1.5 text-[9px] leading-snug text-zinc-400">
            <FileText className="mt-px h-3 w-3 shrink-0 text-emerald-500" />
            <span>
              {sharedStatus.lastError
                ? 'College data processing needs attention.'
                : `${sharedStatus.pendingMessages} College updates queued for matching to your Personal-evidenced drives.`}
            </span>
          </div>
        )}
    </div>
  );
}
