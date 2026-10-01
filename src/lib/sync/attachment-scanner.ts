import { loadUserCandidateIdentity } from '@/lib/sync/user-identity';
import { createAdminClient } from '@/lib/supabase/admin';
import { createGmailClient } from '@/lib/gmail/client';
import type { GmailAccount } from '@/lib/gmail/client';
import { scanExcelAttachmentsForNeoId, scanSharedCollegeAttachmentsForNeoId } from '@/lib/sync/excel-parser';
import { normalizeDriveNumber } from '@/lib/drive-number';
import { isShortlistMatchEvidence } from '@/lib/sync/participation-evidence';
import { evaluateCachedShortlistRosters, getVerifiedShortlistStatus, resolveDriveVerification } from '@/lib/sync/shortlist-verification';
import { isSharedArchiveComplete } from '@/lib/sync/shared-college-state';
import { removeDriveEvents } from '@/lib/sync/drive-events';
import {
  notifyShortlistAbsent,
  notifyShortlistMatch,
} from '@/lib/notifications/service';
import { classifyShortlistEmail } from '@/lib/sync/round-identity';

/**
 * Scans `.xlsx` / `.xls` attachments on circular emails linked to placement drives
 * to find and persist candidate matches for the given user.
 * 
 * This ensures that candidate matches from test shortlists are preserved in the DB
 * even if circulars arrived without explicit drive numbers during initial ingestion.
 */
