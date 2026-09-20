import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Phase3DiscoverySupabaseClient } from '@/lib/migration/phase3/discovery';
import { runSupabasePhase3Migration, type Phase3RunMode } from '@/lib/migration/phase3/run';
import type { SupabaseRpcLike } from '@/lib/migration/phase3/rpc-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.PHASE3_MIGRATION_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function getConnectedUserIds(supabase: ReturnType<typeof createAdminClient>): Promise<string[]> {
  const { data, error } = await supabase
    .from('gmail_accounts')
    .select('user_id')
    .eq('is_connected', true);

  if (error) throw new Error(`Unable to discover Phase 3 users: ${error.message}`);
  return Array.from(new Set((data || []).map((account) => account.user_id)));
}

async function runForConnectedUsers(mode: Phase3RunMode) {
  const supabase = createAdminClient();
  const userIds = await getConnectedUserIds(supabase);
  const phase3Client = supabase as unknown as Phase3DiscoverySupabaseClient & SupabaseRpcLike;
  return runSupabasePhase3Migration({ supabase: phase3Client, userIds, mode });
}

/** Read-only first real-run entrypoint. Requires PHASE3_MIGRATION_SECRET. */
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await runForConnectedUsers('dry-run');
    return NextResponse.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Phase 3 dry-run failed]', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Explicit execution entrypoint. GET can never write; execute requires POST mode. */
export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { mode?: unknown; userId?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is treated as the safe default dry-run.
  }

  const mode: Phase3RunMode = body.mode === 'execute' ? 'execute' : 'dry-run';

  // An explicit tenant must be honored for dry-runs too. The unscoped path is
  // retained only for aggregate reporting when no userId was supplied.
  if (mode === 'dry-run' && body.userId !== undefined) {
    const requestedUserId = typeof body.userId === 'string' ? body.userId : null;
    if (!requestedUserId || !isUuid(requestedUserId)) {
      return NextResponse.json({ error: 'Dry-run userId must be a valid UUID' }, { status: 400 });
    }
    const supabase = createAdminClient();
    const { data: account, error } = await supabase
      .from('gmail_accounts')
      .select('user_id')
      .eq('user_id', requestedUserId)
      .eq('is_connected', true)
      .limit(1)
      .maybeSingle();
    if (error || !account) {
      return NextResponse.json({ error: 'Requested user is not an eligible connected tenant' }, { status: 403 });
    }
    const phase3Client = supabase as unknown as Phase3DiscoverySupabaseClient & SupabaseRpcLike;
    try {
      return NextResponse.json(await runSupabasePhase3Migration({
        supabase: phase3Client,
        userIds: [requestedUserId],
        mode: 'dry-run',
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Phase 3 tenant dry-run failed]', error);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // Execute mode must target one explicit tenant. The all-connected-users
  // discovery path is retained for dry-run reporting only.
  if (mode === 'execute') {
    const requestedUserId = typeof body.userId === 'string' ? body.userId : null;
    if (!requestedUserId) {
      return NextResponse.json({ error: 'Execute mode requires an explicit userId' }, { status: 400 });
    }
    if (!isUuid(requestedUserId)) {
      return NextResponse.json({ error: 'Execute mode requires a valid UUID userId' }, { status: 400 });
    }
    const supabase = createAdminClient();
    const { data: account, error } = await supabase
      .from('gmail_accounts')
      .select('user_id')
      .eq('user_id', requestedUserId)
      .eq('is_connected', true)
      .limit(1)
      .maybeSingle();
    if (error || !account) {
      return NextResponse.json({ error: 'Requested user is not an eligible connected tenant' }, { status: 403 });
    }
    const phase3Client = supabase as unknown as Phase3DiscoverySupabaseClient & SupabaseRpcLike;
    try {
      return NextResponse.json(await runSupabasePhase3Migration({
        supabase: phase3Client,
        userIds: [requestedUserId],
        mode: 'execute',
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Phase 3 execute failed]', error);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  try {
    const summary = await runForConnectedUsers(mode);
    return NextResponse.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Phase 3 ${mode} failed]`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
