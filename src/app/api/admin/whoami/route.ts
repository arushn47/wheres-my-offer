import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';

export const dynamic = 'force-dynamic';

/**
 * TEMPORARY Phase 3 migration helper.
 * Remove this route after the one-user migration target is configured.
 * It returns only the UUID from the already-validated HTTP-only session cookie.
 */
export async function GET() {
  try {
    const session = await requireAdmin();
    return NextResponse.json({ userId: session.userId }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = (error as { status?: number }).status || 403;
    return NextResponse.json({ error: 'Unauthorized' }, { status });
  }
}
