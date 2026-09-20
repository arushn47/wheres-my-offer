import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/sync/dedup-companies
 * Company deduplication is disabled now that placement drives are authoritative.
 * Organization merges require a separate, reviewed operation that preserves every drive.
 */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    success: false,
    code: 'drive_identity_authoritative',
    error: 'Company deduplication is disabled. Placement drives must be preserved and handled explicitly.',
  });
}
