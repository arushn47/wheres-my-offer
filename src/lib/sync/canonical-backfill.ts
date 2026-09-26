import { createGmailClient, fetchMessageDetail, type GmailAccount } from '@/lib/gmail/client';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  CANONICAL_IDENTITY_VERSION,
  APPROVED_COLLEGE_SENDER,
  canonicalBodyFromEmail,
  computeCanonicalMetadataKey,
  computeCanonicalContentKey,
  isApprovedCanonicalSender,
  normalizeRfcMessageId,
  extractSenderAddress,
} from '@/lib/sync/canonical-email';

const BATCH_SIZE = 25;

export interface CanonicalBackfillOptions {
  userId?: string;
  limit?: number;
  afterId?: string;
  dryRun?: boolean;
}

export interface CanonicalBackfillResult {
  processed: number;
  linked: number;
  skipped: number;
  failed: number;
  created: number;
  reused: number;
  nextAfterId: string | null;
}

export async function backfillCanonicalEmails(
  options: CanonicalBackfillOptions = {},
  client = createAdminClient()
): Promise<CanonicalBackfillResult> {
  const result: CanonicalBackfillResult = {
    processed: 0, linked: 0, skipped: 0, failed: 0, created: 0, reused: 0, nextAfterId: null,
  };
  const max = Math.max(1, Math.min(options.limit || BATCH_SIZE, 500));

  let query = client
    .from('personal_emails')
    .select('id, user_id, gmail_account_id, gmail_message_id, sender, subject, body_snippet, rfc_message_id, assignment_source')
    .is('canonical_email_id', null)
    .ilike('sender', `%${APPROVED_COLLEGE_SENDER}%`)
    .or('assignment_source.is.null,assignment_source.neq.admin_unlinked')
    .order('id', { ascending: true })
    .limit(max);
  if (options.userId) query = query.eq('user_id', options.userId);
  if (options.afterId) query = query.gt('id', options.afterId);

  const { data: receipts, error } = await query;
  if (error) throw error;
  if (!receipts || receipts.length === 0) return result;

  const accountIds = Array.from(new Set(receipts.map((row) => row.gmail_account_id)));
  const { data: accounts, error: accountError } = await client
    .from('gmail_accounts')
    .select('id, email, account_type, access_token_encrypted, refresh_token_encrypted, token_expiry, last_sync_at, last_history_id')
    .in('id', accountIds);
  if (accountError) throw accountError;
  const accountMap = new Map((accounts || []).map((account) => [account.id, account as GmailAccount]));
  const gmailMap = new Map<string, any>();

  for (const receipt of receipts) {
    result.processed++;
    result.nextAfterId = receipt.id;
    if (!isApprovedCanonicalSender(receipt.sender)) {
      result.skipped++;
      continue;
    }
    const account = accountMap.get(receipt.gmail_account_id);
    if (!account) {
      result.failed++;
      continue;
    }
    try {
      let parsedSubject = receipt.subject || '';
      let parsedSenderEmail = extractSenderAddress(receipt.sender) || APPROVED_COLLEGE_SENDER;
      let bodyText = receipt.body_snippet || '';
      let rfcMessageId = receipt.rfc_message_id;
      let hasAttachments = false;
      let snippetForMetadata = bodyText;

      // If stored body_snippet was capped at 500 chars (or < 200 chars), fetch full body from Gmail
      if (!bodyText || bodyText.length <= 500) {
        let gmail = gmailMap.get(account.id);
        if (!gmail) {
          gmail = (await createGmailClient(account)).gmail;
          gmailMap.set(account.id, gmail);
        }
        const parsed = await fetchMessageDetail(gmail, receipt.gmail_message_id);
        bodyText = canonicalBodyFromEmail(parsed.bodyPlain, parsed.bodyHtml, parsed.bodySnippet);
        parsedSubject = parsed.subject;
        parsedSenderEmail = parsed.senderEmail;
        rfcMessageId = parsed.messageId;
        hasAttachments = parsed.hasAttachments;
        snippetForMetadata = parsed.bodySnippet;
      }

      const contentKey = computeCanonicalContentKey(parsedSenderEmail, parsedSubject, bodyText);

      if (options.dryRun) {
        result.linked++;
        continue;
      }

      const canonicalPayload = {
        content_key: contentKey,
        sender_email: parsedSenderEmail.toLowerCase().trim(),
        subject: parsedSubject,
        body_snippet: bodyText.slice(0, 50000),
        body_text: bodyText,
        message_id: normalizeRfcMessageId(rfcMessageId),
        classification: null,
        identity_version: CANONICAL_IDENTITY_VERSION,
        has_attachments: hasAttachments,
        metadata_key: computeCanonicalMetadataKey(parsedSenderEmail, parsedSubject, snippetForMetadata),
        processing_status: 'complete',
        updated_at: new Date().toISOString(),
      };
      const normalizedMessageId = normalizeRfcMessageId(rfcMessageId);
      let canonicalId: string | null = null;
      let wasCreated = false;

      // Check if canonical row already exists by message_id or content_key
      if (normalizedMessageId) {
        const { data: byMsg } = await client
          .from('college_emails')
          .select('id')
          .eq('message_id', normalizedMessageId)
          .maybeSingle();
        if (byMsg?.id) canonicalId = byMsg.id;
      }

      if (!canonicalId) {
        const { data: byKey } = await client
          .from('college_emails')
          .select('id')
          .eq('content_key', contentKey)
          .maybeSingle();
        if (byKey?.id) canonicalId = byKey.id;
      }

      if (!canonicalId) {
        const canonicalPayload = {
          content_key: contentKey,
          sender_email: parsedSenderEmail.toLowerCase().trim(),
          subject: parsedSubject,
          body_snippet: bodyText.slice(0, 50000),
          body_text: bodyText,
          message_id: normalizedMessageId,
          classification: null,
          identity_version: CANONICAL_IDENTITY_VERSION,
          has_attachments: Boolean(hasAttachments),
          metadata_key: computeCanonicalMetadataKey(parsedSenderEmail, parsedSubject, snippetForMetadata),
          processing_status: 'complete',
          updated_at: new Date().toISOString(),
        };

        const { data: canonical, error: upsertError } = await client
          .from('college_emails')
          .upsert(canonicalPayload, { onConflict: 'content_key', ignoreDuplicates: false })
          .select('id')
          .single();

        if (upsertError) {
          if (normalizedMessageId) {
            const { data: fallback } = await client
              .from('college_emails')
              .select('id')
              .eq('message_id', normalizedMessageId)
              .maybeSingle();
            if (fallback?.id) canonicalId = fallback.id;
          }
          if (!canonicalId) throw upsertError;
        } else if (canonical?.id) {
          canonicalId = canonical.id;
          wasCreated = true;
        }
      }

      if (!canonicalId) {
        result.failed++;
        continue;
      }

      // If reusing an existing canonical row that lacks body_text, enrich it now
      if (!wasCreated && bodyText && bodyText.length > 500) {
        const { data: existingCanon } = await client
          .from('college_emails')
          .select('body_text')
          .eq('id', canonicalId)
          .maybeSingle();

        if (!existingCanon?.body_text) {
          const { extractJobDetails, extractEvents } = await import('@/lib/sync/events');
          await client
            .from('college_emails')
            .update({
              body_text: bodyText,
              body_snippet: bodyText.slice(0, 50000),
              parsed_job_details: extractJobDetails(bodyText),
              parsed_events: extractEvents({
                subject: parsedSubject,
                bodyPlain: bodyText,
                bodySnippet: snippetForMetadata,
                sender: parsedSenderEmail,
                senderEmail: parsedSenderEmail,
                receivedAt: new Date(),
                gmailMessageId: receipt.gmail_message_id,
                threadId: '',
                bodyHtml: '',
                hasAttachments: Boolean(hasAttachments),
                attachments: [],
                labels: [],
              }),
              identity_version: CANONICAL_IDENTITY_VERSION,
              message_id: normalizedMessageId || undefined,
              updated_at: new Date().toISOString(),
            })
            .eq('id', canonicalId);
        }
      }

      const { error: linkError } = await client
        .from('personal_emails')
        .update({
          college_email_id: canonicalId,
          canonical_email_id: canonicalId,
          rfc_message_id: normalizedMessageId,
          body_snippet: bodyText.slice(0, 500),
        })
        .eq('id', receipt.id)
        .is('canonical_email_id', null);
      if (linkError) throw linkError;
      result.linked++;
      if (wasCreated) result.created++;
      else result.reused++;
    } catch (backfillError) {
      result.failed++;
      console.warn(`[canonical-backfill] Receipt ${receipt.id} failed:`, backfillError);
    }
  }

  return result;
}
