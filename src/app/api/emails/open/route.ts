import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveOriginalEmail } from '@/lib/gmail/original-email';

const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return new Response('Please sign in to Where’s My Offer and try again.', { status: 401, headers });
  // Also fence direct handler invocation; lookup claims/cache are private database writes.
  if (process.env.DATABASE_WRITES_PAUSED === 'true') return new Response('Maintenance in progress. Please retry shortly.', { status: 503, headers });
  const url = new URL(request.url);
  const source = url.searchParams.get('source');
  const id = url.searchParams.get('id') || '';
  if (!['personal', 'college'].includes(source || '') || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) return new Response('Invalid email link.', { status: 400, headers });
  try {
    const result = await resolveOriginalEmail(createAdminClient(), session.userId, source as 'personal' | 'college', id);
    if (result.kind === 'missing') return new Response('Email or connected Gmail account not found.', { status: 404, headers });
    if (result.kind === 'direct') return new Response(null, { status: 307, headers: { ...headers, Location: result.url } });
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Open original email</title><body style="background:#111;color:#eee;font:16px system-ui;max-width:36rem;margin:12vh auto;padding:24px"><h1 style="font-size:24px">Open original email</h1><p>${escapeHtml(result.reason)}</p><p><a style="color:#34d399" href="${escapeHtml(result.url)}" rel="noreferrer">Open in connected Gmail</a></p><p>Google may ask you to choose or sign in to the connected account.</p></body></html>`, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" } });
  } catch {
    return new Response('Could not open this email. Please retry shortly.', { status: 503, headers });
  }
}
