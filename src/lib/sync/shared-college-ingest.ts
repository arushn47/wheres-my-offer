import { createHash } from 'node:crypto';
import type { gmail_v1 } from 'googleapis';
import { createAdminClient } from '@/lib/supabase/admin';
import { createGmailClient, fetchMessageDetail, type GmailAccount, type ParsedAttachment, type ParsedEmail } from '@/lib/gmail/client';
import { CANONICAL_IDENTITY_VERSION, CANONICAL_PARSER_VERSION, canonicalBodyFromEmail, computeCanonicalContentKey, computeCanonicalMetadataKey, isApprovedCanonicalSender, normalizeRfcMessageId } from '@/lib/sync/canonical-email';
import { classifyEmail } from '@/lib/sync/classifier';
import { extractAllDriveNumbers, extractEvents, extractJobDetails } from '@/lib/sync/events';
import { processEmailForEventsAndStatus } from '@/lib/sync/status-engine';
import { hasSharedDriveFanOutEvidence, isShortlistMatchEvidence } from '@/lib/sync/participation-evidence';
import { normalizeDriveNumber } from '@/lib/drive-number';
import {
  classifyUnsupportedAttachment,
  isSupportedWorkbookAttachment,
  isTerminalUnsupportedRow,
  TRANSIENT_ATTACHMENT_ERROR,
} from '@/lib/sync/attachment-status';

interface SharedDriveRow {
  id: string;
  company_id: string;
  drive_number: string | null;
  normalized_drive_number: string | null;
  source_college_email_id: string | null;
}

interface SharedCompanyRow {
  id: string;
  name: string;
  aliases: string[] | null;
}


interface SharedCircularRow {
  id: string;
  subject: string | null;
  sender_email: string;
  body_text: string | null;
  body_snippet: string | null;
  received_at: string | null;
  created_at: string;
  parsed_company_name: string | null;
  parsed_drive_numbers: string[] | null;
  classification: string | null;
  has_attachments: boolean | null;
}

function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function findDriveForCircular(
  supabase: ReturnType<typeof createAdminClient>,
  params: { text: string; parsedCompanyName: string | null; parsedDriveNumbers: string[] }
) {
  for (const rawNumber of params.parsedDriveNumbers) {
    const number = rawNumber.toLowerCase().replace(/[^a-z0-9]/g, '');
    const { data } = await supabase
      .from('placement_drives')
      .select('id,company_id,companies(name)')
      .or(`normalized_drive_number.eq.${number},drive_number.eq.${rawNumber}`)
      .maybeSingle();
    if (data) return data;
  }

  if (!params.parsedCompanyName) return null;
  const { data: drives } = await supabase
    .from('placement_drives')
    .select('id,company_id,drive_number,normalized_drive_number,drive_name,companies(name)');
  if (!drives?.length) return null;
  const byNumber = drives.filter((drive) => {
    const number = drive.normalized_drive_number || drive.drive_number;
    return Boolean(number && params.text.toLowerCase().includes(number.toLowerCase()));
  });
  if (byNumber.length === 1) return byNumber[0];
  const name = params.parsedCompanyName.toLowerCase().trim();
  const byCompany = drives.filter((drive) => {
    const company = Array.isArray(drive.companies) ? drive.companies[0] : drive.companies;
    return (company?.name || '').toLowerCase().trim() === name || (drive.drive_name || '').toLowerCase().trim() === name;
  });
  return byCompany.length === 1 ? byCompany[0] : null;
}

async function scanSharedAttachment(
  gmail: gmail_v1.Gmail,
  parsedEmail: Awaited<ReturnType<typeof fetchMessageDetail>>,
  attachment: Awaited<ReturnType<typeof fetchMessageDetail>>['attachments'][number]
) {
  const { data } = await gmail.users.messages.attachments.get({
    userId: 'me', messageId: parsedEmail.gmailMessageId, id: attachment.attachmentId,
  });
  if (!data.data) throw new Error('Gmail returned empty attachment data');
  const bytes = decodeBase64Url(data.data);
  if (/\.(xlsx|xls|csv)$/i.test(attachment.filename)) {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(bytes, { type: 'buffer', raw: true, cellDates: false });
    const extractedRows = workbook.SheetNames.map((sheetName) => ({
      sheetName,
      rows: XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, blankrows: false, defval: '' }),
    }));
    return { extractedRows, parseStatus: 'complete' as const, bytes };
  }
  return { extractedRows: null, parseStatus: 'error' as const, bytes };
}

