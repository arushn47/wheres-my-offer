import webpush from 'web-push';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Ensures web-push is properly initialized with VAPID credentials in serverless/runtime context.
 */
function ensureVapidDetails(): boolean {
  const pubKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'https://www.wheresmyoffer.in';

  if (!pubKey || !privKey) {
    return false;
  }

  try {
    webpush.setVapidDetails(subject, pubKey, privKey);
    return true;
  } catch (err) {
    console.error('[Push] Failed to set VAPID details:', err);
    return false;
  }
}

// Initial top-level invocation if environment is ready
ensureVapidDetails();

export interface PushNotificationPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: {
    url?: string;
    companyId?: string;
    eventId?: string;
    type?: string;
    [key: string]: unknown;
  };
}

/**
 * Sends a web push notification to all active browser subscriptions for a user.
 * Automatically cleans up expired or invalid subscriptions (HTTP 404 / 410).
 *
 * @param userId - Target user UUID
 * @param payload - Notification content & click navigation URL
 */
export async function sendPushToUser(
  userId: string,
  payload: PushNotificationPayload
): Promise<{ sent: number; failed: number }> {
  if (!ensureVapidDetails()) {
    console.warn('[Push] VAPID keys not configured or invalid. Skipping web push.');
    return { sent: 0, failed: 0 };
  }

  const supabase = createAdminClient();

  // Fetch all active push subscriptions for this user
  const { data: subscriptions, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId);

  if (error) {
    console.error('[Push] Subscription lookup failed:', error.code, error.message);
    throw error;
  }
  if (!subscriptions || subscriptions.length === 0) {
    return { sent: 0, failed: 0 };
  }

  // Note: Android requires raster PNG bitmaps (/icon-192.png). SVG icons are silently dropped by Android NotificationManager!
  const stringifiedPayload = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon || '/icon-192.png',
    badge: payload.badge || '/icon-192.png',
    tag: payload.tag || `wmo-${Date.now()}`,
    data: payload.data || { url: '/' },
  });

  let sent = 0;
  let failed = 0;

  const expiredIds: string[] = [];

  await Promise.all(
    subscriptions.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
      };

      try {
        await webpush.sendNotification(pushSubscription, stringifiedPayload, {
          TTL: 86400, // 24 hours in seconds
          urgency: 'high', // Requests prompt delivery; device/OS notification settings still apply.
        });
        sent++;
      } catch (err: unknown) {
        failed++;
        const statusCode = (err as { statusCode?: number })?.statusCode;

        // 404 Not Found or 410 Gone means the subscription is expired / user revoked permission
        if (statusCode === 404 || statusCode === 410) {
          console.log(`[Push] Removing expired push subscription: ${sub.id}`);
          expiredIds.push(sub.id);
        } else {
          console.error(`[Push] Provider rejected subscription ${sub.id}:`, { statusCode, message: (err as Error)?.message });
        }
      }
    })
  );

  // Clean up expired subscriptions
  if (expiredIds.length > 0) {
    await supabase.from('push_subscriptions').delete().in('id', expiredIds);
  }

  return { sent, failed };
}

