import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * TEMPORARY Phase 3 migration helper.
 * Remove this route after the one-user migration target is configured.
 * It returns only the UUID from the already-validated HTTP-only session cookie.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({ userId: session.userId }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
