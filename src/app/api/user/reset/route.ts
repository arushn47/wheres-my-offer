import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * POST /api/user/reset
 *
 * Reset to Fresh Candidate Mode:
 * Wipes all placement data (companies, applications, events, shortlists, sync pages/state),
 * and resets sync checkpoints so the next sync acts as a fresh initial onboarding scan.
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
    // 1. Delete placement analysis records in strict foreign-key order
    await supabase.from('candidate_matches').delete().eq('user_id', userId);
    await supabase.from('events').delete().eq('user_id', userId);
    await supabase.from('notifications').delete().eq('user_id', userId);
    await supabase.from('applications').delete().eq('user_id', userId);
    await supabase.from('email_drive_links').delete().eq('user_id', userId);
    await supabase.from('emails').delete().eq('user_id', userId);
    await supabase.from('placement_drives').delete().eq('user_id', userId);
    await supabase.from('companies').delete().eq('user_id', userId);
    await supabase.from('sync_pages').delete().eq('user_id', userId);
    await supabase.from('sync_state').delete().eq('user_id', userId);

    // 2. Reset Gmail account sync history so next sync performs a full initial scan
    await supabase
      .from('gmail_accounts')
      .update({
        last_sync_at: null,
        last_history_id: null,
      })
      .eq('user_id', userId);

    return NextResponse.json({
      success: true,
      message: 'All placement data wiped. Account reset to fresh candidate state.',
    });
  } catch (err: any) {
    console.error('[User Reset Error]:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to reset candidate data' },
      { status: 500 }
    );
  }
}
