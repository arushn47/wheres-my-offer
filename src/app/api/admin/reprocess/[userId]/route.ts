import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { performReprocess } from '@/lib/sync/reprocess';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/admin/reprocess/[userId]
 *
 * Vercel-timeout-safe reprocess using waitUntil():
 *  1. Creates a reprocess_jobs row (status = 'pending')
 *  2. Returns 202 immediately with the jobId
 *  3. waitUntil() keeps the heavy computation alive in background
 *     even after the HTTP response is sent — no SSE connection needed.
 *
 * Client polls GET /api/admin/reprocess/[userId]/status?jobId=<id> every 2s.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    await requireAdmin();
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unauthorized' },
      { status: err.status || 401 }
    );
  }

  const { userId } = await params;
  if (!userId) {
    return NextResponse.json({ error: 'Missing userId parameter' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Check for a recent in-flight job for this user — avoid duplicate runs
  const { data: existing } = await supabase
    .from('reprocess_jobs')
    .select('id, status, created_at')
    .eq('user_id', userId)
    .in('status', ['pending', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    // A job is already running — return its ID so the client can poll it
    return NextResponse.json({ jobId: existing.id, status: existing.status, queued: true });
  }

  // Create a new job record
  const { data: job, error: insertErr } = await supabase
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

  if (insertErr || !job) {
    console.error('[Admin Reprocess] Failed to create job record:', insertErr);
    return NextResponse.json({ error: 'Failed to create reprocess job' }, { status: 500 });
  }

  const jobId = job.id;

  // Use waitUntil() — lets the heavy computation continue running AFTER the
  // HTTP response is returned. This sidesteps Vercel's response timeout completely.
  waitUntil(
    (async () => {
      try {
        // Mark as running
        await supabase
          .from('reprocess_jobs')
          .update({ status: 'running', step: 1, message: 'Cleaning recipient matches & fetching stored circulars…' })
          .eq('id', jobId);

        const result = await performReprocess(userId, async (progress) => {
          // Write progress to DB so client can poll it
          await supabase
            .from('reprocess_jobs')
            .update({
              step: progress.step,
              total_steps: progress.totalSteps,
              message: progress.message,
            })
            .eq('id', jobId);
        });

        // Mark done
        await supabase
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
        console.error(`[Admin Reprocess] Background job ${jobId} failed:`, err);
        try {
          await supabase
            .from('reprocess_jobs')
            .update({
              status: 'error',
              message: err?.message || 'Reprocess failed',
            })
            .eq('id', jobId);
        } catch (_) {}
      }
    })()
  );

  // Return immediately — client polls /status?jobId=<id>
  return NextResponse.json({ jobId, status: 'pending' }, { status: 202 });
}
