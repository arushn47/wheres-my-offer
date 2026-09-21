import { getSession } from '@/lib/auth';
import { runSync, type SyncProgress } from '@/lib/sync/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 300s — maximum allowed on Vercel Fluid Compute (Hobby & Pro)

/**
 * POST /api/sync
 *
 * Triggers a manual email sync for the authenticated user.
 * Returns a Server-Sent Events (SSE) stream with real-time progress updates.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return new Response(
      JSON.stringify({ error: { message: 'Unauthorized', code: 'unauthorized' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Create a readable stream for SSE with explicit lifecycle cleanup
  const encoder = new TextEncoder();
  let isClosed = false;
  let keepAliveTimer: NodeJS.Timeout | null = null;
  let streamController: ReadableStreamDefaultController | null = null;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (streamController) {
      try {
        streamController.close();
      } catch {
        // Stream may already be closed or errored
      }
      streamController = null;
    }
  };

  // Explicitly listen to client disconnection/abort to teardown resources immediately
  if (req.signal.aborted) {
    cleanup();
  } else {
    req.signal.addEventListener('abort', cleanup, { once: true });
  }

  const stream = new ReadableStream({
    async start(controller) {
      streamController = controller;

      const sendEvent = (event: string, data: unknown) => {
        if (isClosed || req.signal.aborted) return;
        try {
          const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Stream was closed by the client (timeout / disconnect)
          cleanup();
        }
      };

      // Keep-alive heartbeat ping every 2s so Vercel edge proxy never drops the SSE stream
      keepAliveTimer = setInterval(() => {
        if (isClosed || req.signal.aborted) {
          cleanup();
          return;
        }
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          cleanup();
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
            timeBudgetMs: process.env.NODE_ENV === 'development' ? 60_000 : 32_000,
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

        // Trigger notifications in the background so stream closes with zero latency
        import('@/lib/notifications/service')
          .then(({ checkAndNotifyLiveEvents, checkAndNotifyRegistrationDeadlines }) => {
            checkAndNotifyLiveEvents(session.userId).catch(() => {});
            checkAndNotifyRegistrationDeadlines(session.userId).catch(() => {});
          })
          .catch((notifErr) => console.warn('[Sync API] Post-sync notification error:', notifErr));
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
        cleanup();
      }
    },
    cancel() {
      // Invoked when consumer cancels/aborts the readable stream
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Encoding': 'none',
      'X-Accel-Buffering': 'no',
    },
  });
}
