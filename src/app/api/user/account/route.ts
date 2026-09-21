import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { decrypt } from '@/lib/crypto/tokens';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/user/account
 *
 * Full account termination:
 * 1. Revokes Google OAuth refresh/access tokens directly with Google for all connected inboxes.
 * 2. Deletes user record from public.users (cascades and deletes all companies, emails, applications, etc.).
 * 3. Deletes auth identity if present.
 * 4. Clears session cookie so they are signed out completely.
 */
export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session?.userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const userId = session.userId;
  const supabase = createAdminClient();

  try {
    // 1. Fetch connected Gmail accounts to revoke tokens with Google
    const { data: accounts } = await supabase
      .from('gmail_accounts')
      .select('id, access_token_encrypted, refresh_token_encrypted')
      .eq('user_id', userId);

    if (accounts && accounts.length > 0) {
      for (const acc of accounts) {
        const tokenToRevoke = acc.refresh_token_encrypted
          ? decrypt(acc.refresh_token_encrypted)
          : acc.access_token_encrypted
          ? decrypt(acc.access_token_encrypted)
          : null;

        if (tokenToRevoke) {
          try {
            await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenToRevoke)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            });
          } catch (err) {
            console.warn('[Account Deletion] Failed to revoke Google token:', err);
          }
        }
      }
    }

    // 2. Explicitly clean up related tables before user deletion (to ensure clean cascade even without foreign key triggers)
    const cleanupResults = await Promise.all([
      supabase.from('events').delete().eq('user_id', userId),
      supabase.from('candidate_matches').delete().eq('user_id', userId),
      supabase.from('notifications').delete().eq('user_id', userId),
      supabase.from('push_subscriptions').delete().eq('user_id', userId),
      supabase.from('notification_preferences').delete().eq('user_id', userId),
      supabase.from('applications').delete().eq('user_id', userId),
      supabase.from('emails').delete().eq('user_id', userId),
      supabase.from('companies').delete().eq('user_id', userId),
      supabase.from('sync_pages').delete().eq('user_id', userId),
      supabase.from('sync_state').delete().eq('user_id', userId),
      supabase.from('gmail_accounts').delete().eq('user_id', userId),
    ]);
    const cleanupError = cleanupResults.find((result) => result.error)?.error;
    if (cleanupError) {
      console.error('[Account Deletion] Cleanup failed:', cleanupError);
      return NextResponse.json(
        { error: 'Account deletion incomplete; no final deletion confirmation was issued' },
        { status: 500 }
      );
    }

    // 3. Delete user from public.users table
    const { error: deleteUserErr } = await supabase.from('users').delete().eq('id', userId);
    if (deleteUserErr) {
      console.error('[Account Deletion] Failed to delete user from public.users:', deleteUserErr);
      return NextResponse.json(
        { error: 'Account deletion incomplete; user record could not be removed' },
        { status: 500 }
      );
    }

    // 4. Try cleaning up auth user if created via Supabase Auth
    try {
      await supabase.auth.admin.deleteUser(userId);
    } catch {
      // Ignored if user was custom OAuth only
    }

    // 5. Clear session cookie
    const cookieStore = await cookies();
    cookieStore.set('session', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });

    return NextResponse.json({
      success: true,
      message: 'Account and all associated placement data deleted permanently.',
    });
  } catch (err: any) {
    console.error('[Account Deletion Error]:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to terminate account cleanly' },
      { status: 500 }
    );
  }
}
