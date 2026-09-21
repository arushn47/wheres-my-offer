import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * DELETE /api/notifications/[id]
 * Deletes / dismisses a single notification for the authenticated user.
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
    .delete()
    .eq('id', id)
    .eq('user_id', session.userId);

  if (error) {
    console.error('[API Notifications] Delete single error:', error);
    return NextResponse.json({ error: 'Failed to delete notification' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
