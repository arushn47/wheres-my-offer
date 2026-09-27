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
    .select('id, last_sync_at, account_type')
    .eq('user_id', session.userId);

  const personalAccountIds = (accounts || [])
    .filter((account) => account.account_type === 'personal')
    .map((account) => account.id);

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

  if (dbSyncState?.last_error?.startsWith('Paused by user')) {
    return NextResponse.json({
      isSyncing: false,
      phase: 'paused',
      progress: {
        phase: 'pending',
        accountEmail: dbSyncState.account_email || '',
        accountType: 'personal',
        totalMessages: dbSyncState.total_messages || 0,
        processedMessages: dbSyncState.processed_messages || 0,
        newEmails: dbSyncState.new_emails || 0,
        newCompanies: dbSyncState.new_companies || 0,
        skippedDuplicates: dbSyncState.skipped_duplicates || 0,
        errors: [],
        isInitialSync: dbSyncState.is_initial_sync,
        currentPageIndex: dbSyncState.current_page_index ?? 0,
        totalPagesCount: dbSyncState.total_pages ?? 1,
        paused: true,
      },
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
      let currentAccountEmail = dbSyncState.account_email || '';
      let activePhase = dbSyncState.phase;
      let activeTotal = totalMessages;
      let activeProcessed = processedMessages;
      let currentPageIndex = dbSyncState.current_page_index ?? 0;
      let totalPagesCount = dbSyncState.total_pages ?? 1;
      let accountType = dbSyncState.account_type || '';
      let personalPagesExist = false;

      if (personalAccountIds.length > 0) {
        const { data: personalPages } = await supabase
          .from('sync_pages')
          .select('gmail_account_id, page_index, message_ids, next_offset')
          .eq('user_id', session.userId)
          .in('gmail_account_id', personalAccountIds)
          .neq('status', 'complete')
          .order('page_index', { ascending: true });
        if (personalPages?.length) {
          personalPagesExist = true;
          const page = personalPages[0];
          const account = accounts?.find((candidate) => candidate.id === page.gmail_account_id);
          currentAccountEmail = account?.id === page.gmail_account_id ? (dbSyncState.account_email || '') : currentAccountEmail;
          accountType = 'personal';
          activePhase = 'processing';
          activeTotal = Array.isArray(page.message_ids) ? page.message_ids.length : totalMessages;
          activeProcessed = page.next_offset || 0;
          currentPageIndex = page.page_index;
          totalPagesCount = personalPages.length;
        }
      }

      // The user-facing sync now scans only Personal Gmail. Legacy College
      // locks/pages must not keep Campus Radar spinning after that path is retired.
      if (dbSyncState.account_type === 'college' && !personalPagesExist) {
        return NextResponse.json({
          isSyncing: false,
          phase: 'idle',
          progress: null,
          lastSyncAt,
        });
      }

      return NextResponse.json({
        isSyncing: true,
        phase: activePhase,
        progress: {
          phase: activePhase,
          accountEmail: currentAccountEmail,
          accountType,
          totalMessages: activeTotal,
          processedMessages: activeProcessed,
          alreadyIndexed,
          remainingMessages,
          isResuming,
          newEmails: dbSyncState.new_emails || 0,
          newCompanies: dbSyncState.new_companies || 0,
          skippedDuplicates: dbSyncState.skipped_duplicates || 0,
          currentSubject: dbSyncState.current_subject,
          isInitialSync: dbSyncState.is_initial_sync,
          paused: Boolean(dbSyncState.last_error?.startsWith('Paused by user')),
          errors: dbSyncState.last_error ? [dbSyncState.last_error] : [],
          currentPageIndex,
          totalPagesCount,
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
