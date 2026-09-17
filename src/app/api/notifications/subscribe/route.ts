import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

interface SubscribePayload {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

/**
 * POST /api/notifications/subscribe
 * Registers or updates a Web Push subscription for the authenticated user.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body: SubscribePayload = await req.json();

    if (!body.endpoint || !body.p256dh || !body.auth) {
      return NextResponse.json({ error: 'Missing required subscription keys' }, { status: 400 });
    }

    const supabase = createAdminClient();

    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        {
          user_id: session.userId,
          endpoint: body.endpoint,
          p256dh: body.p256dh,
          auth: body.auth,
          user_agent: body.userAgent || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'endpoint' }
      );

    if (error) {
      console.error('[API Push Subscribe] Upsert error:', error);
      return NextResponse.json({ error: 'Failed to save subscription' }, { status: 500 });
    }

    // Auto-enable browser push in their global settings if it's currently disabled
    const { data: settings } = await supabase
      .from('user_settings')
      .select('notification_preferences')
      .eq('user_id', session.userId)
      .single();

    if (settings) {
      const prefs = settings.notification_preferences || {};
      if (!prefs.browserPushEnabled) {
        prefs.browserPushEnabled = true;
        await supabase
          .from('user_settings')
          .update({ notification_preferences: prefs })
          .eq('user_id', session.userId);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[API Push Subscribe] Request error:', err);
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
