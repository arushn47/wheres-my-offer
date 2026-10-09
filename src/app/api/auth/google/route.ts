import { google } from 'googleapis';
import { NextResponse } from 'next/server';
import { getOAuthRedirectUri } from '@/lib/auth';
import { randomBytes } from 'node:crypto';
import { CodeChallengeMethod } from 'google-auth-library';

/**
 * GET /api/auth/google
 * 
 * Redirects the user to Google's OAuth consent screen.
 * Query param: ?type=personal|college (to track which account is being connected)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedType = searchParams.get('type') || 'personal';
  const accountType = requestedType === 'college' ? 'college' : 'personal';
  const state = randomBytes(32).toString('base64url');

  const redirectUri = getOAuthRedirectUri(request);

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );

  const scopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.events.owned',
  ];
  const { codeVerifier, codeChallenge } = await oauth2Client.generateCodeVerifierAsync();

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
    state,
    include_granted_scopes: true,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });

  const response = NextResponse.redirect(authUrl);
  response.cookies.set('oauth_code_verifier', codeVerifier, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 10 * 60, path: '/api/auth/callback',
  });
  response.cookies.set('oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60,
    path: '/api/auth/callback',
  });
  response.cookies.set('oauth_account_type', accountType, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60,
    path: '/api/auth/callback',
  });
  return response;
}
