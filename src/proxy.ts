import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { verifySessionToken } from '@/lib/security/session';
import { contentSecurityPolicy, isAllowedMutation, isPublicPath } from '@/lib/security/request-policy';
import { apiLimiter, ratePolicy } from '@/lib/security/rate-limit';
import { bodyWithinLimit } from '@/lib/security/body-limit';
import { shouldPauseRequest } from '@/lib/cutover/write-pause';

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

  if (shouldPauseRequest(pathname, request.method, process.env.DATABASE_WRITES_PAUSED === 'true')) {
    return NextResponse.json(
      { error: 'Database maintenance is in progress. Please retry shortly.' },
      { status: 503, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } }
    );
  }

  const api = pathname.startsWith('/api/');
  if (api && !isAllowedMutation(request)) {
    return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const sessionToken = request.cookies.get('session')?.value;
  const session = sessionToken ? await verifySessionToken(sessionToken) : null;
  if (api && !['/api/cron/sync', '/api/webhooks/gmail', '/api/admin/migration/phase3'].includes(pathname)) {
    const policy = ratePolicy(pathname, request.method);
    // Vercel replaces this header at the trusted ingress; never trust it locally.
    const ip = process.env.VERCEL === '1' ? request.headers.get('x-vercel-forwarded-for') || request.headers.get('x-forwarded-for') || 'unknown' : 'local';
    const limited = apiLimiter.consume(`${session?.userId || ip}:${policy.group}`, policy.limit, policy.windowMs);
    if (!limited.allowed) return NextResponse.json({ error: 'Too many requests. Please retry shortly.' }, { status: 429, headers: { 'Retry-After': String(limited.retryAfter), 'Cache-Control': 'no-store' } });
  }
  if (!isPublicPath(pathname) && !session) {
    const response = api
      ? NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
      : NextResponse.redirect(new URL('/login', request.url));
    if (sessionToken) response.cookies.set('session', '', { maxAge: 0, path: '/' });
    return response;
  }

  if (api && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !(await bodyWithinLimit(request, pathname === '/api/feedback' ? 64 * 1024 : 256 * 1024))) {
    return NextResponse.json({ error: 'Request body is too large or invalid' }, { status: 413 });
  }

  const headers = new Headers(request.headers);
  const nonce = randomBytes(16).toString('base64');
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV !== 'production');
  // Override caller-supplied values. Next.js uses the request CSP for script nonces.
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  if (api) response.headers.set('Cache-Control', 'private, no-store');
  return response;
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
