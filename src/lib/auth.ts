import { cookies } from 'next/headers';
import { verifySessionToken } from '@/lib/security/session';
import type { SessionPayload } from '@/lib/security/session';
export type { SessionPayload } from '@/lib/security/session';

/**
 * Gets the current user session from the HTTP-only cookie.
 * Returns null if no valid session exists.
 */
export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('session')?.value;

  if (!token) return null;

  return verifySessionToken(token);
}

/**
 * Requires a valid session — throws a redirect to login if not authenticated.
 * Use in Server Components.
 */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) {
    // Dynamic import to avoid circular dependency
    const { redirect } = await import('next/navigation');
    redirect('/login');
    throw new Error('Redirecting...');
  }
  return session;
}

/**
 * Resolves the base URL / origin of the incoming request.
 * Handles reverse proxy headers (e.g., Vercel, Cloudflare).
 */
export function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  if (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.origin;
  return 'https://www.wheresmyoffer.in';
}

/**
 * Gets the Google OAuth redirect URI to use for the authorization request.
 * Automatically avoids localhost redirect URIs or mismatched domain URIs when running on a live deployed domain.
 */
export function getOAuthRedirectUri(request: Request): string {
  const origin = getBaseUrl(request);
  if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
    return `${origin}/api/auth/callback`;
  }
  return 'https://www.wheresmyoffer.in/api/auth/callback';
}

export function getAppUrl(request: Request): string {
  const origin = getBaseUrl(request);
  if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
    return origin;
  }
  return 'https://www.wheresmyoffer.in';
}
