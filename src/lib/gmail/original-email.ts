import { createHash, randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import { decrypt } from '@/lib/crypto/tokens';
import type { createAdminClient } from '@/lib/supabase/admin';
import { cleanRfcMessageId, directGmailLink, searchGmailLink, uniqueGmailTarget, validGmailId } from './message-link';

type Admin = ReturnType<typeof createAdminClient>;
export type OriginalEmailResult = { kind: 'direct'; url: string } | { kind: 'fallback'; url: string; reason: string } | { kind: 'missing' };

/** Click-only, authenticated source resolution. Canonical circulars are public to connected students;
 * personal receipts and mailbox IDs must always belong to this user and exact Gmail account. */
export async function resolveOriginalEmail(admin: Admin, userId: string, source: 'personal' | 'college', id: string): Promise<OriginalEmailResult> {
  let accountId: string | undefined;
  let rfcId: string | undefined;
  let storedId: string | undefined;
  if (source === 'personal') {
    const { data, error } = await admin.from('personal_emails').select('gmail_account_id,thread_id,gmail_message_id,rfc_message_id').eq('id', id).eq('user_id', userId).maybeSingle();
    if (error) throw error;
    if (!data) return { kind: 'missing' };
    accountId = data.gmail_account_id;
    rfcId = cleanRfcMessageId(data.rfc_message_id);
    storedId = validGmailId(data.thread_id) ? data.thread_id : validGmailId(data.gmail_message_id) ? data.gmail_message_id : undefined;
  } else {
    const { data, error } = await admin.from('college_emails').select('message_id,classification').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data || data.classification === 'irrelevant') return { kind: 'missing' };
    rfcId = cleanRfcMessageId(data.message_id);
  }
  let query = admin.from('gmail_accounts').select('id,email,google_account_id,account_type,is_connected,access_token_encrypted,refresh_token_encrypted,token_expiry').eq('user_id', userId);
  query = accountId ? query.eq('id', accountId) : query.eq('account_type', 'college');
  const { data: account, error: accountError } = await query.maybeSingle();
  if (accountError) throw accountError;
  if (!account) return { kind: 'missing' };
  const fallback = (reason: string): OriginalEmailResult => ({ kind: 'fallback', url: searchGmailLink(account.email, rfcId), reason });
  if (!account.is_connected) return fallback('Reconnect this Gmail account in Settings, or open Gmail below.');
  if (storedId) return { kind: 'direct', url: directGmailLink(account.email, storedId) };
  if (source === 'college') {
    const { data: receipts, error } = await admin.from('personal_emails').select('thread_id,gmail_message_id')
      .eq('user_id', userId).eq('gmail_account_id', account.id)
      .or(`college_email_id.eq.${id},canonical_email_id.eq.${id}`).limit(2);
    if (error) throw error;
    const targets = new Set((receipts || []).map(row => validGmailId(row.thread_id) ? row.thread_id : validGmailId(row.gmail_message_id) ? row.gmail_message_id : undefined).filter(Boolean));
    if (targets.size === 1) return { kind: 'direct', url: directGmailLink(account.email, [...targets][0]!) };
  }
  if (!rfcId) return fallback('An exact message identifier is unavailable. Open the connected inbox below.');
  if (!account.refresh_token_encrypted) return fallback('Reconnect this Gmail account in Settings, or use exact-message search below.');

  // A reconnect changes the encrypted refresh credential. Never reuse a mapping from another connection.
  const version = createHash('sha256').update(`${account.google_account_id}:${account.refresh_token_encrypted}`).digest('hex');
  const claim = randomUUID();
  const { data: cache, error: cacheError } = await admin.rpc('claim_original_email_lookup', {
    p_user_id: userId, p_account_id: account.id, p_source_key: `${source}:${id}`, p_connection_version: version, p_claim: claim,
  });
  if (cacheError) return fallback('Direct opening is temporarily unavailable. Use exact-message search below.');
  if (cache?.state === 'ready' && validGmailId(cache.threadId)) return { kind: 'direct', url: directGmailLink(account.email, cache.threadId) };
  if (cache?.state !== 'lookup') return fallback('No direct target is available yet. Retry shortly, or use exact-message search below.');
  let target: string | undefined;
  let reason = 'The exact message was not uniquely found in this mailbox. Use exact-message search below.';
  try {
    // Deliberately do not use createGmailClient: its refresh failure path changes account/sync state.
    const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    auth.setCredentials({ refresh_token: decrypt(account.refresh_token_encrypted),
      access_token: account.access_token_encrypted ? decrypt(account.access_token_encrypted) : undefined,
      expiry_date: account.token_expiry ? Date.parse(account.token_expiry) : undefined });
    const gmail = google.gmail({ version: 'v1', auth });
    const { data } = await gmail.users.messages.list({ userId: 'me', q: `rfc822msgid:<${rfcId}>`, maxResults: 2, includeSpamTrash: true, fields: 'messages(id,threadId),nextPageToken' }, { timeout: 10000, retry: false });
    target = uniqueGmailTarget(data);
  } catch {
    // Don't log tokens, private RFC IDs, provider request URLs or email contents.
    reason = 'Gmail could not resolve this message now. Retry later, reconnect in Settings if needed, or use exact-message search below.';
  }
  await admin.rpc('complete_original_email_lookup', { p_account_id: account.id, p_source_key: `${source}:${id}`, p_claim: claim, p_thread_id: target || null });
  return target ? { kind: 'direct', url: directGmailLink(account.email, target) } : fallback(reason);
}