/** Ingest one watched College circular once, then apply it only to evidenced users. */
export async function ingestSharedCollegeCircular(params: {
  account: GmailAccount;
  gmailMessageId: string;
  gmail?: gmail_v1.Gmail;
}): Promise<{ canonicalId: string | null; appliedUsers: number; skippedUsers: number; attachmentErrors: number }> {
  const supabase = createAdminClient();
  const gmail = params.gmail || (await createGmailClient(params.account)).gmail;
  const parsedEmail = await fetchMessageDetail(gmail, params.gmailMessageId);
  if (!isApprovedCanonicalSender(parsedEmail.senderEmail || parsedEmail.sender)) {
    return { canonicalId: null, appliedUsers: 0, skippedUsers: 0, attachmentErrors: 0 };
  }

  const bodyText = canonicalBodyFromEmail(parsedEmail.bodyPlain, parsedEmail.bodyHtml, parsedEmail.bodySnippet);
  const classification = classifyEmail(parsedEmail);
  const normalizedMessageId = normalizeRfcMessageId(parsedEmail.messageId);
  const contentKey = computeCanonicalContentKey(parsedEmail.senderEmail, parsedEmail.subject, bodyText);
  const jobDetails = extractJobDetails(bodyText);
  const events = extractEvents(parsedEmail);
  const payload = {
    content_key: contentKey,
    sender_email: parsedEmail.senderEmail.toLowerCase().trim(),
    subject: parsedEmail.subject,
    body_text: bodyText,
    body_snippet: bodyText.slice(0, 50000),
    message_id: normalizedMessageId,
    metadata_key: computeCanonicalMetadataKey(parsedEmail.senderEmail, parsedEmail.subject, parsedEmail.bodySnippet),
    has_attachments: parsedEmail.hasAttachments,
    classification: classification.classification,
    classification_confidence: classification.confidence === 'high' ? 1 : classification.confidence === 'medium' ? 0.7 : 0.4,
    parsed_company_name: classification.companyName || null,
    parsed_drive_numbers: extractAllDriveNumbers(`${parsedEmail.subject}\n${bodyText}`),
    parsed_job_details: jobDetails,
    parsed_events: events,
    identity_version: CANONICAL_IDENTITY_VERSION,
    parser_version: CANONICAL_PARSER_VERSION,
    processing_status: 'complete',
    received_at: parsedEmail.receivedAt.toISOString(),
    updated_at: new Date().toISOString(),
  };

  let existing = null as { id: string } | null;
  if (normalizedMessageId) {
    const lookup = await supabase.from('college_emails').select('id').eq('message_id', normalizedMessageId).maybeSingle();
    if (lookup.error) throw lookup.error;
    existing = lookup.data;
  }
  if (!existing) {
    const lookup = await supabase.from('college_emails').select('id').eq('content_key', contentKey).maybeSingle();
    if (lookup.error) throw lookup.error;
    existing = lookup.data;
  }
  let upsert: { data: { id: string } | null; error: { code?: string; message: string } | null };
  if (existing) {
    const result = await supabase.from('college_emails').update(payload).eq('id', existing.id).select('id').single();
    upsert = { data: result.data, error: result.error };
  } else {
    const result = await supabase.from('college_emails').upsert(payload, { onConflict: 'content_key' }).select('id').single();
    upsert = { data: result.data, error: result.error };
  }
  if (!upsert.error && upsert.data) {
    // Happy path: insert or update resolved to a single row.
  } else if (upsert.error?.code === '23505') {
    // A concurrent or prior writer already created the same canonical row — either
    // by content_key or (a migrated archive row with) the same lower(message_id).
    // Re-resolve that row, normalize the losing key, and update it instead of failing.
    const racedLookup = upsert.error.message.includes('idx_canonical_emails_message_id')
      ? await supabase.from('college_emails').select('id').eq('message_id', normalizedMessageId).maybeSingle()
      : await supabase.from('college_emails').select('id').eq('content_key', contentKey).maybeSingle();
    if (racedLookup.error) throw racedLookup.error;
    if (!racedLookup.data) throw new Error(`Unique-key conflict without resolvable row: ${upsert.error.message}`);
    const racedUpdate = await supabase.from('college_emails').update(payload).eq('id', racedLookup.data.id).select('id').single();
    if (racedUpdate.error) {
      const stillConflicting = racedUpdate.error.code === '23505' && racedUpdate.error.message.includes('idx_canonical_emails_message_id');
      if (!stillConflicting) throw racedUpdate.error;
      // The raced row itself carries a different legacy message_id casing/value.
      // Drop message_id from this payload and update the remaining canonical fields.
      const fallbackUpdate = await supabase.from('college_emails').update({ ...payload, message_id: null }).eq('id', racedLookup.data.id).select('id').single();
      if (fallbackUpdate.error) throw fallbackUpdate.error;
      upsert.data = fallbackUpdate.data;
    } else {
      upsert.data = racedUpdate.data;
    }
  } else if (upsert.error) {
    throw new Error(upsert.error.message);
  } else {
    throw new Error('Shared College ingest upsert returned no row and no error.');
  }
  const canonicalId = upsert.data!.id;

  let attachmentErrors = 0;
  const existingAttachments = await supabase.from('college_attachments')
    .select('id,attachment_id,filename,size_bytes,content_hash,parse_status,parse_error,extracted_rows')
    .eq('college_email_id', canonicalId);
  if (existingAttachments.error) throw existingAttachments.error;
  // Gmail attachment_ids are NOT stable across fetches of the same message: each
  // fetch of a thread message can return a different attachment_id for the same
  // bytes. Keying only on attachment_id would insert a duplicate copy of every
  // attachment on every re-ingest of the canonical circular. Resolve the prior
  // row by content identity instead: attachment_id, then byte hash, then
  // filename+size for legacy rows stored before hashing existed.
  const findPriorRow = (attachment: { attachmentId: string; filename: string; size: number }, contentHash: string | null) => {
    const rows = existingAttachments.data || [];
    return rows.find((row) => row.attachment_id === attachment.attachmentId)
      || (contentHash ? rows.find((row) => row.content_hash === contentHash) : undefined)
      || rows.find((row) => !row.content_hash
        && (row.filename || '') === attachment.filename
        && (row.size_bytes || 0) === (attachment.size || 0));
  };
  // Unsupported / image attachments are never hashed, but rows written before the
  // classification existed may still carry a content_hash from the era when every
  // format was downloaded. Resolve those by attachment_id or filename+size, ignoring
  // the hash, so a later re-ingest of the same message can never create a second row
  // for an attachment we deliberately never parse.
  const findPriorUnsupportedRow = (attachment: { attachmentId: string; filename: string; size: number }) => {
    const rows = existingAttachments.data || [];
    return rows.find((row) => row.attachment_id === attachment.attachmentId)
      || rows.find((row) => (row.filename || '') === attachment.filename
        && (row.size_bytes || 0) === (attachment.size || 0));
  };
  for (const attachment of parsedEmail.attachments) {
    if (!isSupportedWorkbookAttachment(attachment.filename)) {
      // Images and other non-workbook formats are terminal and deliberately NOT
      // downloaded or retried. They are still recorded so the email's attachment
      // inventory (and the shortlist scanner's "a roster may exist here" signal)
      // stays faithful. A row that already carries this exact classification is left
      // untouched so re-ingesting the message is a true no-op.
      const classification = classifyUnsupportedAttachment(attachment.filename);
      const prior = findPriorUnsupportedRow(attachment);
      if (isTerminalUnsupportedRow(prior, classification)) continue;
      const unsupportedPayload = {
        college_email_id: canonicalId,
        content_key: `${canonicalId}:${attachment.attachmentId}`,
        gmail_message_id: parsedEmail.gmailMessageId,
        gmail_account_id: params.account.id,
        attachment_id: attachment.attachmentId,
        filename: attachment.filename,
        size_bytes: attachment.size,
        content_hash: null,
        extracted_rows: null,
        parse_status: classification.status,
        parse_error: classification.error,
        updated_at: new Date().toISOString(),
      };
      const write = prior
        ? await supabase.from('college_attachments').update(unsupportedPayload).eq('id', prior.id)
        : await supabase.from('college_attachments').upsert(unsupportedPayload, { onConflict: 'college_email_id,attachment_id' });
      if (write.error) throw write.error;
      continue;
    }

    const parsedAttachment = await scanSharedAttachment(gmail, parsedEmail, attachment).catch((error) => {
      attachmentErrors++;
      console.warn(`[Shared College Ingest] Deferred ${attachment.filename}:`, error);
      return { extractedRows: null, parseStatus: 'error' as const, bytes: Buffer.alloc(0) };
    });
    const contentHash = parsedAttachment.bytes.length ? createHash('sha256').update(parsedAttachment.bytes).digest('hex') : null;
    const prior = findPriorRow(attachment, contentHash);
    if (prior?.parse_status === 'complete' && prior.extracted_rows) {
      // Already parsed — but keep the freshest attachment_id/message reference.
      if (prior.attachment_id !== attachment.attachmentId) {
        await supabase.from('college_attachments').update({ attachment_id: attachment.attachmentId, updated_at: new Date().toISOString() }).eq('id', prior.id);
      }
      continue;
    }
    const attachmentPayload = {
      college_email_id: canonicalId,
      content_key: `${canonicalId}:${attachment.attachmentId}`,
      gmail_message_id: parsedEmail.gmailMessageId,
      gmail_account_id: params.account.id,
      attachment_id: attachment.attachmentId,
      filename: attachment.filename,
      size_bytes: parsedAttachment.bytes.length || attachment.size,
      content_hash: contentHash,
      extracted_rows: parsedAttachment.extractedRows,
      parse_status: parsedAttachment.parseStatus,
      parse_error: parsedAttachment.parseStatus === 'error' ? TRANSIENT_ATTACHMENT_ERROR : null,
      updated_at: new Date().toISOString(),
    };
    const write = prior
      ? await supabase.from('college_attachments').update(attachmentPayload).eq('id', prior.id)
      : await supabase.from('college_attachments').upsert(attachmentPayload, { onConflict: 'college_email_id,attachment_id' });
    if (write.error) throw write.error;
  }

  const { data: cachedAttachments, error: cachedAttachmentsError } = await supabase
    .from('college_attachments')
    .select('attachment_id,filename,size_bytes,extracted_rows,parse_status')
    .eq('college_email_id', canonicalId);
  if (cachedAttachmentsError) throw cachedAttachmentsError;
  const cachedById = new Map((cachedAttachments || []).map((attachment) => [attachment.attachment_id, attachment]));
  parsedEmail.attachments = parsedEmail.attachments.map((attachment) => {
    const cached = cachedById.get(attachment.attachmentId);
    return cached
      ? {
          ...attachment,
          filename: cached.filename || attachment.filename,
          size: cached.size_bytes || attachment.size,
          extractedRows: cached.extracted_rows || undefined,
          parseStatus: cached.parse_status,
        }
      : attachment;
  });

  const drive = await findDriveForCircular(supabase, {
    text: `${parsedEmail.subject}\n${bodyText}`,
    parsedCompanyName: classification.companyName || null,
    parsedDriveNumbers: extractAllDriveNumbers(`${parsedEmail.subject}\n${bodyText}`),
  });
  if (!drive) return { canonicalId, appliedUsers: 0, skippedUsers: 0, attachmentErrors };

  const { data: eligibleReceipts, error: receiptError } = await supabase
    .from('personal_emails')
    .select('user_id')
    .eq('placement_drive_id', drive.id);
  if (receiptError) throw receiptError;
  const userIds = Array.from(new Set((eligibleReceipts || []).map((receipt) => receipt.user_id)));
  let appliedUsers = 0;
  let skippedUsers = 0;
  const { data: userMatches } = await supabase
    .from('candidate_matches')
    .select('user_id,match_type,matched_value,matched_round_type')
    .eq('placement_drive_id', drive.id);

  const { data: manualApplications, error: manualApplicationsError } = await supabase
    .from('applications')
    .select('user_id')
    .eq('placement_drive_id', drive.id)
    .eq('manual_override', true);
  if (manualApplicationsError) throw manualApplicationsError;

  const targetUserIds = Array.from(new Set([
    ...userIds,
    ...(manualApplications || []).map((application) => application.user_id),
  ]));
  const { data: users } = await supabase.from('users').select('id,neo_id,email').in('id', targetUserIds);
  const eligibleUserIds = new Set(userIds);
  for (const application of manualApplications || []) eligibleUserIds.add(application.user_id);
  for (const match of userMatches || []) {
    if (isShortlistMatchEvidence({ matchType: match.match_type, matchedValue: match.matched_value, matchedRoundType: match.matched_round_type })) {
      eligibleUserIds.add(match.user_id);
    }
  }
  const companyId = drive.company_id;
  for (const targetUserId of eligibleUserIds) {
    const user = (users || []).find((candidate) => candidate.id === targetUserId);
    if (!user) {
      const { data: shortlistUser } = await supabase.from('users').select('id,neo_id,email').eq('id', targetUserId).maybeSingle();
      if (!shortlistUser) continue;
      await processEmailForEventsAndStatus(supabase, targetUserId, companyId, parsedEmail, canonicalId, shortlistUser.neo_id, shortlistUser.email, drive.id, gmail, 'drive');
      appliedUsers++;
      continue;
    }
    const userEvidence = (userMatches || []).filter((match) => match.user_id === targetUserId)
      .some((match) => isShortlistMatchEvidence({ matchType: match.match_type, matchedValue: match.matched_value, matchedRoundType: match.matched_round_type }));
    const hasManualOverride = (manualApplications || []).some((application) => application.user_id === targetUserId);
    if (!hasSharedDriveFanOutEvidence({
      hasPersonalDriveEvidence: Boolean(eligibleReceipts?.some((receipt) => receipt.user_id === targetUserId)),
      hasConfirmedShortlistMatch: userEvidence,
      manualOverride: hasManualOverride,
    }) || !user) {
      skippedUsers++;
      continue;
    }
    await processEmailForEventsAndStatus(supabase, targetUserId, companyId, parsedEmail, canonicalId, user.neo_id, user.email, drive.id, gmail, 'drive');
    appliedUsers++;
  }

  return { canonicalId, appliedUsers, skippedUsers, attachmentErrors };
}

