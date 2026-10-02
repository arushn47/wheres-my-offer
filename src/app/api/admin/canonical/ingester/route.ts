import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { isSupportedWorkbookAttachment } from '@/lib/sync/attachment-status';
import { isPdfAttachment } from '@/lib/sync/pdf-parser';

export const dynamic = 'force-dynamic';

let cachedIngesterPayload: { data: any; expiresAt: number } | null = null;

export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    const authError = error as Error & { status?: number };
    return NextResponse.json(
      { error: authError.message || 'Unauthorized' },
      { status: authError.status || 401 }
    );
  }

  // Serve short 15-second memory cache to eliminate bursts from sidebar navigations
  const now = Date.now();
  if (cachedIngesterPayload && cachedIngesterPayload.expiresAt > now) {
    return NextResponse.json(cachedIngesterPayload.data, {
      headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=30' },
    });
  }

  const supabase = createAdminClient();
  try {
    const { data: stateRows, error: stateError } = await supabase
      .from('shared_college_sync_state')
      .select('gmail_account_id,is_syncing,phase,initial_scan_complete,next_page_token,pending_message_ids,pending_offset,updated_at,lease_expires_at,last_error')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (stateError) throw stateError;
    const state = stateRows?.[0] ?? null;

    if (!state) {
      return NextResponse.json({ ingester: null }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const [accountResult, archiveResult, attachmentResult, attachmentStatusResult] = await Promise.all([
      supabase.from('gmail_accounts').select('email,is_connected,last_sync_at,last_history_id').eq('id', state.gmail_account_id).maybeSingle(),
      supabase.from('college_emails').select('id', { count: 'exact', head: true }),
      supabase.from('college_attachments').select('id', { count: 'exact', head: true }),
      // Exclude complete attachments to avoid fetching hundreds of parsed rows every poll
      supabase.from('college_attachments').select('id,filename,parse_status').neq('parse_status', 'complete'),
    ]);
    for (const result of [accountResult, archiveResult, attachmentResult, attachmentStatusResult]) {
      if (result.error) throw result.error;
    }

    const pendingIds = Array.isArray(state.pending_message_ids) ? state.pending_message_ids : [];
    const attachmentRows = attachmentStatusResult.data || [];
    // `error` is now reserved for retryable workbook failures. Unsupported formats live in
    // the terminal `deferred` (PDF/DOC/DOCX, future JD parsing) and `ignored` (images)
    // states, and legacy non-workbook `error` rows are still reported as unsupported.
    const unsupportedAttachments = attachmentRows.filter((attachment) =>
      (attachment.parse_status === 'deferred' && !isPdfAttachment(attachment.filename || '')) ||
      attachment.parse_status === 'ignored' ||
      (attachment.parse_status === 'error' && !isSupportedWorkbookAttachment(attachment.filename || '') && !isPdfAttachment(attachment.filename || ''))
    ).length;
    const failedAttachments = attachmentRows.filter((attachment) =>
      attachment.parse_status === 'error' &&
      (isSupportedWorkbookAttachment(attachment.filename || '') || isPdfAttachment(attachment.filename || ''))
    ).length;
    const payload = {
      ingester: {
        inbox: accountResult.data?.email || null,
        connected: Boolean(accountResult.data?.is_connected),
        isSyncing: state.is_syncing && Boolean(state.lease_expires_at) && new Date(state.lease_expires_at).getTime() > Date.now(),
        phase: state.phase,
        initialScanComplete: state.initial_scan_complete,
        hasMoreArchivePages: Boolean(state.next_page_token),
        pendingMessages: Math.max(0, pendingIds.length - (state.pending_offset || 0)),
        updatedAt: state.updated_at,
        lastSyncAt: accountResult.data?.last_sync_at || null,
        lastHistoryId: accountResult.data?.last_history_id || null,
        lastError: state.last_error,
        canonicalEmails: archiveResult.count || 0,
        attachments: attachmentResult.count || 0,
        failedAttachments,
        unsupportedAttachments,
      },
    };

    cachedIngesterPayload = {
      data: payload,
      expiresAt: Date.now() + 15_000,
    };

    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=30' },
    });
  } catch (error) {
    console.error('[Admin Shared College Ingester] Status query failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load shared College ingester status' },
      { status: 500 }
    );
  }
}
