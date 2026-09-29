'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { appToast } from '@/components/ui/toast';
import { createClient } from '@/lib/supabase/client';
import { getStatusUpdatePhase } from '@/lib/sync/status-display';

export interface SyncProgress {
  phase: 'initializing' | 'fetching' | 'processing' | 'complete' | 'error';
  accountEmail: string;
  accountType: string;
  totalMessages: number;
  processedMessages: number;
  alreadyIndexed?: number;
  remainingMessages?: number;
  isResuming?: boolean;
  newEmails: number;
  newCompanies: number;
  skippedDuplicates: number;
  errors: string[];
  currentSubject?: string;
  statusUpdatesPending?: boolean;
  isInitialSync?: boolean;
  currentPageIndex?: number;
  totalPagesCount?: number;
  isPage0Complete?: boolean;
}

export interface SyncResult {
  show: boolean;
  success: boolean;
  message: string;
  newEmails: number;
  newCompanies: number;
  statusUpdatesCompleted?: boolean;
  statusUpdatesPending?: boolean;
}

interface SyncContextValue {
  isSyncing: boolean;
  statusUpdatesPending: boolean;
  statusUpdatePhase: 'personal' | 'personal_scan' | 'college' | 'college_matching' | 'recalculate' | 'status_recalculation' | 'complete';
  statusChecksComplete: boolean;
  syncProgress: SyncProgress | null;
  progressPercent: number;
  lastSyncAt: string | null;
  startSync: (silent?: boolean) => Promise<void>;
  pauseSync: () => Promise<void>;
  isPausing: boolean;
  isPaused: boolean;
  syncResult: SyncResult | null;
  dismissResult: () => void;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({
  children,
  initialLastSyncAt,
}: {
  children: React.ReactNode;
  initialLastSyncAt?: string | null;
}) {
  const router = useRouter();
  const [isSyncing, setIsSyncing] = useState(false);
  // No verification-tracking state anymore: statuses land directly on applications.
  // The pending/phase plumbing stays as always-false/complete so the UI keeps compiling
  // without any masking path being reachable.
  const [statusUpdatesPending] = useState(false);
  const [statusUpdatePhase, setStatusUpdatePhase] = useState<'personal' | 'personal_scan' | 'college' | 'college_matching' | 'recalculate' | 'status_recalculation' | 'complete'>('personal');
  const [statusChecksComplete, setStatusChecksComplete] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(initialLastSyncAt || null);
  const visibleStatusUpdatePhase = getStatusUpdatePhase(syncProgress?.currentSubject) || statusUpdatePhase;
  const lastSyncAtRef = useRef<string | null>(initialLastSyncAt || null);

  const isSyncingRef = useRef(false);
  const isSseActiveRef = useRef(false);
  const chainedTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const hasMountedAutoSyncRef = useRef(false);
  const activeAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (initialLastSyncAt) {
      setLastSyncAt(initialLastSyncAt);
      lastSyncAtRef.current = initialLastSyncAt;
    }
  }, [initialLastSyncAt]);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  // Fallback polling (60s) used ONLY when an external/background sync is active and SSE is NOT streaming
  const startPolling = useCallback((immediate: boolean = false) => {
    if (pollIntervalRef.current || isSseActiveRef.current) return;

    const poll = async () => {
      // Do not poll if tab is hidden or SSE stream has taken over
      if (document.visibilityState === 'hidden' || isSseActiveRef.current) return;

      try {
        const res = await fetch('/api/sync/status');
        if (!res.ok) return;
        const data = await res.json();

        if (data.lastSyncAt) {
          setLastSyncAt(data.lastSyncAt);
        }

        if (data.isSyncing) {
          /* statuses always visible */
          setIsSyncing(true);
          isSyncingRef.current = true;
          if (data.progress) {
            setSyncProgress(data.progress);
          }
        } else {
          if (data.phase === 'paused' || data.progress?.paused) {
            stopPolling();
            isSyncingRef.current = false;
            setIsSyncing(false);
            setIsPausing(false);
            setIsPaused(true);
            setSyncProgress(data.progress || null);
            return;
          }
          // If pending, a batch just finished and more pages are queued — resume immediately
          if (data.phase === 'pending') {
            stopPolling();
            handleSync(false, true);
            return;
          }

          // Sync has finished or is idle
          stopPolling();
          isSyncingRef.current = false;
          setIsSyncing(false);
          /* statuses always visible */
          setSyncProgress(data.statusUpdatesPending && data.progress ? data.progress : null);

          if (data.phase === 'complete') {
            const resultData = {
              show: true,
              success: true,
              message: data.statusUpdatesPending ? 'Status checks still updating' : 'Placement sync complete',
              newEmails: data.progress?.newEmails || 0,
              newCompanies: data.progress?.newCompanies || 0,
              statusUpdatesPending: Boolean(data.statusUpdatesPending),
            };
            setSyncResult(resultData);
            appToast.sync(
              resultData.message,
              resultData.statusUpdatesPending
                ? 'Shortlist checks were deferred; provisional statuses are still being held back.'
                : `${resultData.newEmails} new updates · ${resultData.newCompanies} companies indexed`
            );
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('wmo:refresh_notifications'));
            }
            router.refresh();
            if (!resultData.statusUpdatesPending) setTimeout(() => setSyncResult(null), 5000);
          }
        }
      } catch {
        // Ignore polling errors
      }
    };

    if (immediate) {
      poll();
    }
    // Dynamic 2.5-second polling interval while sync is active to instantly reflect completion
    pollIntervalRef.current = setInterval(poll, 2500);
  }, [router, stopPolling]);

  // Clean up polling interval, chained timeouts, and active fetch on unmount
  useEffect(() => {
    return () => {
      stopPolling();
      if (chainedTimeoutRef.current) {
        clearTimeout(chainedTimeoutRef.current);
        chainedTimeoutRef.current = null;
      }
      if (activeAbortControllerRef.current) {
        activeAbortControllerRef.current.abort();
        activeAbortControllerRef.current = null;
      }
    };
  }, [stopPolling]);

  const handleSync = useCallback(
    async (silent: boolean = false, isChained: boolean = false) => {
      if (isSyncingRef.current && !isChained) return;
      setIsPaused(false);
      setIsPausing(false);
      /* statuses always visible */
      setStatusChecksComplete(false);
      setStatusUpdatePhase('personal');
      isSyncingRef.current = true;
      setIsSyncing(true);
      setSyncResult(null);

      let willAdvanceNextChunk = false;

      if (!silent && !isChained) {
        setSyncProgress({
          phase: 'initializing',
          accountEmail: '',
          accountType: '',
          totalMessages: 0,
          processedMessages: 0,
          newEmails: 0,
          newCompanies: 0,
          skippedDuplicates: 0,
          errors: [],
        });
      }

      if (activeAbortControllerRef.current) {
        activeAbortControllerRef.current.abort();
        activeAbortControllerRef.current = null;
      }

      const abortController = new AbortController();
      activeAbortControllerRef.current = abortController;

      try {
        const response = await fetch('/api/sync', {
          method: 'POST',
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error('Sync request failed');
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response stream');

        isSseActiveRef.current = true;
        const decoder = new TextDecoder();
        let buffer = '';
        let receivedComplete = false;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Split by standard SSE double-newline delimiter
            const messages = buffer.split('\n\n');
            buffer = messages.pop() || '';

            for (const message of messages) {
              const lines = message.split('\n');
              let currentEvent = '';
              let currentData = '';

              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  currentEvent = line.slice(7).trim();
                } else if (line.startsWith('data: ')) {
                  currentData = line.slice(6).trim();
                }
              }

              if (currentEvent && currentData) {
                try {
                  const parsed = JSON.parse(currentData);

                  if (currentEvent === 'sync_active' || currentEvent === 'active') {
                    // A background sync is already actively running
                    startPolling(true);
                    return;
                  }

                  if (currentEvent === 'progress' || currentEvent === 'sync_progress') {
                    setSyncProgress((prev) => {
                      if (silent && parsed.phase !== 'processing' && !prev) {
                        return null;
                      }
                      return parsed;
                    });
                  } else if (currentEvent === 'complete' || currentEvent === 'sync_complete') {
                    if (receivedComplete) return;
                    receivedComplete = true;
                    stopPolling();
                    if (parsed.lastSyncAt || parsed.result?.lastSyncAt) {
                      setLastSyncAt(parsed.lastSyncAt || parsed.result?.lastSyncAt);
                    }
                    if (parsed.result?.paused || parsed.result?.hasMorePagesPending) {
                      if (parsed.result?.paused) {
                         stopPolling();
                         isSyncingRef.current = false;
                         setIsSyncing(false);
                         setIsPausing(false);
                         setIsPaused(true);
                         setSyncProgress((prev) => prev ? { ...prev, phase: 'processing', currentSubject: 'Paused at saved checkpoint' } : null);
                        return;
                       }
                       willAdvanceNextChunk = true;
                      setSyncProgress((prev) =>
                        prev
                          ? {
                              ...prev,
                              currentSubject: 'Chunk checkpointed. Advancing to next batch...',
                            }
                          : null
                      );
                      if (chainedTimeoutRef.current) clearTimeout(chainedTimeoutRef.current);
                      chainedTimeoutRef.current = setTimeout(() => {
                        chainedTimeoutRef.current = null;
                        handleSync(false, true);
                      }, 800);
                      return;
                    }

                    const newEmails = parsed.newEmails ?? parsed.result?.newEmails ?? 0;
                    const newCompanies = parsed.newCompanies ?? parsed.result?.newCompanies ?? 0;
                    const statusesUpdated = Boolean(
                      parsed.result?.statusUpdatesCompleted ||
                      /drive statuses updated/i.test(syncProgress?.currentSubject || '')
                    );
                    const statusUpdatesPending = Boolean(parsed.result?.statusUpdatesPending);
                    const observedPhase = getStatusUpdatePhase(syncProgress?.currentSubject);
                    if (statusesUpdated || observedPhase === 'complete') setStatusUpdatePhase('complete');
                    else if (observedPhase === 'college_matching') setStatusUpdatePhase('college_matching');
                    else if (observedPhase === 'status_recalculation') setStatusUpdatePhase('status_recalculation');
                    else if (observedPhase === 'personal_scan') setStatusUpdatePhase('personal_scan');
                    setStatusChecksComplete(statusesUpdated);
                    /* statuses always visible */
                    isSyncingRef.current = false;
                    setIsSyncing(false);
                    setSyncProgress(statusUpdatesPending && syncProgress
                      ? { ...syncProgress, currentSubject: 'Status checks pending' }
                      : null);
                    const resultData: SyncResult = {
                      show: true,
                      success: true,
                      message: statusesUpdated
                        ? 'Drive statuses updated'
                        : statusUpdatesPending
                          ? 'Personal sync complete · status checks pending'
                          : 'Personal sync complete',
                      newEmails,
                      newCompanies,
                      statusUpdatesCompleted: statusesUpdated,
                      statusUpdatesPending,
                    };
                    setSyncResult(resultData);
                    appToast.sync(
                      resultData.message,
                      statusesUpdated
                        ? `${newEmails} new updates · shortlist results refreshed`
                        : statusUpdatesPending
                          ? `${newEmails} new updates · shortlist status checks are still pending`
                          : `${newEmails} new updates · ${newCompanies} companies indexed`
                    );
                    router.refresh();
                    if (!statusUpdatesPending) setTimeout(() => setSyncResult(null), 5000);
                  } else if (currentEvent === 'error' || currentEvent === 'sync_error') {
                    stopPolling();
                    setSyncProgress(null);
                    const errorMsg = parsed.message || 'Sync encountered an issue';
                    setSyncResult({
                      show: true,
                      success: false,
                      message: errorMsg,
                      newEmails: 0,
                      newCompanies: 0,
                    });
                    appToast.error('Sync error', errorMsg);
                    setTimeout(() => setSyncResult(null), 8000);
                  }
                } catch {
                  // Ignore malformed JSON
                }
              }
            }
          }
        } finally {
          isSseActiveRef.current = false;
          try {
            await reader.cancel();
          } catch {
            // Stream already finished or cancelled
          }
          try {
            reader.releaseLock();
          } catch {
            // Lock already released
          }
        }

        if (isSyncingRef.current && !receivedComplete) {
          try {
            const res = await fetch('/api/sync/status');
            if (res.ok) {
              const data = await res.json();
              if (data.lastSyncAt) {
                setLastSyncAt(data.lastSyncAt);
              }
              if (data.isSyncing) {
                /* statuses always visible */
                startPolling(true);
                return;
              }
              if (data.statusUpdatesPending && data.progress) {
                /* statuses always visible */
                setSyncProgress(data.progress);
              }
              if (data.phase === 'pending' && (data.progress?.paused || data.progress?.errors?.some((error: string) => error.startsWith('Paused by user')))) {
                stopPolling();
                setIsSyncing(false);
                isSyncingRef.current = false;
                setIsPausing(false);
                setIsPaused(true);
                setSyncProgress(data.progress ? { ...data.progress, phase: 'processing' } : null);
                router.refresh();
                return;
              }
              if (data.phase === 'pending') {
                willAdvanceNextChunk = true;
                if (chainedTimeoutRef.current) clearTimeout(chainedTimeoutRef.current);
                chainedTimeoutRef.current = setTimeout(() => {
                  chainedTimeoutRef.current = null;
                  handleSync(false, true);
                }, 800);
                return;
              }
              if (data.phase === 'paused' || data.progress?.paused) {
                stopPolling();
                setIsSyncing(false);
                isSyncingRef.current = false;
                setIsPausing(false);
                setIsPaused(true);
                setSyncProgress(data.progress ? { ...data.progress, phase: 'processing' } : null);
                router.refresh();
                return;
              }
              if (data.phase === 'complete') {
                stopPolling();
                setIsSyncing(false);
                isSyncingRef.current = false;
                /* statuses always visible */
                setSyncProgress(null);
                const resultData = {
                  show: true,
                  success: true,
                  message: 'Placement sync complete',
                  newEmails: data.progress?.newEmails || 0,
                  newCompanies: data.progress?.newCompanies || 0,
                };
                setSyncResult(resultData);
                appToast.sync(
                  'Placement sync complete',
                  `${resultData.newEmails} new updates · ${resultData.newCompanies} companies indexed`
                );
                router.refresh();
                setTimeout(() => setSyncResult(null), 5000);
                return;
              }
            }
          } catch {}
          setSyncProgress(null);
        }
      } catch (err: unknown) {
        // If aborted deliberately (e.g. navigation or next chunk), exit cleanly without error toast
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }

        // Before showing a network error toast, check if the server is actively syncing, checkpointed, or completed
        try {
          const res = await fetch('/api/sync/status');
          if (res.ok) {
            const data = await res.json();
            if (data.isSyncing) {
              startPolling(true);
              return;
            }
            if (data.phase === 'pending' && (data.progress?.paused || data.progress?.errors?.some((error: string) => error.startsWith('Paused by user')))) {
                stopPolling();
                setIsSyncing(false);
                isSyncingRef.current = false;
                setIsPausing(false);
                setIsPaused(true);
                setSyncProgress(data.progress || null);
                router.refresh();
                return;
            }
            if (data.phase === 'pending') {
              willAdvanceNextChunk = true;
              if (chainedTimeoutRef.current) clearTimeout(chainedTimeoutRef.current);
              chainedTimeoutRef.current = setTimeout(() => {
                chainedTimeoutRef.current = null;
                handleSync(false, true);
              }, 800);
              return;
            }
              if (data.phase === 'complete') {
                stopPolling();
                setIsSyncing(false);
                isSyncingRef.current = false;
                /* statuses always visible */
                setSyncProgress(data.statusUpdatesPending ? data.progress || null : null);
                const resultData = {
                  show: true,
                  success: true,
                  message: data.statusUpdatesPending ? 'Status checks still updating' : 'Placement sync complete',
                  newEmails: data.progress?.newEmails || 0,
                  newCompanies: data.progress?.newCompanies || 0,
                  statusUpdatesPending: Boolean(data.statusUpdatesPending),
                };
                setSyncResult(resultData);
                appToast.sync(
                  resultData.message,
                  resultData.statusUpdatesPending
                    ? 'Shortlist checks were deferred; provisional statuses are still being held back.'
                    : `${resultData.newEmails} new updates · ${resultData.newCompanies} companies indexed`
                );
                router.refresh();
                if (!resultData.statusUpdatesPending) setTimeout(() => setSyncResult(null), 5000);
              return;
            }
          }
        } catch {}

        stopPolling();
        setSyncProgress(null);
        const errorMsg = err instanceof Error ? err.message : 'Sync failed';
        setSyncResult({
          show: true,
          success: false,
          message: errorMsg,
          newEmails: 0,
          newCompanies: 0,
        });
        appToast.error('Sync failed', errorMsg);
        setTimeout(() => setSyncResult(null), 8000);
      } finally {
        if (activeAbortControllerRef.current === abortController) {
          activeAbortControllerRef.current = null;
        }
        if (!willAdvanceNextChunk) {
          isSyncingRef.current = false;
          setIsSyncing(false);
        }
      }
    },
    [router, startPolling, stopPolling, syncProgress?.isInitialSync]
  );

  // On mount: check if a sync is already running in the background
  useEffect(() => {
    if (hasMountedAutoSyncRef.current) return;
    hasMountedAutoSyncRef.current = true;

    fetch('/api/sync/status')
      .then((res) => res.json())
      .then((data) => {
        if (data.lastSyncAt) {
          setLastSyncAt(data.lastSyncAt);
        }
            if (data.isSyncing) {
              setIsSyncing(true);
              /* statuses always visible */
              isSyncingRef.current = true;
          if (data.progress) {
            setSyncProgress(data.progress);
          }
          startPolling();
        } else if (data.statusUpdatesPending && data.progress) {
          /* statuses always visible */
          setSyncProgress(data.progress);
        }
      })
      .catch(() => {});
  }, [startPolling]);

  // Page Visibility guard: pause polling when tab is hidden, check once when visible
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'hidden') {
        // Immediately halt fallback polling when user minimizes or switches tabs
        stopPolling();
      } else if (document.visibilityState === 'visible') {
        if (isSseActiveRef.current) return;

        try {
          const res = await fetch('/api/sync/status');
          if (!res.ok) return;
          const data = await res.json();

          if (data.lastSyncAt) {
            setLastSyncAt(data.lastSyncAt);
          }

          if (data.isSyncing) {
            setIsSyncing(true);
            /* statuses always visible */
            isSyncingRef.current = true;
            if (data.progress) {
              setSyncProgress(data.progress);
            }
            startPolling();
            } else {
              stopPolling();
              /* statuses always visible */
            if (isSyncingRef.current) {
              isSyncingRef.current = false;
              setIsSyncing(false);
              router.refresh();
            }
              if (data.statusUpdatesPending && data.progress) setSyncProgress(data.progress);
              else if (!data.statusUpdatesPending) setSyncProgress(null);
            }
        } catch {}
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [router, startPolling, stopPolling]);

  // Listen for custom event 'start-placement-sync'
  useEffect(() => {
    const handleTriggerSync = () => {
      handleSync(false);
    };
    window.addEventListener('start-placement-sync', handleTriggerSync);
    return () => window.removeEventListener('start-placement-sync', handleTriggerSync);
  }, [handleSync]);

  // Supabase Realtime listener: instant updates when applications change
  useEffect(() => {
    let refreshDebounceTimer: NodeJS.Timeout | null = null;

    const scheduleRefresh = () => {
      // Don't trigger a page re-render while a sync is actively running via SSE
      // (the sync's own complete handler calls router.refresh())
      if (isSyncingRef.current) return;
      if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
      // Debounce 5s — coalesces batch DB writes (e.g. during background sync) into a single refresh
      refreshDebounceTimer = setTimeout(() => {
        refreshDebounceTimer = null;
        router.refresh();
      }, 5000);
    };

    try {
      const supabase = createClient();
      const channel = supabase
        .channel('schema-db-changes')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'applications' },
          scheduleRefresh
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'in_app_notifications' },
          () => {
            // Notify bell component directly via client event; avoid triggering full Server Component reload
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('wmo:refresh_notifications'));
            }
          }
        )
        .subscribe();

      return () => {
        if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
        supabase.removeChannel(channel);
      };
    } catch {
      // Ignore if realtime fails to initialize in unsupported environment
    }
  }, [router]);

  const progressPercent =
    syncProgress && syncProgress.totalMessages > 0
      ? Math.round((syncProgress.processedMessages / syncProgress.totalMessages) * 100)
      : 0;

  const dismissResult = useCallback(() => {
    setSyncResult(null);
  }, []);

  const pauseSync = useCallback(async () => {
    if (!isSyncingRef.current) return;
    setIsPausing(true);
    try {
      const response = await fetch('/api/sync/pause', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not pause sync');
    } catch (error) {
      setIsPausing(false);
      appToast.error('Pause failed', error instanceof Error ? error.message : 'Could not pause sync');
    }
  }, []);

  return (
    <SyncContext.Provider
      value={{
        isSyncing,
        statusUpdatesPending,
        statusUpdatePhase: visibleStatusUpdatePhase,
        statusChecksComplete,
        syncProgress,
        progressPercent,
        lastSyncAt,
        startSync: handleSync,
        pauseSync,
        isPausing,
        isPaused,
        syncResult,
        dismissResult,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
}

export function useSync() {
  const context = useContext(SyncContext);
  if (!context) {
    throw new Error('useSync must be used within a SyncProvider');
  }
  return context;
}
