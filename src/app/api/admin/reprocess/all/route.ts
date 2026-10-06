import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { performReprocess } from '@/lib/sync/reprocess';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/admin/reprocess/all
 *
 * Vercel-timeout-safe global reprocess using waitUntil():
 *  1. Creates a reprocess_jobs row with type='all' (status = 'pending')
 *  2. Returns 202 immediately with the jobId
 *  3. waitUntil() processes all students sequentially in the background
 *
 * Client polls GET /api/admin/reprocess/all/status?jobId=<id> every 2s.
 */
export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unauthorized' },
      { status: err.status || 401 }
    );
  }

  const supabase = createAdminClient();

  // Check for an in-flight global job — avoid duplicate runs
  const { data: existing } = await supabase
    .from('reprocess_jobs')
    .select('id, status, created_at')
    .eq('type', 'all')
    .in('status', ['pending', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ jobId: existing.id, status: existing.status, queued: true });
  }

  // Fetch all student users up front (fast query, < 200ms)
  const [{ data: users, error: usersErr }, { data: connectedAccounts }] = await Promise.all([
    supabase
      .from('users')
      .select('id, email, name, role')
      .order('created_at', { ascending: false }),
    supabase
      .from('gmail_accounts')
      .select('user_id')
      .eq('is_connected', true),
  ]);

  if (usersErr || !users) {
    return NextResponse.json({ error: usersErr?.message || 'Failed to fetch users' }, { status: 500 });
  }

  const usersToProcess = users.filter((u) => u.role !== 'admin');

  // Create a single job record representing the whole batch
  const { data: job, error: insertErr } = await supabase
    .from('reprocess_jobs')
    .insert({
      user_id: null, // global job — no single user
      type: 'all',
      status: 'pending',
      step: 0,
      total_steps: usersToProcess.length,
      message: `Queued — ${usersToProcess.length} student accounts to process…`,
    })
    .select('id')
    .single();

  if (insertErr || !job) {
    console.error('[Admin Reprocess All] Failed to create job record:', insertErr);
    return NextResponse.json({ error: 'Failed to create reprocess job' }, { status: 500 });
  }

  const jobId = job.id;

  waitUntil(
    (async () => {
      let processed = 0;
      let totalUpdated = 0;
      const summary: Array<{
        userId: string;
        email: string;
        userName: string;
        updatedApplications: number;
        error?: string;
      }> = [];

      try {
        await supabase
          .from('reprocess_jobs')
          .update({
            status: 'running',
            message: `Processing 0 / ${usersToProcess.length} students…`,
          })
          .eq('id', jobId);

        // Process students in batches of 3 to avoid overwhelming Supabase
        const CONCURRENCY = 3;
        for (let i = 0; i < usersToProcess.length; i += CONCURRENCY) {
          const chunk = usersToProcess.slice(i, i + CONCURRENCY);

          await Promise.all(
            chunk.map(async (u) => {
              const displayName = u.name || u.email.split('@')[0];
              try {
                const result = await performReprocess(u.id);
                const appsUpdated = result?.updatedApplications ?? 0;
                totalUpdated += appsUpdated;
                summary.push({
                  userId: u.id,
                  email: u.email,
                  userName: displayName,
                  updatedApplications: appsUpdated,
                });
              } catch (err: any) {
                console.error(`[Admin Reprocess All] Error for ${u.email}:`, err);
                summary.push({
                  userId: u.id,
                  email: u.email,
                  userName: displayName,
                  updatedApplications: 0,
                  error: err.message,
                });
              }
            })
          );

          processed += chunk.length;

          // Update progress after each batch
          await supabase
            .from('reprocess_jobs')
            .update({
              step: processed,
              message: `Processing ${processed} / ${usersToProcess.length} students…`,
            })
            .eq('id', jobId);
        }

        await supabase
          .from('reprocess_jobs')
          .update({
            status: 'done',
            step: usersToProcess.length,
            message: `Complete — ${usersToProcess.length} students evaluated, ${totalUpdated} applications updated.`,
            result: {
              totalUsersProcessed: summary.length,
              totalApplicationsUpdated: totalUpdated,
              summary,
            },
          })
          .eq('id', jobId);
      } catch (err: any) {
        console.error(`[Admin Reprocess All] Global job ${jobId} failed:`, err);
        try {
          await supabase
            .from('reprocess_jobs')
            .update({
              status: 'error',
              message: err?.message || 'Global reprocess failed',
              result: { totalUsersProcessed: processed, totalApplicationsUpdated: totalUpdated, summary },
            })
            .eq('id', jobId);
        } catch (_) {}
      }
    })()
  );

  return NextResponse.json(
    {
      jobId,
      status: 'pending',
      totalUsers: usersToProcess.length,
      message: `Reprocess queued for ${usersToProcess.length} student accounts.`,
    },
    { status: 202 }
  );
}
