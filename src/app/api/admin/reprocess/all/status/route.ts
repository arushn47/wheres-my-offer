import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/reprocess/all/status?jobId=<uuid>
 *
 * Lightweight polling endpoint for global reprocess job status.
 */
export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unauthorized' },
      { status: err.status || 401 }
    );
  }

  const jobId = req.nextUrl.searchParams.get('jobId');

  if (!jobId) {
    return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: job, error } = await supabase
    .from('reprocess_jobs')
    .select('id, type, status, step, total_steps, message, result, created_at, updated_at')
    .eq('id', jobId)
    .single();

  if (error || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  return NextResponse.json(job, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
