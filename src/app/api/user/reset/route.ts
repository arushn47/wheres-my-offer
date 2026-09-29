import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * POST /api/user/reset
 *
 * Reset to Fresh Candidate Mode:
 * Clears the user's placement data (applications, events, shortlists, personal email
 * receipts, sync pages/state), and resets sync checkpoints for a fresh inbox scan.
 * Shared company, drive, and College email catalog rows are retained for other users.
 * Keeps the user's account, candidate ID, and Gmail connections active.
 */
export async function POST() {
  const session = await getSession();
  if (!session?.userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const userId = session.userId;
  const supabase = createAdminClient();

  try {
    const { data: syncState, error: syncStateError } = await supabase
      .from('sync_state')
      .select('is_syncing, lease_expires_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (syncStateError) throw new Error(`Failed to check sync status: ${syncStateError.message}`);
    if (
      syncState?.is_syncing &&
      syncState.lease_expires_at &&
      new Date(syncState.lease_expires_at).getTime() > Date.now()
    ) {
      return NextResponse.json(
        { error: 'A sync is currently running. Wait for it to finish before resetting placement data.' },
        { status: 409 }
      );
    }

    const runCleanupStep = async (label: string, operation: PromiseLike<{ error: { message: string } | null }>) => {
      const { error } = await operation;
      if (error) throw new Error(`Failed to clear ${label}: ${error.message}`);
    };

    // Delete per-user analysis before its source receipts. Shared company, drive,
    // and college_emails catalog rows intentionally remain available to everyone.
    await Promise.all([
      runCleanupStep('shortlist matches', supabase.from('candidate_matches').delete().eq('user_id', userId)),
      runCleanupStep('events', supabase.from('events').delete().eq('user_id', userId)),
      runCleanupStep('notifications', supabase.from('notifications').delete().eq('user_id', userId)),
    ]);
    await runCleanupStep('applications', supabase.from('applications').delete().eq('user_id', userId));
    await runCleanupStep('email-to-drive links', supabase.from('email_drive_links').delete().eq('user_id', userId));
    await runCleanupStep('personal email receipts', supabase.from('personal_emails').delete().eq('user_id', userId));
    await Promise.all([
      runCleanupStep('sync pages', supabase.from('sync_pages').delete().eq('user_id', userId)),
      runCleanupStep('sync state', supabase.from('sync_state').delete().eq('user_id', userId)),
    ]);

    // Reset Gmail checkpoints so the next sync performs a full inbox discovery.
    const { error: checkpointError } = await supabase
      .from('gmail_accounts')
      .update({
        last_sync_at: null,
        last_history_id: null,
      })
      .eq('user_id', userId);
    if (checkpointError) throw new Error(`Failed to reset Gmail sync checkpoints: ${checkpointError.message}`);

    return NextResponse.json({
      success: true,
      message: 'Your placement data was cleared. Shared company, drive, and College circular data remains in the shared catalog.',
    });
  } catch (err) {
    console.error('[User Reset Error]:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to reset candidate data' },
      { status: 500 }
    );
  }
}
