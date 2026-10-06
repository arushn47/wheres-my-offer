import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/reprocess/[userId]/status?jobId=<uuid>
 *
 * Lightweight polling endpoint — returns current state of a reprocess job
 * from the reprocess_jobs table. Called every 2s by the client instead of
 * holding an SSE connection that Vercel would kill on Hobby plan.
 */
export async function GET(
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
  const jobId = req.nextUrl.searchParams.get('jobId');

  if (!userId || !jobId) {
    return NextResponse.json({ error: 'Missing userId or jobId' }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: job, error } = await supabase
    .from('reprocess_jobs')
    .select('id, user_id, type, status, step, total_steps, message, result, created_at, updated_at')
    .eq('id', jobId)
    .eq('user_id', userId)
    .single();

  if (error || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  return NextResponse.json(job, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
