import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getActiveSyncProgress, isUserSyncActive } from '@/lib/sync/engine';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();

  // 1. Check in-memory sync progress first (real-time in current server process)
  const memoryProgress = getActiveSyncProgress(session.userId);
  const memoryIsActive = isUserSyncActive(session.userId);

  // 2. Check sync_state table from Supabase (narrow column projection to reduce egress)
  let dbSyncState: any = null;
  try {
    const { data } = await supabase
      .from('sync_state')
      .select(
        'is_syncing, updated_at, phase, total_messages, processed_messages, skipped_duplicates, account_email, account_type, new_emails, new_companies, last_error, current_subject, is_initial_sync, current_page_index, total_pages'
      )
      .eq('user_id', session.userId)
      .single();
    dbSyncState = data;
  } catch {
    // If sync_state table not yet created in Supabase, fallback gracefully
  }

  // 3. Fetch latest sync timestamp across accounts
  const { data: accounts } = await supabase
    .from('gmail_accounts')
    .select('last_sync_at')
    .eq('user_id', session.userId);

  const lastSyncAt =
    accounts
      ?.map((a) => a.last_sync_at)
      .filter(Boolean)
      .sort()
      .reverse()[0] || null;

  if (memoryIsActive && memoryProgress) {
    return NextResponse.json({
      isSyncing: true,
      phase: memoryProgress.phase,
      progress: memoryProgress,
      lastSyncAt,
    });
  }

  if (dbSyncState?.is_syncing) {
    const updatedAt = new Date(dbSyncState.updated_at || 0).getTime();
    // 90 seconds timeout: active syncs touch updated_at every <= 15s. If untouched for > 90s, the process was killed/interrupted
    const isStale = Date.now() - updatedAt > 90 * 1000;
    if (!isStale) {
      const totalMessages = dbSyncState.total_messages || 0;
      const processedMessages = dbSyncState.processed_messages || 0;
      const alreadyIndexed = dbSyncState.skipped_duplicates || 0;
      const remainingMessages = Math.max(0, totalMessages - processedMessages);
      const isResuming = alreadyIndexed > 0 && remainingMessages > 0;

      return NextResponse.json({
        isSyncing: true,
        phase: dbSyncState.phase,
        progress: {
          phase: dbSyncState.phase,
          accountEmail: dbSyncState.account_email || '',
          accountType: dbSyncState.account_type || '',
          totalMessages,
          processedMessages,
          alreadyIndexed,
          remainingMessages,
          isResuming,
          newEmails: dbSyncState.new_emails || 0,
          newCompanies: dbSyncState.new_companies || 0,
          skippedDuplicates: dbSyncState.skipped_duplicates || 0,
          errors: dbSyncState.last_error ? [dbSyncState.last_error] : [],
          currentSubject: dbSyncState.current_subject,
          isInitialSync: dbSyncState.is_initial_sync,
          currentPageIndex: dbSyncState.current_page_index ?? 0,
          totalPagesCount: dbSyncState.total_pages ?? 1,
        },
        lastSyncAt,
      });
    } else {
      // Stale lock detected (>90s untouched).
      // Keep this status endpoint strictly read-only: do NOT perform DB writes here.
      // Stale locks are safely overridden by runSync() when a new sync is initiated.
      return NextResponse.json({
        isSyncing: false,
        phase: 'idle',
        progress: null,
        lastSyncAt,
      });
    }
  }

  return NextResponse.json({
    isSyncing: false,
    phase: dbSyncState?.phase || 'idle',
    progress: null,
    lastSyncAt,
  });
}
