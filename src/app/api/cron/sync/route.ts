import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { runSync, CRON_TOTAL_BUDGET_MS } from '@/lib/sync/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min — handles multi-user sync on Vercel Pro

async function executeBackgroundSync(userIds: string[]) {
  const supabase = createAdminClient();

  // Renew any Gmail Pub/Sub watch subscriptions expiring within 48 hours.
  // When Pub/Sub is active, this cron becomes a daily safety net — not the primary sync driver.
  try {
    const { renewExpiringWatches } = await import('@/lib/gmail/watch');
    const { renewed, failed } = await renewExpiringWatches(supabase);
    if (renewed > 0 || failed > 0) {
      console.log(`[Cron Sync] Watch renewal: ${renewed} renewed, ${failed} failed`);
    }
  } catch (err) {
    // Non-fatal — sync should continue even if renewal fails
    console.error('[Cron Sync] Watch renewal error (non-fatal):', err);
  }

  // Clean up completed sync pages older than 1 hour (E6.3)
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await supabase
      .from('sync_pages')
      .delete()
      .eq('status', 'complete')
      .lt('updated_at', oneHourAgo);

    // Prune completed pubsub webhook logs older than 48 hours to prevent database bloat
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await supabase
      .from('gmail_pubsub_inbox')
      .delete()
      .eq('status', 'completed')
      .lt('created_at', twoDaysAgo);

    // Prune in-app notifications older than 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from('notifications')
      .delete()
      .lt('created_at', sevenDaysAgo);
  } catch (cleanErr) {
    console.warn('[Cron Sync] Stale data cleanup non-fatal error:', cleanErr);
  }

  // Shared wall-clock deadline for this entire cron invocation.
  // All runSync calls share this deadline so serial per-user work
  // can't stack and exceed maxDuration when there are multiple users.
  const globalDeadline = Date.now() + CRON_TOTAL_BUDGET_MS;

  for (const userId of userIds) {
    if (Date.now() >= globalDeadline) {
      console.log(`[Cron Sync] Global deadline reached. Skipping remaining ${userIds.length - userIds.indexOf(userId)} user(s) — they will be picked up on the next tick.`);
      break;
    }

    try {
      const res = await runSync(userId, undefined, { isBackgroundCron: true, globalDeadline });
      if (res?.alreadyRunning) {
        console.log(`[Cron Sync] User ${userId} is currently syncing. Skipped concurrent run.`);
      } else {
        console.log(`[Cron Sync] Successfully synced user ${userId}`);
      }

      // These checks are time-based and must run even when Gmail had no new mail.
      if (!res?.alreadyRunning) {
        const { checkAndNotifyLiveEvents, checkAndNotifyRegistrationDeadlines } = await import(
          '@/lib/notifications/service'
        );
        await checkAndNotifyLiveEvents(userId);
        await checkAndNotifyRegistrationDeadlines(userId);
      }
    } catch (err: any) {
      console.error(`[Cron Sync] Failed for user ${userId}:`, err);
    }
  }
}

/**
 * GET /api/cron/sync
 * Scheduled background sync endpoint for Vercel Cron or external cron services (e.g. cron-job.org).
 * Runs sync automatically for all active users even when the web app is closed.
 * Also renews Gmail Pub/Sub watch subscriptions that are close to expiry (7-day limit).
 */
export async function GET(req: NextRequest) {
  // Verify secret authorization header or query parameter if configured
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Cron authentication is not configured' }, { status: 503 });
  }
  const authHeader = req.headers.get('authorization');
  const xSecret = req.headers.get('x-cron-secret');
  const querySecret = req.nextUrl.searchParams.get('secret') || req.nextUrl.searchParams.get('key');

  const isAuthorized =
    authHeader === `Bearer ${secret}` ||
    authHeader === secret ||
    xSecret === secret ||
    querySecret === secret;

  if (!isAuthorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();

    // Get all users who have connected Gmail accounts
    const { data: accounts, error } = await supabase
      .from('gmail_accounts')
      .select('user_id')
      .eq('is_connected', true);

    if (error || !accounts || accounts.length === 0) {
      return NextResponse.json({ message: 'No connected accounts to sync' }, { status: 200 });
    }

    // Deduplicate user_ids
    const userIds = Array.from(new Set(accounts.map((a) => a.user_id)));

    // Check if caller explicitly requested synchronous waiting (?wait=true)
    const shouldWait = req.nextUrl.searchParams.get('wait') === 'true';

    if (shouldWait) {
      const syncResults = [];
      for (const userId of userIds) {
        try {
          const result = await runSync(userId, undefined, { isBackgroundCron: true });
          if (result?.alreadyRunning) {
            syncResults.push({ userId, status: 'skipped_already_running', message: 'Sync already in progress' });
          } else {
            syncResults.push({ userId, status: 'success', result });
            const { checkAndNotifyLiveEvents, checkAndNotifyRegistrationDeadlines } = await import(
              '@/lib/notifications/service'
            );
            await checkAndNotifyLiveEvents(userId);
            await checkAndNotifyRegistrationDeadlines(userId);
          }
        } catch (err: any) {
          console.error(`[Cron Sync] Failed for user ${userId}:`, err);
          syncResults.push({ userId, status: 'error', error: err.message });
        }
      }
      return NextResponse.json({
        success: true,
        usersProcessed: userIds.length,
        details: syncResults,
      });
    }

    // Non-blocking execution for external cron services (cron-job.org):
    // Dispatches background work via Next.js after() and immediately responds 200 OK in ~50ms
    // to prevent external cron HTTP 30-second timeouts.
    after(executeBackgroundSync(userIds));

    return NextResponse.json({
      success: true,
      message: `Background sync triggered for ${userIds.length} user(s)`,
      usersCount: userIds.length,
    });
  } catch (err: any) {
    console.error('[Cron Sync Error]:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
