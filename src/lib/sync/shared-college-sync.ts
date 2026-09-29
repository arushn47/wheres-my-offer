import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { createGmailClient, type GmailAccount } from '@/lib/gmail/client';
import { fetchHistoryChanges, getProfileHistoryId } from '@/lib/gmail/history';
import { ingestSharedCollegeCircular, fanOutSharedCollegeArchiveToUser } from '@/lib/sync/shared-college-ingest';
import { getInitialArchivePageState } from '@/lib/sync/shared-college-state';

// No user-specific default: the shared College ingester must run on whichever College
// inbox is connected, not one student's address. The first connected College inbox wins.
const MAX_BATCH_SIZE = 40;

interface SharedSyncState {
  initial_scan_complete: boolean;
  next_page_token: string | null;
  pending_message_ids: string[];
  pending_offset: number;
  pending_next_page_token: string | null;
  pending_history_id: string | null;
}

async function checkpoint(
  supabase: ReturnType<typeof createAdminClient>,
  accountId: string,
  runId: string,
  state: SharedSyncState
) {
  const { data, error } = await supabase.rpc('checkpoint_shared_college_sync', {
    p_account_id: accountId,
    p_run_id: runId,
    p_initial_complete: state.initial_scan_complete,
    p_next_page_token: state.next_page_token,
    p_pending_message_ids: state.pending_message_ids,
    p_pending_offset: state.pending_offset,
    p_pending_next_page_token: state.pending_next_page_token,
    p_pending_history_id: state.pending_history_id,
    p_lease_seconds: 180,
  });
  if (error || data !== true) throw new Error(error?.message || 'Shared College sync lease/checkpoint lost.');
}

