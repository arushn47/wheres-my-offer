import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { performReprocess } from '@/lib/sync/reprocess';
import { MutationBusyError } from '@/lib/sync/mutation-lease';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: Request) {
  let userId: string | null = null;
  const session = await getSession();
  if (session) {
    userId = session.userId;
  } else {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const url = new URL(req.url);
      const authHeader = req.headers.get('authorization');
      const querySecret = url.searchParams.get('secret') || url.searchParams.get('key');
      const isAuthorized =
        authHeader === `Bearer ${secret}` ||
        authHeader === secret ||
        querySecret === secret;
      if (isAuthorized) {
        userId = url.searchParams.get('userId') || '48380752-3627-4b81-b44a-4e158002902c';
      }
    }
  }

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const isStream =
    req.headers.get('accept')?.includes('text/event-stream') ||
    new URL(req.url).searchParams.get('stream') === 'true';

  // ── waitUntil / job-queue path (default) ──────────────────────────────────
  // Avoids Vercel 60s response timeout by returning a jobId immediately and
  // running the heavy computation in background via waitUntil().
  // The SSE stream path is preserved for internal tooling / cron.
  if (!isStream) {
    const supabaseJob = createAdminClient();

    // Check for an already-running job for this user
    const { data: existingJob } = await supabaseJob
      .from('reprocess_jobs')
      .select('id, status')
      .eq('user_id', userId)
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingJob) {
      return NextResponse.json({ jobId: existingJob.id, status: existingJob.status, queued: true });
    }

    const { data: newJob, error: insertErr } = await supabaseJob
      .from('reprocess_jobs')
      .insert({
        user_id: userId,
        type: 'single',
        status: 'pending',
        step: 0,
        total_steps: 5,
        message: 'Queued…',
      })
      .select('id')
      .single();

    if (insertErr || !newJob) {
      // Fall through to SSE path if job creation fails
      console.error('[Sync Reprocess] Failed to create job record, falling back to SSE:', insertErr);
    } else {
      const jobId = newJob.id;

      waitUntil(
        (async () => {
          try {
            await supabaseJob
              .from('reprocess_jobs')
              .update({ status: 'running', step: 1, message: 'Cleaning recipient matches & fetching stored circulars…' })
              .eq('id', jobId);

            const result = await performReprocess(userId!, async (progress) => {
              await supabaseJob
                .from('reprocess_jobs')
                .update({
                  step: progress.step,
                  total_steps: progress.totalSteps,
                  message: progress.message,
                })
                .eq('id', jobId);
            });

            // Trigger calendar reconciliation in background
            import('@/lib/calendar/google-sync')
              .then(({ reconcileUserGoogleCalendar }) => reconcileUserGoogleCalendar(userId!))
              .catch((cErr) => console.warn('[Sync Reprocess] Calendar reconcile warning:', cErr));

            await supabaseJob
              .from('reprocess_jobs')
              .update({
                status: 'done',
                step: 5,
                total_steps: 5,
                message: `Complete — ${result.updatedApplications} application(s) updated across ${result.neoPatDrivesCount} drives.`,
                result: {
                  updatedApplications: result.updatedApplications,
                  neoPatDrivesCount: result.neoPatDrivesCount,
                  collegeCircularsLinked: result.collegeCircularsLinked,
                  collegeCircularsDiscarded: result.collegeCircularsDiscarded,
                },
              })
              .eq('id', jobId);
          } catch (err: any) {
            console.error(`[Sync Reprocess] Background job ${jobId} failed:`, err);
            try {
              await supabaseJob
                .from('reprocess_jobs')
                .update({ status: err instanceof MutationBusyError ? 'done' : 'error', message: err?.message || 'Reprocess failed', result: err instanceof MutationBusyError ? { skipped: true, reason: 'sync_busy' } : null })
                .eq('id', jobId);
            } catch (_) {}
          }
        })()
      );

      return NextResponse.json({ jobId, status: 'pending' }, { status: 202 });
    }
  }

  if (isStream) {
    const encoder = new TextEncoder();
    let isClosed = false;
    let heartbeat: NodeJS.Timeout | null = null;
    let streamController: ReadableStreamDefaultController | null = null;

    const cleanup = () => {
      if (isClosed) return;
      isClosed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (streamController) {
        try {
          streamController.close();
        } catch {
          // Stream may already be closed
        }
        streamController = null;
      }
    };

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
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            cleanup();
          }
        };

        heartbeat = setInterval(() => {
          if (isClosed || req.signal.aborted) {
            cleanup();
            return;
          }
          try {
            controller.enqueue(encoder.encode(`: keep-alive\n\n`));
          } catch {
            cleanup();
          }
        }, 2000);

        try {
          sendEvent('start', { message: 'Analyzing placement archive & re-indexing drivesâ€¦' });

          const statusResult = await performReprocess(userId!, (progress) => {
            sendEvent('progress', progress);
          });

          // Trigger calendar reconciliation in background so HTTP response returns instantly
          import('@/lib/calendar/google-sync')
            .then(({ reconcileUserGoogleCalendar }) => reconcileUserGoogleCalendar(userId!))
            .catch((cErr) => console.warn('[Reprocess Route] Calendar reconcile warning:', cErr));

          sendEvent('complete', {
            success: true,
            updatedApplications: statusResult.updatedApplications,
            neoPatDrivesCount: statusResult.neoPatDrivesCount,
            collegeCircularsLinked: statusResult.collegeCircularsLinked,
            collegeCircularsDiscarded: statusResult.collegeCircularsDiscarded,
            fixed: statusResult.updatedApplications,
          });
        } catch (err: any) {
          sendEvent(err instanceof MutationBusyError ? 'complete' : 'error', { skipped: err instanceof MutationBusyError, message: err instanceof Error ? err.message : 'Placement re-indexing failed' });
        } finally {
          cleanup();
        }
      },
      cancel() {
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

  try {
    const statusResult = await performReprocess(userId);

    // Trigger calendar reconciliation in background
    import('@/lib/calendar/google-sync')
      .then(({ reconcileUserGoogleCalendar }) => reconcileUserGoogleCalendar(userId))
      .catch((cErr) => console.warn('[Reprocess Route] Calendar reconcile warning:', cErr));

    return NextResponse.json({
      success: true,
      updatedApplications: statusResult.updatedApplications,
      neoPatDrivesCount: statusResult.neoPatDrivesCount,
      collegeCircularsLinked: statusResult.collegeCircularsLinked,
      collegeCircularsDiscarded: statusResult.collegeCircularsDiscarded,
      fixed: statusResult.updatedApplications,
    });
  } catch (err) {
    console.error('Reprocess failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Placement re-indexing failed' },
      { status: err instanceof MutationBusyError ? 409 : 500 }
    );
  }
}

export async function GET(req: Request) {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
