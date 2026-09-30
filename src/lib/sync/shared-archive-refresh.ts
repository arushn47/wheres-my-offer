import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { createGmailClient, fetchMessageDetail, getPlacementSearchQuery, type GmailAccount } from '@/lib/gmail/client';
import { createAdminClient } from '@/lib/supabase/admin';
import { CANONICAL_IDENTITY_VERSION, isApprovedCanonicalSender, isGatedCollegeSender, normalizeRfcMessageId } from '@/lib/sync/canonical-email';
import { scoreCollegeMessageRelevance } from '@/lib/sync/college-relevance';
import { canonicalBodyFromEmail, computeCanonicalContentKey, computeCanonicalMetadataKey } from '@/lib/sync/canonical-email';
import { classifyEmail } from '@/lib/sync/classifier';
import { extractAllDriveNumbers, extractEvents, extractJobDetails } from '@/lib/sync/events';
import { CANONICAL_PARSER_VERSION } from '@/lib/sync/canonical-email';
import { classifyUnsupportedAttachment, isSupportedWorkbookAttachment, isTerminalUnsupportedRow } from '@/lib/sync/attachment-status';
import { isPdfAttachment, parsePdfAttachment } from '@/lib/sync/pdf-parser';
import * as XLSX from 'xlsx';

const ROW_BATCH_SIZE = 25;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const PARSER_VERSION = CANONICAL_PARSER_VERSION;

export interface SharedArchiveRefreshOptions {
  dryRun?: boolean;
  limit?: number;
  afterId?: string;
  after?: string;
  before?: string;
  sourceInbox?: string;
}

export interface SharedArchiveRefreshResult {
  dryRun: boolean;
  sourceInbox: string | null;
  before: string;
  scanned: number;
  wouldCreate: number;
  created: number;
  reused: number;
  failed: number;
  skipped: number;
  attachmentsSeen: number;
  attachmentsParsed: number;
  attachmentsReused: number;
  attachmentsFailed: number;
  attachmentsSkippedUnsupported: number;
  attachmentsSkippedDeferred: number;
  attachmentBytes: number;
  receiptRowsLinked: number;
  receiptRowsAlreadyLinked: number;
  receiptRowsAmbiguous: number;
  nextAfterId: string | null;
  errors: Array<{ subject: string; message: string }>;
}

function attachmentContentHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function extractWorkbookRows(data: Buffer): Array<{ sheetName: string; rows: unknown[][] }> {
  const workbook = XLSX.read(data, { type: 'buffer', cellDates: false, raw: true });
  return workbook.SheetNames.map((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    const rows = worksheet
      ? XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, blankrows: false, defval: '' })
      : [];
    return { sheetName, rows };
  });
}

