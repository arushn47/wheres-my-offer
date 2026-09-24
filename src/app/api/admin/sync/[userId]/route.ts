import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { runSync } from '@/lib/sync/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(
  _request: NextRequest,
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

  try {
    const body = await _request.json().catch(() => ({}));
    const force = Boolean(body?.force);
    const result = await runSync(userId, undefined, { force });
    return NextResponse.json({
      success: !result.alreadyRunning,
      alreadyRunning: result.alreadyRunning || false,
      result,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Admin sync failed' },
      { status: 500 }
    );
  }
}
