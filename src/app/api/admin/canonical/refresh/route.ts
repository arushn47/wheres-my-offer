import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { refreshSharedCollegeArchive } from '@/lib/sync/canonical/shared-archive-refresh';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    await requireAdmin();
  } catch (error) {
    const authError = error as Error & { status?: number };
    return NextResponse.json(
      { error: authError.message || 'Unauthorized' },
      { status: authError.status || 401 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const dryRun = body?.dryRun !== false;
  const limit = Number.isFinite(Number(body?.limit)) ? Math.max(1, Math.min(100, Number(body.limit))) : 100;
  const pageCursor = typeof body?.pageCursor === 'string' ? body.pageCursor : undefined;
  const confirmation = request.headers.get('x-archive-refresh-confirmation');

  if (!dryRun && (!process.env.ARCHIVE_REFRESH_CONFIRMATION || confirmation !== process.env.ARCHIVE_REFRESH_CONFIRMATION)) {
    return NextResponse.json(
      { error: 'Write mode is disabled until the configured archive-refresh confirmation token is provided.' },
      { status: 403 }
    );
  }

  try {
    let before: string;
    let after: string;
    let afterId: string | undefined;
    if (pageCursor) {
      let cursor: { after: string; before: string; pageToken: string; sourceInbox: string };
      try {
        cursor = JSON.parse(Buffer.from(pageCursor, 'base64url').toString('utf8'));
      } catch {
        return NextResponse.json({ error: 'Invalid archive preview page cursor.' }, { status: 400 });
      }
      if (!cursor.after || !cursor.before || !cursor.pageToken || !cursor.sourceInbox) {
        return NextResponse.json({ error: 'Invalid archive preview page cursor.' }, { status: 400 });
      }
      after = cursor.after;
      before = cursor.before;
      afterId = cursor.pageToken;
    } else {
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      before = tomorrow.toISOString().slice(0, 10).replace(/-/g, '/');
      after = typeof body?.after === 'string' ? body.after : '2026/06/30';
    }

    const requestedSourceInbox = typeof body?.sourceInbox === 'string'
      ? body.sourceInbox
      : pageCursor
      ? (JSON.parse(Buffer.from(pageCursor, 'base64url').toString('utf8')) as { sourceInbox: string }).sourceInbox
      : undefined;
    const result = await refreshSharedCollegeArchive({ dryRun, limit, afterId, after, before, sourceInbox: requestedSourceInbox });
    const sourceInbox = requestedSourceInbox || result.sourceInbox || '';
    return NextResponse.json({
      success: true,
      dryRun,
      result,
      pageCursor: result.nextAfterId
        ? Buffer.from(JSON.stringify({ after, before, pageToken: result.nextAfterId, sourceInbox })).toString('base64url')
        : null,
      message: dryRun
        ? `Dry run scanned ${result.scanned} message IDs and evaluated ${result.reused + result.wouldCreate} messages; no database rows were changed.`
        : `Refresh processed ${result.created + result.reused} messages (${result.created} created, ${result.reused} refreshed/reused) and parsed ${result.attachmentsParsed} attachments.`,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Admin Shared College Archive Refresh] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Shared archive refresh failed' },
      { status: 500 }
    );
  }
}
