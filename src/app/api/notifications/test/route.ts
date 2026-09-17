import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { sendNotification } from '@/lib/notifications/service';

/**
 * POST /api/notifications/test
 * Sends a test notification to verify in-app and browser push notifications.
 */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const timestamp = Date.now();
  const dedupeKey = `test:${session.userId}:${timestamp}`;

  const result = await sendNotification({
    userId: session.userId,
    type: 'general',
    title: 'Where\'s My Offer Notification Test',
    body: 'Your browser push and in-app notification system is working perfectly!',
    link: '/settings',
    dedupeKey,
  });

  return NextResponse.json({
    success: true,
    result,
  });
}
