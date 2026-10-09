const PUBLIC_PATHS = new Set([
  '/login', '/privacy', '/terms', '/feedback', '/support',
  '/api/auth/google', '/api/auth/callback', '/api/cron/sync',
  '/api/admin/migration/phase3', '/api/sync/reprocess', '/api/webhooks/gmail',
  '/favicon.ico', '/sw.js', '/manifest.json', '/icon.svg', '/icon.jpg',
  '/icon-512.png', '/icon-192.png', '/apple-touch-icon.jpg',
  '/googledcf4cda4a3783e34.html', '/robots.txt', '/sitemap.xml', '/opengraph-image',
]);
const MACHINE_PATHS = new Set(['/api/admin/migration/phase3', '/api/sync/reprocess', '/api/webhooks/gmail']);

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) || path.startsWith('/_next/static/') || path === '/_next/image';
}

export function isAllowedMutation(request: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  // Only non-browser, bearer-authenticated workers may omit Origin on these paths.
  // Their handlers still verify the credential before doing any work.
  if (!origin && MACHINE_PATHS.has(url.pathname) && request.headers.get('authorization')) return true;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  if (!origin) return false;
  const allowed = process.env.NODE_ENV === 'production'
    ? ['https://www.wheresmyoffer.in', 'https://wheresmyoffer.in']
    : [url.origin];
  return allowed.includes(origin);
}

export function contentSecurityPolicy(nonce: string, development: boolean): string {
  return [
    "default-src 'self'", `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https://*.googleusercontent.com",
    "font-src 'self'", `connect-src 'self' https://*.supabase.co wss://*.supabase.co${development ? ' ws: wss:' : ''}`,
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "worker-src 'self'",
    ...(development ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}
