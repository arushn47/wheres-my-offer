'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { appToast } from '@/lib/toast';
import { createClient } from '@/lib/supabase/client';

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
}

interface SyncContextValue {
  isSyncing: boolean;
  syncProgress: SyncProgress | null;
  progressPercent: number;
  lastSyncAt: string | null;
  startSync: (silent?: boolean) => Promise<void>;
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
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(initialLastSyncAt || null);
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
          setIsSyncing(true);
          isSyncingRef.current = true;
          if (data.progress) {
            setSyncProgress(data.progress);
          }
        } else {
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
          setSyncProgress(null);

          if (data.phase === 'complete') {
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
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('wmo:refresh_notifications'));
            }
            router.refresh();
            setTimeout(() => setSyncResult(null), 5000);
          }
        }
      } catch {
        // Ignore polling errors
      }
    };

    if (immediate) {
      poll();
    }
    // 60-second fallback polling interval (reduced from 2.5s to minimize Supabase egress and Vercel CPU)
    pollIntervalRef.current = setInterval(poll, 60000);
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
                    if (parsed.result?.hasMorePagesPending) {
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

                    setSyncProgress((prev) => (prev ? { ...prev, phase: 'complete' } : null));

                    setTimeout(() => {
                      setSyncProgress(null);
                      const newEmails = parsed.newEmails ?? parsed.result?.newEmails ?? 0;
                      const newCompanies = parsed.newCompanies ?? parsed.result?.newCompanies ?? 0;
                      const resultData: SyncResult = {
                        show: true,
                        success: true,
                        message: syncProgress?.isInitialSync
                          ? 'Sync complete! All placement drives are up to date.'
                          : 'Placement sync complete',
                        newEmails,
                        newCompanies,
                      };
                      setSyncResult(resultData);
                      appToast.sync(
                        resultData.message,
                        `${newEmails} new updates · ${newCompanies} companies indexed`
                      );
                      router.refresh();
                      setTimeout(() => setSyncResult(null), 5000);
                    }, 1000);
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
                startPolling(true);
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
          isSyncingRef.current = true;
          if (data.progress) {
            setSyncProgress(data.progress);
          }
          startPolling();
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
            isSyncingRef.current = true;
            if (data.progress) {
              setSyncProgress(data.progress);
            }
            startPolling();
          } else {
            stopPolling();
            if (isSyncingRef.current) {
              isSyncingRef.current = false;
              setIsSyncing(false);
              setSyncProgress(null);
              router.refresh();
            }
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

  return (
    <SyncContext.Provider
      value={{
        isSyncing,
        syncProgress,
        progressPercent,
        lastSyncAt,
        startSync: handleSync,
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
