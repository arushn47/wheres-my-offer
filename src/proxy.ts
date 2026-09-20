import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as jose from 'jose';

/** Routes that don't require authentication */
const PUBLIC_ROUTES = [
  '/login',
  '/privacy',
  '/terms',
  '/feedback',
  '/support',
  '/api/auth/google',
  '/api/auth/callback',
  '/api/cron',
  '/api/admin/migration/phase3',
  '/api/sync/reprocess',
  '/api/webhooks',
];

export async function proxy(request: NextRequest) {
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
  if (host === 'wheresmyoffer.in') {
    const url = request.nextUrl.clone();
    url.host = 'www.wheresmyoffer.in';
    url.port = '';
    url.protocol = 'https:';
    return NextResponse.redirect(url, 308);
  }

  const { pathname } = request.nextUrl;

  // Allow public routes and static assets
  if (
    PUBLIC_ROUTES.some((route) => pathname.startsWith(route)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // Check for session cookie
  const sessionToken = request.cookies.get('session')?.value;

  if (!sessionToken) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  // Verify JWT
  try {
    const secret = new TextEncoder().encode(process.env.TOKEN_ENCRYPTION_KEY);
    await jose.jwtVerify(sessionToken, secret);
    return NextResponse.next();
  } catch {
    // Invalid/expired token — redirect to login
    const loginUrl = new URL('/login', request.url);
    const response = NextResponse.redirect(loginUrl);
    response.cookies.set('session', '', { maxAge: 0, path: '/' });
    return response;
  }
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