/** Apply already-cached shared circulars to this user's evidenced drives. */
export async function fanOutSharedCollegeArchiveToUser(userId: string): Promise<{ examined: number; applied: number; skipped: number }> {
  const supabase = createAdminClient();
  const [appsResult, personalResult, matchesResult, drivesResult, companiesResult, userResult] = await Promise.all([
    supabase.from('applications').select('placement_drive_id,manual_override,status').eq('user_id', userId),
    supabase.from('personal_emails').select('placement_drive_id').eq('user_id', userId).not('placement_drive_id', 'is', null),
    supabase.from('candidate_matches').select('placement_drive_id,match_type,matched_value,matched_round_type').eq('user_id', userId),
    supabase.from('placement_drives').select('id,company_id,drive_number,normalized_drive_number,source_college_email_id'),
    supabase.from('companies').select('id,name,aliases'),
    supabase.from('users').select('neo_id,email').eq('id', userId).single(),
  ]);
  for (const result of [appsResult, personalResult, matchesResult, drivesResult, companiesResult, userResult]) {
    if (result.error) throw result.error;
  }
  if (!userResult.data) throw new Error(`User ${userId} was not found for shared circular fan-out.`);
  const eligible = new Set<string>();
  for (const app of appsResult.data || []) {
    if (app.placement_drive_id && app.manual_override) eligible.add(app.placement_drive_id);
  }
  for (const email of personalResult.data || []) if (email.placement_drive_id) eligible.add(email.placement_drive_id);
  for (const match of matchesResult.data || []) {
    if (match.placement_drive_id && isShortlistMatchEvidence({ matchType: match.match_type, matchedValue: match.matched_value, matchedRoundType: match.matched_round_type })) eligible.add(match.placement_drive_id);
  }
  if (eligible.size === 0) return { examined: 0, applied: 0, skipped: 0 };

  const drives = ((drivesResult.data || []) as SharedDriveRow[]).filter((drive) => eligible.has(drive.id));
  const companyMap = new Map((companiesResult.data || []).map((company) => [company.id, company as SharedCompanyRow]));
  const circulars: SharedCircularRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('college_emails')
      .select('id,subject,sender_email,body_text,body_snippet,received_at,created_at,parsed_company_name,parsed_drive_numbers,classification,has_attachments')
      .eq('processing_status', 'complete')
      .range(from, from + 999);
    if (error) throw error;
    circulars.push(...((data || []) as SharedCircularRow[]));
    if (!data || data.length < 1000) break;
  }
  if (circulars.length === 0) return { examined: 0, applied: 0, skipped: 0 };
  const { data: cachedAttachments, error: attachmentError } = await supabase
    .from('college_attachments')
    .select('college_email_id,attachment_id,filename,size_bytes,extracted_rows,parse_status')
    .eq('parse_status', 'complete')
    .not('extracted_rows', 'is', null);
  if (attachmentError) throw attachmentError;
  const attachmentsByEmail = new Map<string, ParsedAttachment[]>();
  for (const row of cachedAttachments || []) {
    const list = attachmentsByEmail.get(row.college_email_id) || [];
    list.push({
      attachmentId: row.attachment_id,
      filename: row.filename || 'shared.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: row.size_bytes || 0,
      extractedRows: row.extracted_rows || undefined,
      parseStatus: row.parse_status,
    });
    attachmentsByEmail.set(row.college_email_id, list);
  }

  let examined = 0;
  let applied = 0;
  let skipped = 0;
  const seen = new Set<string>();
  const user = userResult.data;
  // Preload this user's applications for every candidate drive once. The original
  // per-pair applications query turned the drive×circular loop into ~20k sequential
  // round-trips per user, stalling the completion fan-out for tens of minutes.
  const candidateDriveIds = Array.from(new Set(drives.map((drive) => drive.id)));
  const currentUserApps = new Map<string, { manual_override: boolean | null }>();
  for (let from = 0; from < candidateDriveIds.length; from += 200) {
    const { data: appRows, error: appRowsError } = await supabase
      .from('applications')
      .select('placement_drive_id,manual_override')
      .eq('user_id', userId)
      .in('placement_drive_id', candidateDriveIds.slice(from, from + 200));
    if (appRowsError) throw appRowsError;
    for (const row of appRows || []) currentUserApps.set(row.placement_drive_id, row);
  }
  for (const drive of drives) {
    const company = companyMap.get(drive.company_id);
    if (!company) continue;
    for (const circular of circulars) {
      const direct = drive.source_college_email_id === circular.id;
      const driveNumbers = (circular.parsed_drive_numbers || []).map((number: string) => normalizeDriveNumber(number));
      const normalizedDriveNumber = normalizeDriveNumber(drive.normalized_drive_number || drive.drive_number || '');
      const numberMatch = Boolean(normalizedDriveNumber && driveNumbers.includes(normalizedDriveNumber));
      const companyMatch = Boolean(circular.parsed_company_name && circular.parsed_company_name.toLowerCase().trim() === company.name.toLowerCase().trim());
      const sameCompanyDrives = (drivesResult.data || []).filter((candidate) => candidate.company_id === drive.company_id);
      if (!direct && !numberMatch && !(companyMatch && sameCompanyDrives.length === 1)) continue;
      if (!seen.add(`${drive.id}|${circular.id}`)) continue;
      examined++;

      const body = circular.body_text || circular.body_snippet || '';
      const parsedEmail: ParsedEmail = {
        gmailMessageId: circular.id,
        threadId: null,
        sender: circular.sender_email,
        senderEmail: circular.sender_email,
        messageId: null,
        subject: circular.subject || '',
        receivedAt: new Date(circular.received_at || circular.created_at),
        bodySnippet: body,
        bodyPlain: body,
        bodyHtml: '',
        hasAttachments: Boolean(circular.has_attachments),
        attachments: attachmentsByEmail.get(circular.id) || [],
        labels: [],
        canonicalEmailId: circular.id,
      };
      try {
        const currentApplication = currentUserApps.get(drive.id) || null;
        const personalEvidence = (personalResult.data || []).some((row) => row.placement_drive_id === drive.id);
        const positiveShortlist = (matchesResult.data || []).some((match) =>
          match.placement_drive_id === drive.id &&
          isShortlistMatchEvidence({ matchType: match.match_type, matchedValue: match.matched_value, matchedRoundType: match.matched_round_type })
        );
        if (!hasSharedDriveFanOutEvidence({
          hasPersonalDriveEvidence: personalEvidence,
          hasConfirmedShortlistMatch: positiveShortlist,
          manualOverride: Boolean(currentApplication?.manual_override),
        })) {
          skipped++;
          continue;
        }
        await processEmailForEventsAndStatus(supabase, userId, drive.company_id, parsedEmail, circular.id, user.neo_id, user.email, drive.id, undefined, 'drive');
        applied++;
      } catch (error) {
        skipped++;
        console.warn(`[Shared College Fan-out] User ${userId}, drive ${drive.id}, circular ${circular.id} failed:`, error);
      }
    }
  }
  return { examined, applied, skipped };
}
