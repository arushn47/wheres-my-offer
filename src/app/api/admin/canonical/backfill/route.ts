import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { backfillCanonicalEmails } from '@/lib/sync/canonical-backfill';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    await requireAdmin();
  } catch (err) {
    const authError = err as Error & { status?: number };
    return NextResponse.json(
      { error: authError.message || 'Unauthorized' },
      { status: authError.status || 401 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false;
    if (!dryRun && (!process.env.ARCHIVE_REFRESH_CONFIRMATION || req.headers.get('x-archive-refresh-confirmation') !== process.env.ARCHIVE_REFRESH_CONFIRMATION)) {
      return NextResponse.json(
        { error: 'Write mode is disabled until the configured archive-refresh confirmation token is provided.' },
        { status: 403 }
      );
    }
    const result = await backfillCanonicalEmails({ dryRun, limit: Math.min(Number(body?.limit) || 100, 200) });
    return NextResponse.json({
      success: true,
      dryRun,
      result,
      message: dryRun
        ? `Canonical backfill preview processed ${result.processed} receipts; no database rows were changed.`
        : `Canonical backfill processed ${result.processed} receipts (${result.linked} linked, ${result.created} new broadcasts created).`,
    });
  } catch (err) {
    console.error('[Admin Canonical Backfill API] Error:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Backfill failed' }, { status: 500 });
  }
}
