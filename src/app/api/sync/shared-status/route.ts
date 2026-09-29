import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createAdminClient();
  try {
    const { data: stateRows, error: stateError } = await supabase
      .from('shared_college_sync_state')
      .select('gmail_account_id,is_syncing,phase,initial_scan_complete,next_page_token,pending_message_ids,pending_offset,updated_at,lease_expires_at,last_error')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (stateError) throw stateError;
    const state = stateRows?.[0] ?? null;
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

    const pendingIds = Array.isArray(state.pending_message_ids) ? state.pending_message_ids : [];
    const hasMoreArchivePages = Boolean(state.next_page_token);
    const isSyncing = state.is_syncing && Boolean(state.lease_expires_at) &&
      new Date(state.lease_expires_at).getTime() > Date.now();
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
        pendingMessages: Math.max(0, pendingIds.length - (state.pending_offset || 0)),
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