export async function scanAndPersistCandidateMatches(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  targetDriveIds?: string[]
): Promise<number> {
  // 1. Fetch user's connected Gmail accounts (both college and personal)
  const { data: accounts, error: accError } = await supabase
    .from('gmail_accounts')
    .select('id, email, account_type, access_token_encrypted, refresh_token_encrypted, token_expiry, last_sync_at, last_history_id')
    .eq('user_id', userId)
    .eq('is_connected', true);

  if (accError || !accounts || accounts.length === 0) {
    return 0;
  }

  const collegeAccount = accounts.find((a) => a.account_type === 'college');
  const accountsById = new Map<string, GmailAccount>(
    accounts.map((acc) => [acc.id, acc as unknown as GmailAccount])
  );

  // 2. Fetch user's NeoPAT ID & college email
  const { data: user } = await supabase
    .from('users')
    .select('neo_id, email')
    .eq('id', userId)
    .single();

  const userNeoId = user?.neo_id || null;
  const userEmail = user?.email || collegeAccount?.email || accounts[0]?.email;
  if (!userNeoId && !userEmail) return 0;

  // 3. Fetch candidate test/shortlist circular emails linked to placement drives
  let emailQuery = supabase
    .from('personal_emails')
    .select('id, gmail_message_id, gmail_account_id, subject, placement_drive_id, classification, body_snippet, college_email_id')
    .eq('user_id', userId)
    .not('placement_drive_id', 'is', null)
    .or('subject.ilike.%shortlist%,subject.ilike.%online test%,subject.ilike.%coding test%,subject.ilike.%assessment%,subject.ilike.%pearl research park%,subject.ilike.%prp%,subject.ilike.%anna auditorium%,classification.eq.shortlist');

  if (targetDriveIds && targetDriveIds.length > 0) {
    emailQuery = emailQuery.in('placement_drive_id', targetDriveIds);
  }

  const { data: relevantEmails } = await emailQuery;
  if (!relevantEmails || relevantEmails.length === 0) return 0;

  // 4. Check which emails already have a recorded candidate match
  const { data: existingMatches } = await supabase
    .from('candidate_matches')
    .select('email_id, college_email_id, match_type, matched_value, matched_round_type')
    .eq('user_id', userId);

  const matchedEmailIds = new Set(
    (existingMatches || [])
      .filter((match) => isShortlistMatchEvidence({
        matchType: match.match_type,
        matchedValue: match.matched_value,
        matchedRoundType: match.matched_round_type,
      }))
      .map((m: any) => m.college_email_id || m.email_id)
      .filter(Boolean)
  );
  let emailsToScan = relevantEmails.filter((e) => !matchedEmailIds.has(e.id) && !matchedEmailIds.has((e as any).college_email_id));
  if (emailsToScan.length === 0) return 0;

  // Cap emails to scan to prevent quota exhaustion
  emailsToScan = emailsToScan.slice(0, 15);

  let newMatchesCount = 0;
  const gmailClientMap = new Map<string, any>();

  for (const email of emailsToScan) {
    const messageId = email.gmail_message_id || email.id;
    const account = (email.gmail_account_id && accountsById.get(email.gmail_account_id)) || collegeAccount || accounts[0];
    if (!account) continue;

    try {
      let client = gmailClientMap.get(account.id);
      if (!client) {
        const { gmail: newClient } = await createGmailClient(account);
        client = newClient;
        gmailClientMap.set(account.id, client);
      }

      const msg = await client.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });

      const parts = msg.data.payload?.parts || [];
      const excelAttachments = parts
        .filter((p: any) => {
          const fn = (p.filename || '').toLowerCase();
          return (fn.endsWith('.xlsx') || fn.endsWith('.xls')) && Boolean(p.body?.attachmentId);
        })
        .map((p: any) => ({
          filename: p.filename || 'shortlist.xlsx',
          mimeType: p.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: p.body?.size || 0,
          attachmentId: p.body?.attachmentId as string,
        }));

      if (excelAttachments.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }

      const isShortlistEmail =
        email.classification === 'shortlist' ||
        /shortlist|selection|selected|test\s+(?:is\s+)?scheduled|assessment\s+(?:is\s+)?scheduled|exam\s+(?:is\s+)?scheduled|coding\s+test|ppt\s+and\s+online\s+test/i.test(
          email.subject || ''
        ) ||
        /shortlist|selection|selected|shortlisted\s+students/i.test(
          email.body_snippet || ''
        );
      const excelMatch = await scanExcelAttachmentsForNeoId(
        client,
        messageId,
        excelAttachments,
        userNeoId,
        userEmail,
        isShortlistEmail
      );

      if (excelMatch && excelMatch.matched && excelMatch.isActualShortlist) {
        const matchPayload: any = {
          user_id: userId,
          placement_drive_id: email.placement_drive_id,
          neo_id: userNeoId || userEmail,
          match_type: 'xlsx_cell',
          matched_round_type: classifyShortlistEmail(email.subject || '', ''),
          matched_value: excelMatch.details,
          confidence: 'high',
        };
        if ((email as any).college_email_id) {
          matchPayload.college_email_id = (email as any).college_email_id;
        } else {
          matchPayload.email_id = email.id;
        }

        const { error: insertError } = await supabase.from('candidate_matches').insert(matchPayload);

        if (!insertError || insertError.code === '23505') {
          newMatchesCount++;
          matchedEmailIds.add(email.id);
        }
      }

      // Rate limit delay between Gmail API calls
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch (err: any) {
      if (err?.status === 404 || err?.code === 404 || err?.message?.includes('Requested entity was not found')) {
        console.warn(`[scanAndPersistCandidateMatches] Message ${messageId} not found in Gmail account ${account.email} (404), skipping.`);
        continue;
      }
      console.warn(`[scanAndPersistCandidateMatches] Failed to scan email ${email.id}:`, err);
      const errMsg = err?.message || String(err);
      if (
        errMsg.toLowerCase().includes('quota') ||
        errMsg.includes('429') ||
        errMsg.includes('rateLimitExceeded') ||
        errMsg.includes('userRateLimitExceeded')
      ) {
        console.warn('[scanAndPersistCandidateMatches] Gmail API quota exceeded. Aborting further scans.');
        break;
      }
    }
  }

  return newMatchesCount;
}

/**
 * Matches a user's identity against shared College shortlist workbooks without
 * downloading the same Gmail attachment for every student's inbox.
 */