async function fetchSharedCollegeMessages(options: SharedArchiveRefreshOptions): Promise<{
  messages: Array<{ gmail: import('googleapis').gmail_v1.Gmail; account: GmailAccount; messageId: string }>;
  scanned: number;
  failed: number;
  sourceInbox: string | null;
  nextPageToken: string | null;
}> {
  const supabase = createAdminClient();
  const { data: accounts, error } = await supabase
    .from('gmail_accounts')
    .select('id, email, account_type, access_token_encrypted, refresh_token_encrypted, token_expiry, last_sync_at, last_history_id')
    .eq('account_type', 'college')
    .eq('is_connected', true)
    .order('email', { ascending: true });
  if (error) throw error;
  if (!accounts?.length) throw new Error('No connected College Gmail inboxes are available for shared archive ingestion.');

  const fetchLimit = Math.max(1, Math.min(options.limit || 100, 100));
  const messages: Array<{ gmail: import('googleapis').gmail_v1.Gmail; account: GmailAccount; messageId: string }> = [];
  let scanned = 0;
  let failed = 0;
  let sourceInbox: string | null = null;
  let nextPageToken: string | null = null;
  // Gated senders (placement office) are always listed; the ingest-boundary
  // relevance gate scores each message and persists the verdict in the DB.
  const gatedSenders = ' OR from:placementoffice@vitbhopal.ac.in';
  // All subscribed College inboxes contain the same broadcast. Select one stable source
  // inbox so the shared refresh never duplicates a run across student mailboxes. There is
  // intentionally no user-specific default: the first connected College inbox wins.
  const requestedSourceInbox = options.sourceInbox || process.env.SHARED_COLLEGE_EMAIL || '';
  const account = (requestedSourceInbox
    ? accounts.find((candidate) => candidate.email.toLowerCase() === requestedSourceInbox.toLowerCase())
    : accounts[0]) as GmailAccount | undefined;
  if (!account) throw new Error(requestedSourceInbox
    ? `Requested connected College source inbox was not found: ${requestedSourceInbox}`
    : 'No connected College Gmail inbox is available for the shared archive refresh.');
  try {
    const { gmail } = await createGmailClient(account);
    const listed = await gmail.users.messages.list({
      userId: 'me',
      q: options.before
        ? `(from:vitlions2027@vitbhopal.ac.in${gatedSenders}) after:${options.after || '2026/06/30'} before:${options.before}`
        : `(from:vitlions2027@vitbhopal.ac.in${gatedSenders}) after:${options.after || '2026/06/30'}`,
      maxResults: fetchLimit,
      pageToken: options.afterId || undefined,
    });
    const messageIds = Array.from(new Set((listed.data.messages || []).map((message) => message.id).filter((id): id is string => Boolean(id))));
    scanned = messageIds.length;
    sourceInbox = messageIds.length > 0 ? account.email : null;
    nextPageToken = listed.data.nextPageToken || null;
    for (const messageId of messageIds) {
      messages.push({ gmail, account, messageId });
    }
  } catch {
    failed++;
  }

  return { messages, scanned, failed, sourceInbox, nextPageToken };
}

