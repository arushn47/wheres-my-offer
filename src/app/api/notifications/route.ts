import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * GET /api/notifications
 * Returns recent in-app notifications (last 7 days) and unread count for the authenticated user.
 * Soft-dismissed rows stay in the table as sync dedupe ledger entries but are
 * never returned here. Rows older than 7 days age out of the inbox window.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // 1. Fetch latest active notifications (last 7 days, max 30).
  // Soft-dismissed rows are hidden but kept: they are the dedupe_key ledger
  // entries that stop sync from re-creating dismissed notifications.
  const { data: notifications, error } = await supabase
    .from('notifications')
    .select('id, type, title, message, body, link, is_read, created_at')
    .eq('user_id', session.userId)
    .is('dismissed_at', null)
    .is('superseded_at', null)
    .gte('created_at', sevenDaysAgo)
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) {
    console.error('[API Notifications] Fetch error:', error);
    return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500 });
  }

  // 3. Count unread within the active 7-day window (dismissed rows excluded)
  const { count: unreadCount } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', session.userId)
    .is('dismissed_at', null)
    .is('superseded_at', null)
    .gte('created_at', sevenDaysAgo)
    .or('is_read.eq.false,is_read.is.null');

  return NextResponse.json({
    notifications: notifications || [],
    unreadCount: unreadCount || 0,
  });
}

/**
 * POST /api/notifications
 * Marks all notifications as read for the authenticated user.
 */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', session.userId)
    .or('is_read.eq.false,is_read.is.null');

  if (error) {
    console.error('[API Notifications] Mark all read error:', error);
    return NextResponse.json({ error: 'Failed to mark all as read' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

/**
 * DELETE /api/notifications
 * Dismisses notifications for the authenticated user (soft-dismiss; see [id]/route.ts).
 * Query param: ?readOnly=true -> only dismisses marked-as-read notifications.
 * Without query param -> dismisses all notifications for this user.
 */
export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const readOnly = searchParams.get('readOnly') === 'true';

  const supabase = createAdminClient();
  let query = supabase
    .from('notifications')
    .update({ dismissed_at: new Date().toISOString() })
    .eq('user_id', session.userId)
    .is('dismissed_at', null);

  if (readOnly) {
    query = query.eq('is_read', true);
  }

  const { error } = await query;
  if (error) {
    console.error('[API Notifications] Dismiss-all error:', error);
    return NextResponse.json({ error: 'Failed to dismiss notifications' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
