import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireAdmin();
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unauthorized' },
      { status: err.status || 401 }
    );
  }

  const supabase = createAdminClient();

  try {
    const [usersRes, accountsRes, syncStatesRes, canonicalCountRes] = await Promise.all([
      supabase
        .from('users')
        .select('id, email, name, avatar_url, role, created_at')
        .order('created_at', { ascending: false }),
      supabase
        .from('gmail_accounts')
        .select('id, user_id, email, account_type, is_connected, last_sync_at, last_history_id'),
      supabase
        .from('sync_state')
        .select(
          'user_id, is_syncing, phase, total_messages, processed_messages, new_emails, new_companies, current_subject, last_error, updated_at, started_at, completed_at, lease_expires_at, account_email, is_initial_sync, current_page_index, total_pages'
        ),
      supabase
        .from('college_emails')
        .select('*', { count: 'exact', head: true }),
    ]);

    if (usersRes.error) {
      console.error('[Admin Users API] Error querying users:', usersRes.error);
      return NextResponse.json({ error: usersRes.error.message }, { status: 500 });
    }

    if (accountsRes.error) {
      console.warn('[Admin Users API] Warning querying accounts:', accountsRes.error);
    }
    if (syncStatesRes.error) {
      console.warn('[Admin Users API] Warning querying sync_state:', syncStatesRes.error);
    }

    const users = usersRes.data || [];
    const accounts = accountsRes.data || [];
    const syncStates = syncStatesRes.data || [];
    const totalCanonical = canonicalCountRes.count || 0;

    // Parallel counts per user to bypass PostgREST 1000 row limit
    const userMetricsPromises = users.map(async (u) => {
      const [emailsRes, canonicalRes] = await Promise.all([
        supabase
          .from('personal_emails')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', u.id),
        supabase
          .from('candidate_matches')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', u.id)
          .not('college_email_id', 'is', null),
      ]);

      return {
        userId: u.id,
        emailCount: emailsRes.count || 0,
        canonicalCount: canonicalRes.count || 0,
      };
    });

    const userMetricsArray = await Promise.all(userMetricsPromises);
    const metricsMap = new Map(userMetricsArray.map((m) => [m.userId, m]));

    const now = Date.now();
    const enriched = users.map((u) => {
      const userAccounts = accounts.filter((a) => a.user_id === u.id);
      const syncState = syncStates.find((s) => s.user_id === u.id);
      const userMetric = metricsMap.get(u.id);

      const emailCount = userMetric?.emailCount || 0;
      const canonicalCount = userMetric?.canonicalCount || 0;

      // Estimate total expected messages
      let totalExpected = emailCount;
      if (syncState?.total_pages && syncState.total_pages > 1 && syncState.is_initial_sync) {
        totalExpected = Math.max(emailCount, syncState.total_pages * 50);
      }

      const isStuck = Boolean(
        syncState?.is_syncing &&
        (
          (syncState.lease_expires_at && new Date(syncState.lease_expires_at).getTime() < now) ||
          (syncState.updated_at && now - new Date(syncState.updated_at).getTime() > 5 * 60 * 1000)
        )
      );

      return {
        id: u.id,
        email: u.email,
        name: u.name,
        avatar: u.avatar_url,
        role: u.role || 'user',
        created_at: u.created_at,
        accounts: userAccounts,
        emailCount,
        totalExpected,
        canonicalCount,
        totalCanonical,
        syncState: syncState
          ? {
              is_syncing: syncState.is_syncing,
              is_stuck: isStuck,
              phase: syncState.phase,
              processed_messages: syncState.processed_messages ?? 0,
              total_messages: syncState.total_messages ?? 0,
              new_emails: syncState.new_emails ?? 0,
              new_companies: syncState.new_companies ?? 0,
              current_subject: syncState.current_subject || null,
              error: syncState.last_error || null,
              started_at: syncState.started_at,
              completed_at: syncState.completed_at,
              updated_at: syncState.updated_at,
              lease_expires_at: syncState.lease_expires_at,
              account_email: syncState.account_email,
              is_initial_sync: syncState.is_initial_sync ?? false,
              current_page_index: syncState.current_page_index ?? 0,
              total_pages: syncState.total_pages ?? 1,
            }
          : null,
      };
    });

    return NextResponse.json({ users: enriched }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[Admin Users API] Unexpected error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