export async function scanSharedCollegeCandidateMatches(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  targetDriveIds?: string[]
): Promise<number> {
  const [{ data: user }, { data: accounts }, { data: applications }, { data: personalEmails }, { data: existingMatches }, { data: drives }, { data: companies }] = await Promise.all([
    supabase.from('users').select('neo_id, email').eq('id', userId).single(),
    supabase.from('gmail_accounts').select('id, email, account_type').eq('user_id', userId).eq('is_connected', true),
    supabase.from('applications').select('placement_drive_id,manual_override,status').eq('user_id', userId),
    supabase.from('personal_emails').select('placement_drive_id').eq('user_id', userId).not('placement_drive_id', 'is', null),
    supabase.from('candidate_matches').select('placement_drive_id, college_email_id, match_type, matched_value, matched_round_type').eq('user_id', userId),
    supabase.from('placement_drives').select('id, company_id, drive_number, normalized_drive_number, source_college_email_id'),
    supabase.from('companies').select('id, name, aliases'),
  ]);

  const personalAccount = accounts?.find((account) => account.account_type === 'personal');
  const userEmail = user?.email || personalAccount?.email || '';
  const userNeoId = user?.neo_id || null;
  if (!userEmail && !userNeoId) return 0;

  const eligibleDriveIds = new Set<string>([
    ...((applications || []).filter((app) => app.manual_override).map((app) => app.placement_drive_id).filter(Boolean) as string[]),
    ...((personalEmails || []).map((email) => email.placement_drive_id).filter(Boolean) as string[]),
    ...((existingMatches || [])
      .filter((match) => isShortlistMatchEvidence({
        matchType: match.match_type,
        matchedValue: match.matched_value,
        matchedRoundType: match.matched_round_type,
      }))
      .map((match) => match.placement_drive_id)
      .filter(Boolean) as string[]),
    ...((targetDriveIds || []).filter((driveId) =>
      (personalEmails || []).some((email) => email.placement_drive_id === driveId) ||
      (existingMatches || []).some((match) =>
        match.placement_drive_id === driveId && isShortlistMatchEvidence({
          matchType: match.match_type,
          matchedValue: match.matched_value,
          matchedRoundType: match.matched_round_type,
        })
      ) ||
      (applications || []).some((application) => application.placement_drive_id === driveId && application.manual_override)
    )),
  ]);
  if (eligibleDriveIds.size === 0) return 0;

  const { data: sharedSyncState, error: sharedSyncStateError } = await supabase
    .from('shared_college_sync_state')
    .select('initial_scan_complete,next_page_token,is_syncing,pending_message_ids,pending_offset')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (sharedSyncStateError) throw sharedSyncStateError;
  const pendingIds = Array.isArray(sharedSyncState?.pending_message_ids) ? sharedSyncState.pending_message_ids : [];
  const archiveReadyForNegative = isSharedArchiveComplete(sharedSyncState ? {
    initial_scan_complete: sharedSyncState.initial_scan_complete,
    next_page_token: sharedSyncState.next_page_token,
    is_syncing: sharedSyncState.is_syncing,
    pending_count: Math.max(0, pendingIds.length - (sharedSyncState.pending_offset || 0)),
  } : null);

  const companyMap = new Map((companies || []).map((company) => [company.id, company]));
  const driveById = new Map((drives || []).map((d) => [d.id, d]));

  const canonicalEmails: Array<{
    id: string;
    subject: string | null;
    classification: string | null;
    parsed_company_name: string | null;
    parsed_drive_numbers: string[] | null;
    received_at: string | null;
  }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('college_emails')
      .select('id, subject, classification, parsed_company_name, parsed_drive_numbers,received_at')
      .eq('processing_status', 'complete')
      .range(from, from + 999);
    if (error) throw error;
    canonicalEmails.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const cachedAttachments: Array<{
    college_email_id: string;
    filename: string | null;
    size_bytes: number | null;
    parse_status: string;
    extracted_rows?: unknown;
  }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('college_attachments')
      .select('college_email_id, filename, size_bytes, parse_status')
      .range(from, from + 999);
    if (error) throw error;
    cachedAttachments.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  // Legacy per-user syncs used to record un-hashed `pending` attachment stubs for
  // circulars whose content the shared College worker already parsed. Those stubs
  // carry no rows and are parsed by nothing, yet counting them as "an unparsed
  // relevant roster" parked whole drives at `deferred` forever. Recognize the same
  // workbook by filename+size (the legacy content-identity rule) and use the
  // already-parsed copy instead of poisoning the drive's verification.
  // Circulars that already produced a user-scoped event are authoritatively tied to that
  // drive: the event insert records its source circular's college_email_id. This is exact
  // evidence, unlike company-name matching, which must defer whenever a company has
  // sibling drives (e.g. two Deloitte drives) and could otherwise never prove absence —
  // leaving real "not shortlisted" results stuck at PPT Scheduled / Applied forever.
  const { data: userDriveEvents, error: userDriveEventsError } = await supabase
    .from('events')
    .select('placement_drive_id, college_email_id')
    .eq('user_id', userId)
    .not('college_email_id', 'is', null);
  if (userDriveEventsError) throw userDriveEventsError;
  const driveByUserEventEmail = new Map<string, string>();
  for (const ev of userDriveEvents || []) {
    if (ev.college_email_id && ev.placement_drive_id && !driveByUserEventEmail.has(ev.college_email_id)) {
      driveByUserEventEmail.set(ev.college_email_id, ev.placement_drive_id);
    }
  }

  const canonicalIdsWithAttachments = new Set((cachedAttachments || []).map((attachment) => attachment.college_email_id));
  // Circulars that already produced a user-scoped event participate in verification even
  // without a stored attachment row (e.g. body-text shortlists or attachment rows lost to
  // re-ingest) — otherwise a verified negative can never be written for them.
  const canonicalIdsFromUserEvents = new Set(
    Array.from(driveByUserEventEmail.keys()).filter((id) => !canonicalIdsWithAttachments.has(id))
  );
  const canonicalEmailsWithAttachments = canonicalEmails.filter((email) =>
    canonicalIdsWithAttachments.has(email.id) || canonicalIdsFromUserEvents.has(email.id)
  );
  const attachmentNamesByEmail = new Map<string, string[]>();
  for (const attachment of cachedAttachments || []) {
    const names = attachmentNamesByEmail.get(attachment.college_email_id) || [];
    names.push(attachment.filename || '');
    attachmentNamesByEmail.set(attachment.college_email_id, names);
  }

  const driveByCanonicalId = new Map<string, string>();
  const driveByNumber = new Map<string, string>();
  const driveByCompanyName = new Map<string, string[]>();
  for (const drive of drives || []) {
    if (drive.source_college_email_id) driveByCanonicalId.set(drive.source_college_email_id, drive.id);
    const number = normalizeDriveNumber(drive.normalized_drive_number || drive.drive_number || '');
    if (number) driveByNumber.set(number, drive.id);
    const company = companyMap.get(drive.company_id);
    if (company) {
      for (const name of [company.name, ...(company.aliases || [])]) {
        const key = name.toLowerCase().trim();
        const matches = driveByCompanyName.get(key) || [];
        matches.push(drive.id);
        driveByCompanyName.set(key, matches);
      }
    }
  }

  const existingRefs = new Set(
    (existingMatches || [])
      .filter((match) => isShortlistMatchEvidence({
        matchType: match.match_type,
        matchedValue: match.matched_value,
        matchedRoundType: match.matched_round_type,
      }))
      .map((match) => `${match.placement_drive_id}|${match.college_email_id || ''}`)
  );

  const existingVerification = new Map<string, string>();
  const appRowsByDrive = new Map((applications || []).map((app) => [app.placement_drive_id, app]));

  const verificationByDrive = new Map<string, {
    rosterResults: Array<{ relevant: boolean; parsed: boolean; candidatePresent: boolean }>;
    matchDetails: string | null; latestRosterAt?: number; matchEmailId?: string;
  }>();
  // Ambiguous shortlist circulars (company name spanning sibling drives, or no resolvable
  // drive at all) are held aside instead of poisoning verificationByDrive immediately.
  // A circular that IS uniquely attributable to the user's drive — by its own drive number,
  // by the drive's source circular, or by the user's own event link — supersedes them:
  // roster content for THIS drive is exact evidence, while an ambiguous circular is a guess
  // that must never outvote it (Deloitte runs several sibling drives under one company name,
  // so name-matched circulars could otherwise defer the drive forever).
  const ambiguousByDrive = new Map<string, { receivedAt: number }>();
  for (const match of existingMatches || []) {
    if (!match.placement_drive_id || !isShortlistMatchEvidence({
      matchType: match.match_type,
      matchedValue: match.matched_value,
      matchedRoundType: match.matched_round_type,
    })) continue;
    const state = verificationByDrive.get(match.placement_drive_id) || { rosterResults: [], matchDetails: null };
    state.rosterResults.push({ relevant: true, parsed: true, candidatePresent: true });
    state.matchEmailId = match.college_email_id || state.matchEmailId;
    verificationByDrive.set(match.placement_drive_id, state);
  }

  const workItems = new Map<string, { driveId: string; email: (typeof canonicalEmails)[number] }>();
  for (const email of canonicalEmailsWithAttachments) {
    const text = email.subject || '';
    const rosterAttachmentContext = (attachmentNamesByEmail.get(email.id) || []).some((filename) =>
      /shortlist|selection[_\s-]*list|selected[_\s-]*student|shortlisted/i.test(filename) &&
      !/applied[_\s-]*list|opt[_\s-]*in|eligible[_\s-]*student|registered[_\s-]*student|registration[_\s-]*list/i.test(filename)
    );
    const shortlistContext =
      email.classification === 'shortlist' ||
      /shortlist|selection\s+list|selected\s+students|online\s+test|coding\s+test|assessment|interview/i.test(text) ||
      rosterAttachmentContext;
    if (!shortlistContext) continue;

    const directDriveId = driveByCanonicalId.get(email.id);
    const parsedNumbers = (email.parsed_drive_numbers || []) as string[];
    const matchedByNumber = parsedNumbers
      .map((number) => normalizeDriveNumber(number))
      .map((number) => (number ? driveByNumber.get(number) : undefined))
      .filter(Boolean) as string[];
    const eventDriveId = driveByUserEventEmail.get(email.id);
    let driveId = directDriveId
      || (eventDriveId && eligibleDriveIds.has(eventDriveId) ? eventDriveId : undefined)
      || (new Set(matchedByNumber).size === 1 ? matchedByNumber[0] : undefined);
    if (!driveId && email.parsed_company_name) {
      const companyDrives = driveByCompanyName.get(email.parsed_company_name.toLowerCase().trim()) || [];
      if (companyDrives.length === 1) driveId = companyDrives[0];
      else if (companyDrives.length > 1) {
        // An ambiguous same-company circular cannot prove absence for any one
        // sibling drive. Hold it aside; it only defers drives with no attributable
        // roster evidence of their own (see the reconciliation below).
        for (const possibleDriveId of companyDrives.filter((id) => eligibleDriveIds.has(id))) {
          const prior = ambiguousByDrive.get(possibleDriveId);
          ambiguousByDrive.set(possibleDriveId, {
            receivedAt: Math.max(prior?.receivedAt || 0, email.received_at ? new Date(email.received_at).getTime() : 0),
          });
        }
      }
    }
    if (!driveId || !eligibleDriveIds.has(driveId)) continue;
    workItems.set(`${driveId}|${email.id}`, { driveId, email });
  }

  // A shortlist-classified circular that cannot be tied to a unique drive means
  // the archive scan cannot prove absence for the candidate's drive(s).
  for (const email of canonicalEmailsWithAttachments) {
    const text = email.subject || '';
    const hasRosterName = (attachmentNamesByEmail.get(email.id) || []).some((filename) =>
      /shortlist|selection[_\s-]*list|selected[_\s-]*student|shortlisted/i.test(filename) &&
      !/applied[_\s-]*list|opt[_\s-]*in|eligible[_\s-]*student|registered[_\s-]*student|registration[_\s-]*list/i.test(filename)
    );
    const shortlistContext = email.classification === 'shortlist' ||
      /shortlist|selection\s+list|selected\s+students|online\s+test|coding\s+test|assessment|interview/i.test(text) ||
      hasRosterName;
    if (!shortlistContext || Array.from(workItems.values()).some((item) => item.email.id === email.id)) continue;
    const candidates = new Set<string>();
    for (const rawNumber of email.parsed_drive_numbers || []) {
      const normalized = normalizeDriveNumber(rawNumber);
      const driveId = normalized ? driveByNumber.get(normalized) : undefined;
      if (driveId && eligibleDriveIds.has(driveId)) candidates.add(driveId);
    }
    if (email.parsed_company_name) {
      for (const driveId of driveByCompanyName.get(email.parsed_company_name.toLowerCase().trim()) || []) {
        if (eligibleDriveIds.has(driveId)) candidates.add(driveId);
      }
    }
    for (const driveId of candidates) {
      const prior = ambiguousByDrive.get(driveId);
      ambiguousByDrive.set(driveId, {
        receivedAt: Math.max(prior?.receivedAt || 0, email.received_at ? new Date(email.received_at).getTime() : 0),
      });
    }
  }

  // Phase 2: Targeted fetch of extracted_rows only for candidate circular attachments in workItems
  const candidateEmailIds = Array.from(new Set(Array.from(workItems.values()).map(({ email }) => email.id)));
  const parsedRowsByFile = new Map<string, unknown>();

  if (candidateEmailIds.length > 0) {
    const candidateAttachments = cachedAttachments.filter((att) => candidateEmailIds.includes(att.college_email_id));
    const twinFilenames = candidateAttachments
      .filter((att) => att.filename && att.parse_status !== 'complete')
      .map((att) => att.filename as string);

    let rowsQuery = supabase
      .from('college_attachments')
      .select('college_email_id, filename, size_bytes, parse_status, extracted_rows')
      .eq('parse_status', 'complete')
      .not('extracted_rows', 'is', null);

    if (twinFilenames.length > 0) {
      rowsQuery = rowsQuery.or(`college_email_id.in.(${candidateEmailIds.join(',')}),filename.in.(${twinFilenames.map((f) => `"${f}"`).join(',')})`);
    } else {
      rowsQuery = rowsQuery.in('college_email_id', candidateEmailIds);
    }

    const { data: rowsData, error: rowsError } = await rowsQuery;
    if (rowsError) throw rowsError;

    const rowsByEmailAndFile = new Map<string, unknown>();
    for (const row of rowsData || []) {
      const emailFileKey = `${row.college_email_id}|${(row.filename || '').toLowerCase().trim()}`;
      rowsByEmailAndFile.set(emailFileKey, row.extracted_rows);
      const twinKey = `${(row.filename || '').toLowerCase().trim()}|${row.size_bytes || 0}`;
      if (!parsedRowsByFile.has(twinKey)) parsedRowsByFile.set(twinKey, row.extracted_rows);
    }

    for (const att of cachedAttachments) {
      const emailFileKey = `${att.college_email_id}|${(att.filename || '').toLowerCase().trim()}`;
      if (rowsByEmailAndFile.has(emailFileKey)) {
        att.extracted_rows = rowsByEmailAndFile.get(emailFileKey);
      }
    }
  }

  const resolveRosterContent = (attachment: (typeof cachedAttachments)[number]) => {
    if (attachment.parse_status === 'complete' && attachment.extracted_rows) {
      return { parseStatus: attachment.parse_status, extractedRows: attachment.extracted_rows };
    }
    const parsedTwin = parsedRowsByFile.get(
      `${(attachment.filename || '').toLowerCase().trim()}|${attachment.size_bytes || 0}`
    );
    return parsedTwin
      ? { parseStatus: 'complete', extractedRows: parsedTwin }
      : { parseStatus: attachment.parse_status, extractedRows: attachment.extracted_rows };
  };

  let matchesCreated = 0;
  for (const { driveId, email } of workItems.values()) {
    const rosterAttachmentContext = (attachmentNamesByEmail.get(email.id) || []).some((filename) =>
      /shortlist|selection[_\s-]*list|selected[_\s-]*student|shortlisted/i.test(filename) &&
      !/applied[_\s-]*list|opt[_\s-]*in|eligible[_\s-]*student|registered[_\s-]*student|registration[_\s-]*list/i.test(filename)
    );
    const shortlistContext = email.classification === 'shortlist' || /shortlist|selection|selected|test|assessment|interview/i.test(email.subject || '') || rosterAttachmentContext;
    const archiveAttachments = (cachedAttachments || [])
      .filter((attachment) => attachment.college_email_id === email.id)
      .map((attachment) => {
        const content = resolveRosterContent(attachment);
        return {
          filename: attachment.filename || '',
          collegeEmailId: email.id,
          round: /interview|selection\s+process/i.test(email.subject || '')
            ? 'interview' as const
            : /final\s*selection|selection\s*list/i.test(email.subject || '')
              ? 'selected' as const
              : /online\s+test|coding\s+test|assessment|test\s+shortlist/i.test(email.subject || '')
                ? 'test' as const
                : null,
          parseStatus: content.parseStatus,
          extractedRows: content.extractedRows as Array<{ sheetName: string; rows: unknown[][] }> | null,
        };
      });
    const evaluation = evaluateCachedShortlistRosters({
      rosters: archiveAttachments,
      shortlistContext,
      identityTokens: [
        userNeoId || '',
        userEmail.match(/([0-9]{2}[a-z]{3}[0-9]{4,5})/i)?.[1] || '',
        userEmail,
      ].filter(Boolean),
    });
    const driveResult = verificationByDrive.get(driveId) || { rosterResults: [], matchDetails: null };
    if (evaluation.state === 'verified_present' || evaluation.state === 'verified_absent') {
      driveResult.latestRosterAt = Math.max(
        driveResult.latestRosterAt || 0,
        email.received_at ? new Date(email.received_at).getTime() : 0
      );
    }
    const hasPositiveEvidence = existingMatches?.some((match) =>
      match.placement_drive_id === driveId && match.college_email_id === email.id && isShortlistMatchEvidence({
        matchType: match.match_type,
        matchedValue: match.matched_value,
        matchedRoundType: match.matched_round_type,
      })
    );
    driveResult.rosterResults.push({
      relevant: evaluation.state !== 'not_published',
      parsed: evaluation.state !== 'deferred',
      candidatePresent: evaluation.state === 'verified_present' || Boolean(hasPositiveEvidence),
    });
    if (evaluation.state === 'verified_present' && evaluation.matchingRoster) {
      driveResult.matchDetails = evaluation.matchingRoster.details;
    }

    if (evaluation.state === 'verified_present') {
      driveResult.matchEmailId = email.id;
    }
    verificationByDrive.set(driveId, driveResult);
    if (existingRefs.has(`${driveId}|${email.id}`)) {
      // Backfill: legacy match rows predate precise roster locations (they carry
      // generic values like "Matched in shared shortlist roster" and no sheet/row).
      // When this rescan resolved the exact roster hit, enrich the existing row so
      // the drive UI can show "Sheet1!row 14" instead of a bare filename.
      if (evaluation.state === 'verified_present' && evaluation.matchingRoster) {
        const preciseDetails = evaluation.matchingRoster.details;
        const existing = (existingMatches || []).find((match) =>
          match.placement_drive_id === driveId &&
          match.college_email_id === email.id &&
          isShortlistMatchEvidence({
            matchType: match.match_type,
            matchedValue: match.matched_value,
            matchedRoundType: match.matched_round_type,
          })
        );
        if (existing && existing.matched_value !== preciseDetails) {
          await supabase
            .from('candidate_matches')
            .update({ matched_value: preciseDetails })
            .eq('user_id', userId)
            .eq('placement_drive_id', driveId)
            .eq('college_email_id', email.id);
        }
      }
      continue;
    }
    if (evaluation.state !== 'verified_present') continue;

    const round = classifyShortlistEmail(email.subject || '', '') ?? 'test';
    const { error } = await supabase.from('candidate_matches').insert({
      user_id: userId,
      placement_drive_id: driveId,
      college_email_id: email.id,
      neo_id: userNeoId || userEmail,
      match_type: 'xlsx_cell',
      matched_round_type: round,
      matched_value: evaluation.matchingRoster?.details || driveResult.matchDetails || 'Matched in shared shortlist roster',
      confidence: 'high',
    });
    if (!error) {
      matchesCreated++;
      existingRefs.add(`${driveId}|${email.id}`);
    } else if (error.code === '23505') {
      existingRefs.add(`${driveId}|${email.id}`);
    } else {
      throw error;
    }
  }

  // Reconcile: ambiguous circulars defer a drive ONLY when nothing attributable was
  // parsed for it. A roster tied to this exact drive (unique drive number, source
  // circular, or the user's own event link) is exact evidence and supersedes the
  // company-name guess — without this, one company with several sibling drives
  // (Deloitte) could never reach verified_absent at all.
  for (const driveId of ambiguousByDrive.keys()) {
    const result = verificationByDrive.get(driveId);
    const hasAttributedParsedRoster = Boolean(result?.rosterResults.some((entry) => entry.parsed));
    if (hasAttributedParsedRoster) continue;
    const unresolved = result || { rosterResults: [], matchDetails: null };
    unresolved.rosterResults.push({ relevant: true, parsed: false, candidatePresent: false });
    verificationByDrive.set(driveId, unresolved);
  }

  const applicationsByDrive = new Map((applications || []).map((application) => [application.placement_drive_id, application]));
  for (const driveId of eligibleDriveIds) {
    const app = applicationsByDrive.get(driveId);
    if (!app || app.manual_override) continue;
    const result = verificationByDrive.get(driveId);
    if (!result) {
      // No relevant roster anywhere in the archive for this drive: nothing to judge.
      continue;
    }
    const verification = resolveDriveVerification({ scans: result.rosterResults, archiveComplete: archiveReadyForNegative });
    if (verification.state === 'not_published' && app.status === 'not_shortlisted') {
      verification.state = 'verified_absent';
    }
    const hasPositiveMatch = (existingMatches || []).some((match) =>
      match.placement_drive_id === driveId && isShortlistMatchEvidence({
        matchType: match.match_type,
        matchedValue: match.matched_value,
        matchedRoundType: match.matched_round_type,
      })
    ) || verification.state === 'verified_present';
    const nextStatus = getVerifiedShortlistStatus({
      verificationState: verification.state,
      hasPositiveMatch,
      currentStatus: app.status || 'unknown',
      manualOverride: Boolean(app.manual_override),
    });

    if (nextStatus && app.status !== nextStatus) {
      const { error: appError } = await supabase
        .from('applications')
        .update({ status: nextStatus, status_source: 'sync_reprocess', status_confidence: 'high', last_updated: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('placement_drive_id', driveId);
      if (appError) throw appError;
    }

    const statusNow = nextStatus ?? app.status;

    const isFresh =
      (result.latestRosterAt ?? 0) >
      Date.now() - 7 * 24 * 60 * 60 * 1000;

    const companyName =
      companyMap.get(driveById.get(driveId)?.company_id ?? '')?.name ||
      'Placement drive';

    try {
      if (
        verification.state === 'verified_absent' &&
        !hasPositiveMatch &&
        statusNow === 'not_shortlisted'
      ) {
        await removeDriveEvents(supabase, userId, driveId, {
          excludeTypes: ['registration_deadline'],
          onlyUnfinished: true,
        });

        if (isFresh) {
          await notifyShortlistAbsent({
            userId,
            placementDriveId: driveId,
            companyName,
          });
        }
      } else if (
        hasPositiveMatch &&
        statusNow === 'shortlisted' &&
        isFresh &&
        result.matchEmailId
      ) {
        await notifyShortlistMatch({
          userId,
          placementDriveId: driveId,
          companyName,
          neoId: userNeoId || userEmail,
          emailSubject: '',
          sourceEmailId: result.matchEmailId,
        });
      }
    } catch (sideEffectErr) {
      console.warn(
        '[scanSharedCollegeCandidateMatches] side effects failed:',
        sideEffectErr
      );
    }
  }

  return matchesCreated;
}
