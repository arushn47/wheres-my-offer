import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * POST /api/notifications/unsubscribe
 * Removes a Web Push subscription by endpoint.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const endpoint = body.endpoint;

    if (!endpoint) {
      return NextResponse.json({ error: 'Missing endpoint' }, { status: 400 });
    }

    const supabase = createAdminClient();

    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('user_id', session.userId)
      .eq('endpoint', endpoint);
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[API Push Unsubscribe] Error:', err);
    return NextResponse.json({ error: 'Failed to unsubscribe' }, { status: 500 });
  }
}
