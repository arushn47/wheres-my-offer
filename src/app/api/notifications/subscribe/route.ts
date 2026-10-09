import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { updateNotificationPreferences } from '@/lib/notifications/preferences';

interface SubscribePayload {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
  enablePush?: boolean;
}

function isValidPushEndpoint(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return (
      host === 'fcm.googleapis.com' ||
      host.endsWith('.push.services.mozilla.com') ||
      host === 'web.push.apple.com' ||
      host.endsWith('.notify.windows.com') ||
      host.endsWith('.push.apple.com')
    );
  } catch {
    return false;
  }
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

    if (typeof body.endpoint !== 'string' || typeof body.p256dh !== 'string' || typeof body.auth !== 'string' ||
        !/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(body.p256dh) || !/^[A-Za-z0-9_-]{20,30}={0,2}$/.test(body.auth) ||
        (body.userAgent !== undefined && (typeof body.userAgent !== 'string' || body.userAgent.length > 1024)) ||
        (body.enablePush !== undefined && typeof body.enablePush !== 'boolean') || !isValidPushEndpoint(body.endpoint)) {
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

    // Use the same preference table as delivery. Restoring an existing browser
    // subscription must preserve an intentional global disable.
    if (body.enablePush === true) await updateNotificationPreferences(session.userId, { browserPushEnabled: true });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[API Push Subscribe] Request error:', err);
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
