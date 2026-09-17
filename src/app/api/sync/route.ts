import { getSession } from '@/lib/auth';
import { runSync, type SyncProgress } from '@/lib/sync/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60s — maximum allowed on Vercel Hobby plan (comfortably fits 40s budget)

/**
 * POST /api/sync
 *
 * Triggers a manual email sync for the authenticated user.
 * Returns a Server-Sent Events (SSE) stream with real-time progress updates.
 */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return new Response(
      JSON.stringify({ error: { message: 'Unauthorized', code: 'unauthorized' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Create a readable stream for SSE
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let isClosed = false;
      const sendEvent = (event: string, data: unknown) => {
        if (isClosed) return;
        try {
          const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Stream was closed by the client (timeout / disconnect) — keep sync running silently
          isClosed = true;
        }
      };

      // Keep-alive heartbeat ping every 2s so Vercel edge proxy never drops the SSE stream
      const keepAliveTimer = setInterval(() => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          isClosed = true;
          clearInterval(keepAliveTimer);
        }
      }, 2000);

      try {
        sendEvent('sync_start', {
          message: 'Starting email sync...',
          userId: session.userId,
        });

        const result = await runSync(
          session.userId,
          (progress: SyncProgress) => {
            sendEvent('sync_progress', progress);
            sendEvent('progress', progress);
          },
          {
            timeBudgetMs: process.env.NODE_ENV === 'development' ? 120_000 : 45_000,
          }
        );

        if (result.alreadyRunning) {
          sendEvent('sync_active', {
            message: 'A sync is already actively running in the background.',
            alreadyRunning: true,
          });
          sendEvent('active', {
            message: 'A sync is already actively running in the background.',
            alreadyRunning: true,
          });
          return;
        }

        sendEvent('sync_complete', {
          message: 'Sync complete!',
          result,
          newEmails: result.newEmails,
          newCompanies: result.newCompanies,
        });
        sendEvent('complete', {
          message: 'Sync complete!',
          result,
          newEmails: result.newEmails,
          newCompanies: result.newCompanies,
        });

        // Trigger notifications for live events and approaching registration deadlines
        try {
          const { checkAndNotifyLiveEvents, checkAndNotifyRegistrationDeadlines } = await import('@/lib/notifications/service');
          await checkAndNotifyLiveEvents(session.userId);
          await checkAndNotifyRegistrationDeadlines(session.userId);
        } catch (notifErr) {
          console.warn('[Sync API] Post-sync notification check error:', notifErr);
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Unknown error';
        console.error('Sync error:', err);
        sendEvent('sync_error', {
          message: errorMessage,
        });
        sendEvent('error', {
          message: errorMessage,
        });
      } finally {
        clearInterval(keepAliveTimer);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
