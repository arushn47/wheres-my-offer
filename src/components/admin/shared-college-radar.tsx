'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database, Mail, RefreshCw, Radio, WifiOff } from 'lucide-react';
import { cn, timeAgo } from '@/lib/utils';

interface IngesterStatus {
  inbox: string | null;
  connected: boolean;
  isSyncing: boolean;
  phase: string;
  initialScanComplete: boolean;
  hasMoreArchivePages: boolean;
  pendingMessages: number;
  updatedAt: string | null;
  lastSyncAt: string | null;
  lastHistoryId: string | null;
  lastError: string | null;
  canonicalEmails: number;
  attachments: number;
  failedAttachments: number;
  unsupportedAttachments: number;
}

export default function SharedCollegeRadar() {
  const [status, setStatus] = useState<IngesterStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/canonical/ingester', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Ingester status unavailable');
      setStatus(payload.ingester || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ingester status unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const healthy = Boolean(status?.connected && !error && !status.lastError);
  const statusLabel = status?.isSyncing
    ? 'Ingesting'
    : !status?.connected
      ? 'Inbox disconnected'
      : status?.initialScanComplete && !status.hasMoreArchivePages
        ? 'Watching for updates'
        : 'Initial archive scan';

  return (
    <section className="rounded-2xl border border-cyan-500/20 bg-zinc-900/70 p-3.5 shadow-md" aria-label="Shared College ingester status">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-zinc-200">
          <span className="relative flex h-2 w-2 shrink-0">
            {status?.isSyncing && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />}
            <span className={cn('relative inline-flex h-2 w-2 rounded-full', healthy ? 'bg-cyan-400' : 'bg-amber-400')} />
          </span>
          <span className="truncate">College Ingester</span>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded-md p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
          aria-label="Refresh College ingester status"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </button>
      </div>

      {status ? (
        <div className="mt-3 space-y-2 text-[10px]">
          <div className="flex items-center gap-1.5 text-zinc-300" title={status.inbox || undefined}>
            <Mail className="h-3 w-3 shrink-0 text-cyan-300" />
            <span className="truncate">{status.inbox || 'No shared inbox configured'}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className={cn('truncate font-semibold', status.isSyncing ? 'text-cyan-300' : healthy ? 'text-emerald-300' : 'text-amber-300')}>
              {statusLabel}
            </span>
            <span className="shrink-0 text-zinc-500">{status.lastSyncAt ? timeAgo(status.lastSyncAt) : 'Not synced'}</span>
          </div>
          {status.hasMoreArchivePages && (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1 text-amber-200">
              Archive pages remain; next page is queued for the worker.
            </div>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-2">
              <div className="flex items-center gap-1 text-zinc-500"><Database className="h-3 w-3" /> Canonical</div>
              <div className="mt-1 font-mono font-semibold text-zinc-200">{status.canonicalEmails.toLocaleString()}</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-2">
              <div className="flex items-center gap-1 text-zinc-500"><Radio className="h-3 w-3" /> Queue</div>
              <div className="mt-1 font-mono font-semibold text-zinc-200">
                {status.pendingMessages.toLocaleString()}{status.hasMoreArchivePages ? '+' : ''}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between text-zinc-500">
            <span>{status.attachments.toLocaleString()} attachments</span>
            <span className={status.failedAttachments ? 'text-amber-300' : 'text-emerald-400'}>
              {status.failedAttachments ? `${status.failedAttachments} need review` : `${status.unsupportedAttachments} unsupported`}
            </span>
          </div>
          {status.lastError && (
            <div className="flex gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 p-2 text-amber-200" title={status.lastError}>
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="line-clamp-2">{status.lastError}</span>
            </div>
          )}
          {!status.lastError && status.connected && (
            <div className="flex items-center gap-1 text-zinc-500">
              <CheckCircle2 className="h-3 w-3 text-emerald-400" />
              <span>Shared archive only · student sync stays Personal</span>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-1.5 text-[10px] text-zinc-500">
          <WifiOff className="h-3 w-3" />
          {error || (loading ? 'Loading ingester status…' : 'No shared ingester state found')}
        </div>
      )}
      {status?.updatedAt && <div className="mt-2 text-right text-[9px] text-zinc-600">State refreshed {timeAgo(status.updatedAt)}</div>}
    </section>
  );
}
