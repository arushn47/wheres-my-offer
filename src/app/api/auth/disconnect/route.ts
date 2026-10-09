import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { describeError } from '@/lib/error-diagnostics';

/**
 * POST /api/auth/disconnect
 * 
 * Disconnects a Gmail account by clearing its tokens.
 * Body: { gmail_account_id: string }
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: { message: 'Unauthorized', code: 'unauthorized' } }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.gmail_account_id !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(body.gmail_account_id)) return NextResponse.json({ error: { message: 'Invalid account ID', code: 'bad_request' } }, { status: 400 });
  const { gmail_account_id } = body;

  if (!gmail_account_id) {
    return NextResponse.json(
      { error: { message: 'gmail_account_id is required', code: 'bad_request' } },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();

  // Verify the account belongs to this user
  const { data: account } = await supabase
    .from('gmail_accounts')
    .select('id, user_id, email, account_type, access_token_encrypted, refresh_token_encrypted, token_expiry, last_sync_at, last_history_id')
    .eq('id', gmail_account_id)
    .eq('user_id', session.userId)
    .single();

  if (!account) {
    return NextResponse.json(
      { error: { message: 'Account not found', code: 'not_found' } },
      { status: 404 }
    );
  }

  // Deregister watch from Google's servers before clearing tokens
  try {
    const { createGmailClient } = await import('@/lib/gmail/client');
    const { stopGmailWatch } = await import('@/lib/gmail/watch');
    const { gmail } = await createGmailClient(account);
    await stopGmailWatch(gmail);
  } catch (watchErr) {
    console.warn(`[Disconnect] Failed to stop Gmail watch for ${account.email}:`, describeError(watchErr));
  }

  // Clear tokens and mark as disconnected
  const { error } = await supabase
    .from('gmail_accounts')
    .update({
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expiry: null,
      is_connected: false,
      watch_expires_at: null,
    })
    .eq('id', gmail_account_id)
    .eq('user_id', session.userId);

  if (error) {
    return NextResponse.json(
      { error: { message: 'Failed to disconnect account', code: 'db_error' } },
      { status: 500 }
    );
  }

  return NextResponse.json({ data: { success: true }, error: null });
}

/**
 * DELETE /api/auth/disconnect
 * 
 * Logs out the user by clearing the session cookie.
 */
export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.set('session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });

  return NextResponse.json({ data: { success: true }, error: null });
}
