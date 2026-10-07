import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { readSharedProgress } from '@/lib/sync/progress-readers';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();
  try {
    const state = await readSharedProgress(supabase);
    if (!state) return NextResponse.json({ status: null }, { headers: { 'Cache-Control': 'no-store' } });

    const [accountResult, archiveResult] = await Promise.all([
      supabase
      .from('gmail_accounts')
        .select('email,is_connected,last_sync_at,watch_expires_at')
        .eq('id', state.gmail_account_id)
        .maybeSingle(),
      supabase.from('college_emails').select('id', { count: 'exact', head: true }),
    ]);
    if (accountResult.error) throw accountResult.error;
    if (archiveResult.error) throw archiveResult.error;

    const hasMoreArchivePages = Boolean(state.next_page_token);
    const isSyncing = state.is_syncing && Boolean(state.lease_expires_at) &&
      new Date(state.lease_expires_at || 0).getTime() > Date.now();
    const complete = state.initial_scan_complete && !hasMoreArchivePages;
    const recentlyUpdated = Boolean(state.updated_at) &&
      Date.now() - new Date(state.updated_at).getTime() < 3 * 60 * 1000;
    const watchExpiresAt = accountResult.data?.watch_expires_at || null;
    const watchActive = Boolean(watchExpiresAt) &&
      new Date(watchExpiresAt || 0).getTime() > Date.now();

    return NextResponse.json({
      status: {
        inbox: accountResult.data?.email || null,
        connected: Boolean(accountResult.data?.is_connected),
        isSyncing,
        recentlyUpdated,
        watchActive,
        scheduledSweepEnabled: process.env.SHARED_COLLEGE_SYNC_ENABLED === 'true',
        phase: state.phase,
        complete,
        hasMoreArchivePages,
        pendingMessages: Math.max(0, state.pending_message_count - (state.pending_offset || 0)),
        updatedAt: state.updated_at,
        lastSyncAt: accountResult.data?.last_sync_at || null,
        lastError: state.last_error,
        canonicalEmails: archiveResult.count || 0,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Shared College Status] Read failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load shared College status' },
      { status: 500 }
    );
  }
}
