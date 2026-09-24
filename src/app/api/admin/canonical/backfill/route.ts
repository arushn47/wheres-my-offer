import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { backfillCanonicalEmails } from '@/lib/sync/canonical-backfill';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST() {
  try {
    await requireAdmin();
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unauthorized' },
      { status: err.status || 401 }
    );
  }

  try {
    const result = await backfillCanonicalEmails({ limit: 200 });
    return NextResponse.json({
      success: true,
      result,
      message: `Canonical backfill processed ${result.processed} receipts (${result.linked} linked, ${result.created} new broadcasts created).`,
    });
  } catch (err: any) {
    console.error('[Admin Canonical Backfill API] Error:', err);
    return NextResponse.json({ error: err.message || 'Backfill failed' }, { status: 500 });
  }
}
