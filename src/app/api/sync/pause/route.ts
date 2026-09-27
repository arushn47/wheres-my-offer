import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { requestUserSyncPause } from '@/lib/sync/engine';

export const dynamic = 'force-dynamic';

export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const accepted = requestUserSyncPause(session.userId);
  if (!accepted) return NextResponse.json({ error: 'Sync is running on another server instance; pause request could not be routed.' }, { status: 409 });
  return NextResponse.json({ success: true, message: 'Sync will pause at the next saved batch checkpoint.' });
}
