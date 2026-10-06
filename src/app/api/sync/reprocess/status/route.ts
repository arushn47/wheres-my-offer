import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * GET /api/sync/reprocess/status?jobId=<uuid>
 *
 * Lightweight polling endpoint for user-facing reprocess job status.
 * The user can only poll their own job (session.userId must match job.user_id).
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session?.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId) {
    return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: job, error } = await supabase
    .from('reprocess_jobs')
    .select('id, user_id, type, status, step, total_steps, message, result, created_at, updated_at')
    .eq('id', jobId)
    .eq('user_id', session.userId) // scope to this user only
    .single();

  if (error || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  return NextResponse.json(job, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