export async function refreshSharedCollegeArchive(
  options: SharedArchiveRefreshOptions = {},
  client = createAdminClient()
): Promise<SharedArchiveRefreshResult> {
  const result: SharedArchiveRefreshResult = {
    dryRun: options.dryRun !== false,
    sourceInbox: null,
    before: '',
    scanned: 0,
    wouldCreate: 0,
    created: 0,
    reused: 0,
    failed: 0,
    skipped: 0,
    attachmentsSeen: 0,
    attachmentsParsed: 0,
    attachmentsReused: 0,
    attachmentsFailed: 0,
    attachmentsSkippedUnsupported: 0,
    attachmentsSkippedDeferred: 0,
    attachmentBytes: 0,
    receiptRowsLinked: 0,
    receiptRowsAlreadyLinked: 0,
    receiptRowsAmbiguous: 0,
    nextAfterId: null,
    errors: [],
  };

  const runId = randomUUID();
  let after = options.after || '2026/06/30';
  let before = options.before || new Date().toISOString().slice(0, 10).replace(/-/g, '/');
  let sourceInbox = options.sourceInbox || process.env.SHARED_COLLEGE_EMAIL || '';
  let afterId = options.afterId;
  let savedMessageIds: string[] | null = null;
  let savedOffset = 0;
  result.before = before;
  let leaseAcquired = false;
  if (!result.dryRun) {
    const { data, error } = await client.rpc('acquire_college_archive_refresh_lease', {
      p_run_id: runId,
      p_lease_seconds: 300,
    });
    if (error) throw new Error(`Archive refresh lease unavailable: ${error.message}`);
    if (data !== true) throw new Error('Another shared archive refresh is already active.');
    leaseAcquired = true;
    const { data: saved, error: checkpointReadError } = await client
      .from('college_archive_refresh_lease')
      .select('refresh_source_inbox,refresh_after,refresh_before,refresh_page_token,refresh_message_ids,refresh_message_offset')
      .eq('singleton', true)
      .maybeSingle();
    if (checkpointReadError) throw checkpointReadError;
    if (saved?.refresh_message_ids && saved.refresh_message_ids.length > 0) {
      sourceInbox = saved.refresh_source_inbox || sourceInbox;
      after = saved.refresh_after || after;
      before = saved.refresh_before || before;
      afterId = saved.refresh_page_token || undefined;
      savedMessageIds = saved.refresh_message_ids as string[];
      savedOffset = saved.refresh_message_offset || 0;
      result.before = before;
      console.log(`[Shared Archive Refresh] Resuming stored checkpoint at ${savedOffset}/${savedMessageIds.length}`);
    }
  }

  try {
  const fetched = savedMessageIds
    ? await (async () => {
        const { data: resumeAccount, error: resumeAccountError } = await client
          .from('gmail_accounts')
          .select('id,email,account_type,access_token_encrypted,refresh_token_encrypted,token_expiry,last_sync_at,last_history_id')
          .eq('email', sourceInbox)
          .eq('is_connected', true)
          .single();
        if (resumeAccountError || !resumeAccount) throw new Error(`Refresh source inbox ${sourceInbox} is unavailable: ${resumeAccountError?.message || 'not connected'}`);
        const { gmail } = await createGmailClient(resumeAccount as GmailAccount);
        return {
          messages: savedMessageIds.slice(savedOffset).map((messageId) => ({ gmail, account: resumeAccount as GmailAccount, messageId })),
          scanned: savedMessageIds.length,
          failed: 0,
          sourceInbox,
          nextPageToken: afterId || null,
        };
      })()
    : await fetchSharedCollegeMessages({ ...options, before, after, sourceInbox });
  result.sourceInbox = fetched.sourceInbox;
  result.scanned = fetched.scanned;
  result.failed += fetched.failed;
  const pageMessageIds = savedMessageIds || fetched.messages.map((message) => message.messageId);
  const pending = fetched.messages;
  result.nextAfterId = fetched.nextPageToken;

  if (!result.dryRun && !savedMessageIds && pageMessageIds.length > 0) {
    const { error: checkpointWriteError } = await client
      .from('college_archive_refresh_lease')
      .update({
        refresh_source_inbox: sourceInbox,
        refresh_after: after,
        refresh_before: before,
        refresh_page_token: fetched.nextPageToken,
        refresh_message_ids: pageMessageIds,
        refresh_message_offset: 0,
        refresh_updated_at: new Date().toISOString(),
      })
      .eq('singleton', true);
    if (checkpointWriteError) throw checkpointWriteError;
  }

  const startOffset = savedMessageIds ? savedOffset : 0;
  batchLoop: for (let index = 0; index < pending.length; index += ROW_BATCH_SIZE) {
    const batch = pending.slice(index, index + ROW_BATCH_SIZE);
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex++) {
      const { gmail, account, messageId } = batch[batchIndex];
      try {
        const existingAttachmentRows = await client
          .from('college_attachments')
          .select('id, attachment_id, filename, size_bytes, parse_status, parse_error, extracted_rows, content_hash')
          .eq('gmail_account_id', account.id)
          .eq('gmail_message_id', messageId);
        if (existingAttachmentRows.error) throw existingAttachmentRows.error;

        const meta = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date', 'Message-ID'] });
        const headers = meta.data.payload?.headers || [];
        const header = (key: string) => headers.find((item) => item.name?.toLowerCase() === key.toLowerCase())?.value || '';
        const senderEmail = header('From').match(/<([^>]+)>/)?.[1] || header('From');
        if (!isApprovedCanonicalSender(senderEmail)) {
          result.skipped++;
          continue;
        }

        const metadataId = header('Message-ID');
        const normalizedMessageId = normalizeRfcMessageId(metadataId);
        const subject = header('Subject');
        const snippet = meta.data.snippet || '';
        let existingCanonical: {
          id: string;
          body_text: string | null;
          identity_version: number | null;
          parser_version: number | null;
          processing_status: string | null;
      has_attachments: boolean | null;
    } | null = null;
        if (normalizedMessageId) {
          const { data, error } = await client
            .from('college_emails')
            .select('id, body_text, identity_version, parser_version, processing_status, has_attachments')
            .eq('message_id', normalizedMessageId)
            .maybeSingle();
          if (error) throw error;
          existingCanonical = data;
        }

        if (!existingCanonical) {
          const { data, error } = await client
            .from('college_emails')
            .select('id, body_text, identity_version, parser_version, processing_status, has_attachments')
            .eq('content_key', computeCanonicalContentKey(senderEmail, subject, snippet))
            .maybeSingle();
          if (error) throw error;
          existingCanonical = data;
        }

        // This is an explicit one-time shared refresh: always fetch the full
        // current message once, including its real attachment inventory.
        const parsed = await fetchMessageDetail(gmail, messageId);
        let existingId = existingCanonical?.id || null;

        const bodyText = canonicalBodyFromEmail(parsed.bodyPlain, parsed.bodyHtml, parsed.bodySnippet);
        if (!bodyText) {
          result.failed++;
          result.errors.push({ subject, message: 'Full body was unavailable from both shared archive and Gmail.' });
          continue;
        }

        // Gated senders (placement office): strictly require shortlist, test schedule,
        // or interview schedule. Never insert rejected messages into the database.
        if (isGatedCollegeSender(parsed.senderEmail || parsed.sender)) {
          const gate = scoreCollegeMessageRelevance(
            {
              subject: parsed.subject,
              body: bodyText,
              hasAttachments: parsed.hasAttachments,
              attachmentFilenames: parsed.attachments.map((a) => a.filename),
            },
            parsed.senderEmail || parsed.sender
          );
          if (!gate.isRelevant) {
            result.skipped++;
            continue;
          }
        }

        const currentEmail = parsed;
        const classification = classifyEmail(currentEmail);
        const jobDetails = extractJobDetails(bodyText);
        const events = extractEvents(currentEmail);
        const contentKey = computeCanonicalContentKey(senderEmail, currentEmail.subject, bodyText);
        const normalizedAddress = parsed.senderEmail.toLowerCase().trim();
        const metadataKey = computeCanonicalMetadataKey(normalizedAddress, currentEmail.subject, snippet);
        if (!existingId) {
          const { data: existingByFullKey, error: fullKeyError } = await client
            .from('college_emails')
            .select('id')
            .eq('content_key', contentKey)
            .maybeSingle();
          if (fullKeyError) throw fullKeyError;
          existingId = existingByFullKey?.id || null;
        }
        const canonicalId = existingId;

        let resolvedCanonicalId = canonicalId;
        if (result.dryRun) {
          if (canonicalId) result.reused++;
          else result.wouldCreate++;
        }

        if (!result.dryRun) {
          const canonicalPayload = {
            content_key: contentKey,
            sender_email: normalizedAddress,
            subject: currentEmail.subject,
            body_text: bodyText,
            body_snippet: bodyText.slice(0, 50000),
            message_id: normalizeRfcMessageId(currentEmail.messageId),
            metadata_key: metadataKey,
            has_attachments: Boolean(currentEmail.hasAttachments || currentEmail.attachments.length),
            classification: classification.classification,
            classification_confidence: classification.confidence === 'high' ? 1 : classification.confidence === 'medium' ? 0.7 : 0.4,
            parsed_company_name: classification.companyName || null,
            parsed_drive_numbers: extractAllDriveNumbers(`${currentEmail.subject}\n${bodyText}`),
            parsed_job_details: jobDetails,
            parsed_events: events,
            identity_version: CANONICAL_IDENTITY_VERSION,
            parser_version: PARSER_VERSION,
            processing_status: 'complete',
            received_at: currentEmail.receivedAt.toISOString(),
            updated_at: new Date().toISOString(),
          };
          let canonicalWrite;
          if (canonicalId) {
            canonicalWrite = await client.from('college_emails').update(canonicalPayload).eq('id', canonicalId).select('id').single();
          } else {
            canonicalWrite = await client.from('college_emails').upsert(canonicalPayload, { onConflict: 'content_key' }).select('id').single();
          }
          if (canonicalWrite.error) throw canonicalWrite.error;
          resolvedCanonicalId = canonicalWrite.data.id;
          if (canonicalId) result.reused++;
          else result.created++;
        } else if (canonicalId) {
          result.reused++;
        }

        const canonicalReferenceId = resolvedCanonicalId;
        const normalizedRfcMessageId = normalizeRfcMessageId(currentEmail.messageId);
        if (normalizedRfcMessageId && result.dryRun) {
          const { data: matchingCanonicalIds, error: canonicalCountError } = await client
            .from('college_emails')
            .select('id')
            .eq('message_id', normalizedRfcMessageId);
          if (canonicalCountError) throw canonicalCountError;
          if ((matchingCanonicalIds || []).length !== 1 || (canonicalId && matchingCanonicalIds?.[0]?.id !== canonicalId)) {
            result.receiptRowsAmbiguous += (matchingCanonicalIds || []).length > 1 ? 1 : 0;
          } else {
            const { count, error: receiptCountError } = await client
              .from('personal_emails')
              .select('id', { count: 'exact', head: true })
              .eq('rfc_message_id', normalizedRfcMessageId)
              .is('college_email_id', null)
              .or('assignment_source.is.null,assignment_source.neq.admin_unlinked');
            if (receiptCountError) throw receiptCountError;
            result.receiptRowsLinked += count || 0;
          }
        } else if (normalizedRfcMessageId && canonicalReferenceId) {
          const { data: matchingCanonicalIds, error: canonicalCountError } = await client
            .from('college_emails')
            .select('id')
            .eq('message_id', normalizedRfcMessageId);
          if (canonicalCountError) throw canonicalCountError;
          if ((matchingCanonicalIds || []).length !== 1 || matchingCanonicalIds?.[0]?.id !== canonicalReferenceId) {
            result.receiptRowsAmbiguous++;
            continue;
          }
          const { data: receipts, error: receiptReadError } = await client
            .from('personal_emails')
            .select('id, college_email_id')
            .eq('rfc_message_id', normalizedRfcMessageId)
            .or('assignment_source.is.null,assignment_source.neq.admin_unlinked');
          if (receiptReadError) throw receiptReadError;
          const linked = (receipts || []).filter((receipt) => receipt.college_email_id === canonicalReferenceId).length;
          const toLink = (receipts || []).filter((receipt) => !receipt.college_email_id);
          result.receiptRowsAlreadyLinked += linked;
          if (toLink.length > 0) {
            const { error: receiptUpdateError } = await client
              .from('personal_emails')
              .update({ college_email_id: canonicalReferenceId, canonical_email_id: canonicalReferenceId })
              .in('id', toLink.map((receipt) => receipt.id))
              .is('college_email_id', null);
            if (receiptUpdateError) throw receiptUpdateError;
            result.receiptRowsLinked += toLink.length;
          }
        }

        for (const attachment of currentEmail.attachments) {
          result.attachmentsSeen++;
          // Gmail attachment_ids are not stable across fetches, and unsupported rows
          // may carry a stale content_hash from the era when every format was
          // downloaded. Resolve by attachment_id, then by filename+size.
          const prior = (existingAttachmentRows.data || []).find((row) => row.attachment_id === attachment.attachmentId)
            || (existingAttachmentRows.data || []).find((row) => (row.filename || '') === attachment.filename
              && (row.size_bytes || 0) === (attachment.size || 0));
          const isWorkbook = isSupportedWorkbookAttachment(attachment.filename);
          const isPdf = isPdfAttachment(attachment.filename);
          if (!isWorkbook && !isPdf) {
            // Terminal: never downloaded, never retried. Images are ignored outright;
            // other formats are deferred for future JD parsing.
            const classification = classifyUnsupportedAttachment(attachment.filename);
            result.attachmentsSkippedUnsupported++;
            if (isTerminalUnsupportedRow(prior, classification)) continue;
            if (!result.dryRun) {
              const deferredPayload = {
                college_email_id: canonicalReferenceId,
                content_key: `${canonicalReferenceId}:${attachment.attachmentId}`,
                gmail_message_id: messageId,
                gmail_account_id: account.id,
                attachment_id: attachment.attachmentId,
                filename: attachment.filename,
                size_bytes: attachment.size,
                parse_status: classification.status,
                parse_error: classification.error,
                updated_at: new Date().toISOString(),
              };
              const write = prior
                ? await client.from('college_attachments').update(deferredPayload).eq('id', prior.id)
                : await client.from('college_attachments').upsert(deferredPayload, { onConflict: 'college_email_id,attachment_id' });
              if (write.error) throw write.error;
            }
            continue;
          }
          if (prior?.parse_status === 'complete' && prior.extracted_rows && (isWorkbook || isPdf)) {
            result.attachmentsReused++;
            continue;
          }
          try {
            if (attachment.size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} byte refresh limit.`);
            const { data: attachmentData } = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachment.attachmentId });
            if (!attachmentData.data) throw new Error('Gmail returned no attachment content.');
            const buffer = Buffer.from(attachmentData.data, 'base64url');
            result.attachmentBytes += buffer.length;
            const pdfResult = isPdf ? await parsePdfAttachment(buffer) : null;
            const rows = isPdf ? pdfResult!.extractedRows : extractWorkbookRows(buffer);
            const parseStatus = isPdf ? pdfResult!.parseStatus : 'complete';
            result.attachmentsParsed++;
            if (!result.dryRun) {
              const contentHash = attachmentContentHash(buffer);
              const attachmentPayload = {
                college_email_id: canonicalReferenceId,
                content_key: `${canonicalReferenceId}:${attachment.attachmentId}`,
                gmail_message_id: messageId,
                gmail_account_id: account.id,
                attachment_id: attachment.attachmentId,
                filename: attachment.filename,
                size_bytes: buffer.length,
                content_hash: contentHash,
                extracted_rows: rows,
                parse_status: parseStatus,
                parse_error: isPdf ? pdfResult!.parseError : null,
                updated_at: new Date().toISOString(),
              };
              const write = prior
                ? await client.from('college_attachments').update(attachmentPayload).eq('id', prior.id)
                : await client.from('college_attachments').upsert(attachmentPayload, { onConflict: 'college_email_id,attachment_id' });
              if (write.error) throw write.error;
            }
          } catch (error) {
            result.attachmentsFailed++;
            result.errors.push({ subject: `${subject} · ${attachment.filename}`, message: error instanceof Error ? error.message : String(error) });
            if (!result.dryRun) {
              const failurePayload = {
                college_email_id: canonicalReferenceId,
                content_key: `${canonicalReferenceId}:${attachment.attachmentId}`,
                gmail_message_id: messageId,
                gmail_account_id: account.id,
                attachment_id: attachment.attachmentId,
                filename: attachment.filename,
                size_bytes: attachment.size,
                parse_status: 'error',
                parse_error: error instanceof Error ? error.message : String(error),
                updated_at: new Date().toISOString(),
              };
              if (prior) {
                await client.from('college_attachments').update(failurePayload).eq('id', prior.id);
              } else {
                await client.from('college_attachments').upsert(failurePayload, { onConflict: 'college_email_id,attachment_id' });
              }
            }
          }
        }
      } catch (error) {
        result.failed++;
        result.errors.push({ subject: messageId, message: error instanceof Error ? error.message : String(error) });
        if (!result.dryRun && savedMessageIds) {
          await client.from('college_archive_refresh_lease').update({
            refresh_message_offset: startOffset + index + batchIndex,
            refresh_updated_at: new Date().toISOString(),
          }).eq('singleton', true);
        }
        break;
      }
      if (!result.dryRun) {
        const completedOffset = startOffset + index + batchIndex + 1;
        const isPageDone = completedOffset >= pageMessageIds.length;
        await client.from('college_archive_refresh_lease').update({
          refresh_message_offset: isPageDone ? 0 : completedOffset,
          refresh_message_ids: isPageDone ? [] : pageMessageIds,
          refresh_page_token: isPageDone ? fetched.nextPageToken : afterId,
          refresh_updated_at: new Date().toISOString(),
        }).eq('singleton', true);
        }
        break batchLoop;
      }
  }
  result.nextAfterId = fetched.nextPageToken;

  return result;
  } finally {
    if (leaseAcquired) {
      const { error } = await client.rpc('release_college_archive_refresh_lease', {
        p_run_id: runId,
        p_error: result.errors.length > 0 ? `${result.failed + result.attachmentsFailed} item(s) failed; inspect batch results.` : null,
      });
      if (error) console.error('[Shared Archive Refresh] Failed to release refresh lease:', error.message);
    }
  }
}
