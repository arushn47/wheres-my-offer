import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/** Passive, authenticated version check. Never dispatches a Gmail sync. */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const admin = createAdminClient();
  const [application, sync] = await Promise.all([
    admin.from('applications').select('last_updated').eq('user_id', session.userId)
      .order('last_updated', { ascending: false }).limit(1).maybeSingle(),
    admin.from('sync_state').select('is_syncing,updated_at,lease_expires_at').eq('user_id', session.userId).maybeSingle(),
  ]);
  if (application.error || sync.error) return NextResponse.json({ error: 'Update check unavailable' }, { status: 503 });
  const state = sync.data;
  const active = Boolean(state?.is_syncing && (state.lease_expires_at
    ? Date.parse(state.lease_expires_at) > Date.now()
    : Date.now() - Date.parse(state.updated_at) < 90_000));
  return NextResponse.json({ version: application.data?.last_updated || null, isSyncing: active }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
