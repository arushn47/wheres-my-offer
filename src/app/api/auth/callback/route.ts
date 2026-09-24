import { google } from 'googleapis';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { encrypt } from '@/lib/crypto/tokens';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOAuthRedirectUri, getAppUrl } from '@/lib/auth';
import * as jose from 'jose';

/**
 * GET /api/auth/callback
 * 
 * Handles the OAuth callback from Google.
 * Exchanges the authorization code for tokens, creates/updates the user,
 * stores encrypted tokens, and sets a session cookie.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const stateStr = searchParams.get('state');
  const error = searchParams.get('error');

  const appUrl = getAppUrl(request);
  const redirectUri = getOAuthRedirectUri(request);

  if (error) {
    return NextResponse.redirect(
      `${appUrl}/login?error=${encodeURIComponent(error)}`
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${appUrl}/login?error=no_code`
    );
  }

  const cookieStore = await cookies();
  const expectedState = cookieStore.get('oauth_state')?.value;
  const requestedAccountType = cookieStore.get('oauth_account_type')?.value;
  if (!stateStr || !expectedState || stateStr !== expectedState) {
    return NextResponse.redirect(`${appUrl}/login?error=invalid_oauth_state`);
  }
  cookieStore.set('oauth_state', '', { maxAge: 0, path: '/api/auth/callback' });
  cookieStore.set('oauth_account_type', '', { maxAge: 0, path: '/api/auth/callback' });
  const accountType = requestedAccountType === 'college' ? 'college' : 'personal';

  try {
    // Exchange code for tokens
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      redirectUri
    );

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    if (!userInfo.email || !userInfo.id) {
      return NextResponse.redirect(
        `${appUrl}/login?error=no_email`
      );
    }

    const supabase = createAdminClient();

    // 1. Check if user is already logged in (linking a secondary account)
    const token = cookieStore.get('session')?.value;
    
    let existingUserId: string | null = null;
    let sessionName = userInfo.name || null;
    let sessionEmail = userInfo.email;
    let sessionAvatar = userInfo.picture || null;

    if (token) {
      try {
        const secret = new TextEncoder().encode(process.env.TOKEN_ENCRYPTION_KEY);
        const { payload } = await jose.jwtVerify(token, secret);
        existingUserId = payload.userId as string;
        sessionName = (payload.name as string) || null;
        sessionEmail = payload.email as string;
        sessionAvatar = (payload.avatar as string) || null;
      } catch {
        // Invalid session, proceed as new login
      }
    }

    // Enforce email domain validation
    const isVitCollegeEmail = /@(vitbhopal\.ac\.in|vitstudent\.ac\.in|[a-z0-9.-]+\.vit\.ac\.in|vit\.ac\.in)$/i.test(
      userInfo.email.trim()
    );

    // 1. College account MUST be an official VIT email
    if (accountType === 'college' && !isVitCollegeEmail) {
      const returnTo = existingUserId ? `${appUrl}/settings` : `${appUrl}/login`;
      return NextResponse.redirect(
        `${returnTo}?error=${encodeURIComponent(
          'College email must be your official VIT address (@vitbhopal.ac.in or @vitstudent.ac.in). Personal Gmail cannot be used as college email.'
        )}`
      );
    }

    // 2. Personal account linking while already logged in must NOT be a VIT college email
    if (existingUserId && accountType === 'personal' && isVitCollegeEmail) {
      return NextResponse.redirect(
        `${appUrl}/settings?error=${encodeURIComponent(
          'Please select your Personal Gmail address (where NeoPAT registration emails arrive), not your VIT college email.'
        )}`
      );
    }

    // 3. New user signup on login page must use Personal Gmail first
    if (!existingUserId && accountType === 'personal' && isVitCollegeEmail) {
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .or(`google_id.eq.${userInfo.id},email.eq.${userInfo.email}`)
        .maybeSingle();

      const { data: existingSecondary } = await supabase
        .from('gmail_accounts')
        .select('user_id')
        .eq('google_account_id', userInfo.id)
        .maybeSingle();

      if (!existingUser && !existingSecondary) {
        return NextResponse.redirect(
          `${appUrl}/login?error=${encodeURIComponent(
            'Please sign in with your Personal Gmail address (where NeoPAT registration emails arrive). You can connect your official VIT College email in the next step.'
          )}`
        );
      }
    }

    let userId: string;

    if (existingUserId) {
      // User is already logged in, link this new Gmail to their existing account
      userId = existingUserId;
    } else {
      // No active session — check if they are logging in with a previously linked secondary account
      const { data: existingSecondary } = await supabase
        .from('gmail_accounts')
        .select('user_id')
        .eq('google_account_id', userInfo.id)
        .single();

      if (existingSecondary) {
        // Logging in with a secondary connected account
        userId = existingSecondary.user_id;
        // Fetch primary user info for the session
        const { data: primaryUser } = await supabase
          .from('users')
          .select('email, name, avatar_url')
          .eq('id', userId)
          .single();
        
        if (primaryUser) {
          sessionEmail = primaryUser.email;
          sessionName = primaryUser.name;
          sessionAvatar = primaryUser.avatar_url;
        }
      } else {
        // Check if primary account exists or create a new user
        const { data: user, error: userError } = await supabase
          .from('users')
          .upsert(
            {
              google_id: userInfo.id,
              email: userInfo.email,
              name: userInfo.name || null,
              avatar_url: userInfo.picture || null,
            },
            { onConflict: 'google_id' }
          )
          .select('id')
          .single();

        if (userError || !user) {
          console.error('Failed to upsert user:', userError);
          return NextResponse.redirect(
            `${appUrl}/login?error=db_error`
          );
        }
        userId = user.id;
      }
    }

    // 2. Encrypt and store Gmail tokens for THIS specific account
    const encryptedAccess = tokens.access_token ? encrypt(tokens.access_token) : null;
    const encryptedRefresh = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;

    const { error: gmailError } = await supabase
      .from('gmail_accounts')
      .upsert(
        {
          user_id: userId,
          email: userInfo.email,
          account_type: accountType,
          google_account_id: userInfo.id,
          access_token_encrypted: encryptedAccess,
          refresh_token_encrypted: encryptedRefresh,
          token_expiry: tokens.expiry_date
            ? new Date(tokens.expiry_date).toISOString()
            : null,
          is_connected: true,
        },
        { onConflict: 'user_id,email' }
      );

    if (gmailError) {
      console.error('Failed to store Gmail account:', gmailError);
    } else if (process.env.GOOGLE_PUBSUB_TOPIC) {
      // Automatically register mailbox with Google Cloud Pub/Sub for push notifications
      const { setupGmailWatch } = await import('@/lib/gmail/watch');
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const watchResult = await setupGmailWatch(gmail, process.env.GOOGLE_PUBSUB_TOPIC);
      if (watchResult) {
        // expiration is a Unix timestamp in milliseconds returned as a string by Gmail API
        const watchExpiresAt = new Date(Number(watchResult.expiration)).toISOString();

        // Only update last_history_id if the account already completed its initial discovery sync.
        // If last_history_id is null, keep it null so initial full discovery is not skipped.
        const { data: existingAcc } = await supabase
          .from('gmail_accounts')
          .select('last_history_id')
          .eq('user_id', userId)
          .eq('email', userInfo.email)
          .single();

        await supabase
          .from('gmail_accounts')
          .update({
            watch_expires_at: watchExpiresAt,
            ...(existingAcc?.last_history_id ? { last_history_id: watchResult.historyId } : {}),
          })
          .eq('user_id', userId)
          .eq('email', userInfo.email);

        console.log(`[Pub/Sub] Registered Gmail watch for ${userInfo.email} at historyId ${watchResult.historyId}, expires ${watchExpiresAt}`);
      }
    }

    // 3. Create or refresh the session JWT
    if (!existingUserId) {
      const secret = new TextEncoder().encode(process.env.TOKEN_ENCRYPTION_KEY);
      const sessionToken = await new jose.SignJWT({
        userId,
        email: sessionEmail,
        name: sessionName,
        avatar: sessionAvatar,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('7d')
        .sign(secret);

      cookieStore.set('session', sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7, // 7 days
        path: '/',
      });
    }

    // Redirect: Admins go straight to /admin, students to /
    const { checkIsAdmin } = await import('@/lib/auth/admin');
    const isAdmin = await checkIsAdmin(userId, sessionEmail);
    if (isAdmin) {
      return NextResponse.redirect(`${appUrl}/admin`);
    }

    return NextResponse.redirect(`${appUrl}/`);

  } catch (err) {
    console.error('OAuth callback error:', err);
    return NextResponse.redirect(
      `${appUrl}/login?error=auth_failed`
    );
  }
}
