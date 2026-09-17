import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * POST /api/sync/reset
 * Nuclear reset: Wipes ALL placement data for the authenticated user and resets
 * Gmail sync history so the next sync does a full re-fetch from scratch.
 */
export async function POST() {
  const session = await getSession();
  if (!session?.userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const userId = session.userId;
  const supabase = createAdminClient();

  try {
    // 1. Delete all events
    await supabase.from('events').delete().eq('user_id', userId);

    // 2. Delete all candidate matches
    await supabase.from('candidate_matches').delete().eq('user_id', userId);

    // 3. Delete all notifications
    await supabase.from('notifications').delete().eq('user_id', userId);

    // 4. Delete all applications
    await supabase.from('applications').delete().eq('user_id', userId);

    // 5. Delete all stored emails
    await supabase.from('emails').delete().eq('user_id', userId);

    // 6. Delete all companies
    await supabase.from('companies').delete().eq('user_id', userId);

    // 7. Delete sync pages & sync state
    await supabase.from('sync_pages').delete().eq('user_id', userId);
    await supabase.from('sync_state').delete().eq('user_id', userId);

    // 8. Reset Gmail account sync history so next sync does a full re-fetch
    await supabase
      .from('gmail_accounts')
      .update({
        last_sync_at: null,
        last_history_id: null,
      })
      .eq('user_id', userId);

    return NextResponse.json({
      success: true,
      message: 'All placement data has been wiped. Trigger a sync to re-fetch everything from scratch.',
    });
  } catch (err: any) {
    console.error('[Reset Error]:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to reset placement data' },
      { status: 500 }
    );
  }
}
