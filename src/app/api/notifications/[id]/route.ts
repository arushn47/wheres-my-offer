import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * DELETE /api/notifications/[id]
 * Dismisses a single notification for the authenticated user.
 *
 * Rows are soft-dismissed (dismissed_at) instead of hard-deleted: each
 * notification row doubles as the sync pipeline's dedupe_key ledger entry, and
 * destroying the row would let the next sync re-derive the same notification
 * (e.g. "Not shortlisted" results) and re-send it forever.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createAdminClient();

  const { error } = await supabase
    .from('notifications')
    .update({ dismissed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', session.userId)
    .is('dismissed_at', null);

  if (error) {
    console.error('[API Notifications] Dismiss single error:', error);
    return NextResponse.json({ error: 'Failed to dismiss notification' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