export async function runSharedCollegeSync(options: { limit?: number } = {}) {
  const supabase = createAdminClient();
  const requestedEmail = (process.env.SHARED_COLLEGE_EMAIL || '').toLowerCase();
  const { data: accounts, error: accountsError } = await supabase
    .from('gmail_accounts')
    .select('id,email,account_type,access_token_encrypted,refresh_token_encrypted,token_expiry,last_sync_at,last_history_id')
    .eq('account_type', 'college')
    .eq('is_connected', true)
    .order('email', { ascending: true });
  if (accountsError) throw accountsError;
  // Explicit env override when set; otherwise the first connected College inbox is the
  // shared broadcast source. Every subscribed College inbox receives the same broadcast,
  // so any one of them ingests the identical canonical archive.
  const account = (requestedEmail
    ? (accounts || []).find((candidate) => candidate.email.toLowerCase() === requestedEmail)
    : (accounts || [])[0]) || null;
  if (!account) throw new Error('No connected College Gmail inbox is available for the shared College ingester.');

  const runId = randomUUID();
  const { data: acquired, error: acquireError } = await supabase.rpc('acquire_shared_college_sync_lease', {
    p_account_id: account.id,
    p_run_id: runId,
    p_lease_seconds: 180,
  });
  if (acquireError) throw new Error(`Could not acquire shared College lease: ${acquireError.message}`);
  if (acquired !== true) return { alreadyRunning: true, inbox: account.email, fetched: 0, ingested: 0, skipped: 0, failed: 0, hasMore: true, fannedOutUsers: 0 };

  let ingested = 0;
  let skipped = 0;
  let failed = 0;
  let fetched = 0;
  let hasMore = false;
  let fanOutNeeded = false;
  try {
    const { gmail } = await createGmailClient(account as GmailAccount);
    const { data: rawState, error: stateError } = await supabase
      .from('shared_college_sync_state')
      .select('initial_scan_complete,next_page_token,pending_message_ids,pending_offset,pending_next_page_token,pending_history_id')
      .eq('gmail_account_id', account.id)
      .single();
    if (stateError) throw stateError;

    const state: SharedSyncState = {
      initial_scan_complete: rawState.initial_scan_complete,
      next_page_token: rawState.next_page_token,
      pending_message_ids: rawState.pending_message_ids || [],
      pending_offset: rawState.pending_offset || 0,
      pending_next_page_token: rawState.pending_next_page_token,
      pending_history_id: rawState.pending_history_id,
    };
    // A run that dies right after consuming its last pending message never commits
    // the end-of-run transition. Resuming with that fully consumed batch made the
    // worker skip the listing branch, declare the initial scan complete, and drop a
    // still-valid page cursor (or a history cursor) on the floor. Clear the spent
    // batch up front so the normal listing/history pass owns the next decision.
    if (state.pending_message_ids.length > 0 && state.pending_offset >= state.pending_message_ids.length) {
      state.pending_message_ids = [];
      state.pending_offset = 0;
      state.pending_next_page_token = null;
    }

    const { isInitialArchiveScan } = getInitialArchivePageState(state);

    // Resume a previously fetched batch before asking Gmail for more IDs.
    if (state.pending_message_ids.length === 0 && state.pending_history_id && !isInitialArchiveScan) {
      // The prior history batch completed; only now advance the mailbox history cursor.
      const { error: historyCheckpointError } = await supabase
        .from('gmail_accounts')
        .update({ last_history_id: state.pending_history_id, last_sync_at: new Date().toISOString() })
        .eq('id', account.id);
      if (historyCheckpointError) throw historyCheckpointError;
      state.pending_history_id = null;
    }

    if (state.pending_message_ids.length === 0 && isInitialArchiveScan) {
      // Snapshot the mailbox cursor before listing the initial archive. Any mail
      // arriving during the paginated scan is then visible to the subsequent
      // history pass rather than being skipped by a cursor captured afterward.
      if (!state.pending_history_id) {
        state.pending_history_id = await getProfileHistoryId(gmail);
      }
      const listed = await gmail.users.messages.list({
        userId: 'me',
        q: 'from:vitlions2027@vitbhopal.ac.in after:2026/06/30',
        maxResults: 100,
        pageToken: state.next_page_token || undefined,
      });
      state.pending_message_ids = (listed.data.messages || []).map((message) => message.id).filter((id): id is string => Boolean(id));
      state.pending_offset = 0;
      state.pending_next_page_token = listed.data.nextPageToken || null;
    } else if (state.pending_message_ids.length === 0 && state.initial_scan_complete && account.last_history_id) {
      const history = await fetchHistoryChanges(gmail, account.last_history_id);
      if (history.historyExpired) {
        state.initial_scan_complete = false;
        state.next_page_token = null;
        state.pending_history_id = null;
        state.pending_next_page_token = null;
        state.pending_message_ids = [];
        state.pending_offset = 0;
      } else {
          const deleted = new Set(history.deletedMessageIds);
          state.pending_message_ids = history.messageIds.filter((id) => !deleted.has(id));
          fanOutNeeded = state.pending_message_ids.length > 0;
        state.pending_offset = 0;
        state.pending_next_page_token = null;
        state.pending_history_id = history.latestHistoryId;
      }
    } else if (state.pending_message_ids.length === 0 && state.initial_scan_complete && !account.last_history_id) {
      state.pending_history_id = await getProfileHistoryId(gmail);
    }

    const { completingPendingInitialPage, completingLastInitialPage } = getInitialArchivePageState(state);

    const limit = Math.max(1, Math.min(options.limit || MAX_BATCH_SIZE, 100));
    const batch = state.pending_message_ids.slice(state.pending_offset, state.pending_offset + limit);
    fetched = batch.length;
    await checkpoint(supabase, account.id, runId, state);

    for (let index = 0; index < batch.length; index++) {
      const messageId = batch[index];
      try {
        const result = await ingestSharedCollegeCircular({ account: account as GmailAccount, gmailMessageId: messageId, gmail });
        if (result.canonicalId) ingested++;
        else skipped++;
      } catch (error) {
        failed++;
        console.error(`[Shared College Sync] Failed message ${messageId}:`, error);
        break; // Leave this and later messages pending for the next run.
      }
      state.pending_offset++;
      await checkpoint(supabase, account.id, runId, state);
    }

    const batchFinished = state.pending_offset >= state.pending_message_ids.length;
    if (batchFinished && completingPendingInitialPage) {
      state.pending_message_ids = [];
      state.pending_offset = 0;
      state.next_page_token = state.pending_next_page_token;
      state.pending_next_page_token = null;
      state.initial_scan_complete = false;
      hasMore = true;
    } else if (batchFinished && completingLastInitialPage) {
      state.pending_message_ids = [];
      state.pending_offset = 0;
      state.next_page_token = null;
      state.pending_next_page_token = null;
      state.initial_scan_complete = true;
      fanOutNeeded = true;
      hasMore = false;
    } else if (batchFinished && state.pending_message_ids.length > 0 && state.pending_history_id) {
      state.pending_message_ids = [];
      state.pending_offset = 0;
      state.pending_next_page_token = null;
      hasMore = false;
    } else if (batchFinished) {
      state.pending_message_ids = [];
      state.pending_offset = 0;
      hasMore = false;
    } else {
      hasMore = true;
    }

    let fannedOutUsers = 0;
    if (!hasMore && failed === 0 && fanOutNeeded) {
      const { data: users, error: usersError } = await supabase.from('users').select('id').not('neo_id', 'is', null);
      if (usersError) throw usersError;
      for (const user of users || []) {
        await fanOutSharedCollegeArchiveToUser(user.id);
        fannedOutUsers++;
      }
      // Persist the cursor associated with this exact Gmail list/history read.
      // Advancing to a newer profile cursor here can skip messages that arrive
      // after the listed batch but before this checkpoint.
      const latestHistory = state.pending_history_id;
      const { error: accountCheckpointError } = await supabase
        .from('gmail_accounts')
        .update({ last_history_id: latestHistory || account.last_history_id, last_sync_at: new Date().toISOString() })
        .eq('id', account.id);
      if (accountCheckpointError) throw accountCheckpointError;
      state.pending_history_id = null;
      state.initial_scan_complete = true;
    }

    // History can advance for non-message changes (for example deletes or label
    // updates). Commit that cursor even when there are no message IDs to fan out,
    // otherwise every worker pass rereads the same empty history range forever.
    if (
      batchFinished &&
      failed === 0 &&
      state.pending_history_id &&
      (!isInitialArchiveScan || completingLastInitialPage)
    ) {
      const { error: historyCheckpointError } = await supabase
        .from('gmail_accounts')
        .update({ last_history_id: state.pending_history_id, last_sync_at: new Date().toISOString() })
        .eq('id', account.id);
      if (historyCheckpointError) throw historyCheckpointError;
      state.pending_history_id = null;
    }

    await checkpoint(supabase, account.id, runId, state);
    return { alreadyRunning: false, inbox: account.email, fetched, ingested, skipped, failed, hasMore, fannedOutUsers };
  } finally {
    const { error: releaseError } = await supabase.rpc('release_shared_college_sync_lease', {
      p_account_id: account.id,
      p_run_id: runId,
      p_last_error: failed ? `${failed} message(s) failed; pending offset retained.` : null,
    });
    if (releaseError) console.error('[Shared College Sync] Lease release failed:', releaseError.message);
  }
}
