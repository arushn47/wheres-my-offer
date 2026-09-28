import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

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

  const supabase = createAdminClient();
  try {
    const { data: state, error: stateError } = await supabase
      .from('shared_college_sync_state')
      .select('gmail_account_id,is_syncing,phase,initial_scan_complete,next_page_token,pending_message_ids,pending_offset,updated_at,lease_expires_at,last_error')
      .maybeSingle();
    if (stateError) throw stateError;

    if (!state) {
      return NextResponse.json({ ingester: null }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const [accountResult, archiveResult, attachmentResult, failedAttachmentResult] = await Promise.all([
      supabase.from('gmail_accounts').select('email,is_connected,last_sync_at,last_history_id').eq('id', state.gmail_account_id).maybeSingle(),
      supabase.from('college_emails').select('id', { count: 'exact', head: true }),
      supabase.from('college_attachments').select('id', { count: 'exact', head: true }),
      supabase.from('college_attachments').select('id,filename,parse_error').eq('parse_status', 'error'),
    ]);
    for (const result of [accountResult, archiveResult, attachmentResult, failedAttachmentResult]) {
      if (result.error) throw result.error;
    }

    const pendingIds = Array.isArray(state.pending_message_ids) ? state.pending_message_ids : [];
    const failedAttachments = failedAttachmentResult.data || [];
    const unsupportedAttachments = failedAttachments.filter((attachment) =>
      !/\.(xlsx|xls|csv)$/i.test(attachment.filename || '')
    ).length;
    return NextResponse.json({
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
        failedAttachments: failedAttachments.length - unsupportedAttachments,
        unsupportedAttachments,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Admin Shared College Ingester] Status query failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load shared College ingester status' },
      { status: 500 }
    );
  }
}
