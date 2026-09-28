import { createAdminClient } from '@/lib/supabase/admin';
import { createGmailClient } from '@/lib/gmail/client';
import type { GmailAccount } from '@/lib/gmail/client';
import { scanExcelAttachmentsForNeoId, scanSharedCollegeAttachmentsForNeoId } from '@/lib/sync/excel-parser';
import { normalizeDriveNumber } from '@/lib/drive-number';
import { isShortlistMatchEvidence } from '@/lib/sync/participation-evidence';
import { evaluateCachedShortlistRosters, getVerifiedShortlistStatus, resolveDriveVerification } from '@/lib/sync/shortlist-verification';
import { isSharedArchiveComplete } from '@/lib/sync/shared-college-state';

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
          matched_round_type: /interview|selection\s+process/i.test(email.subject || '') ? 'interview'
            : /final\s*selection|selection\s*list/i.test(email.subject || '') ? 'selected'
            : /online\s+test|coding\s+test|assessment|test\s+shortlist/i.test(email.subject || '') ? 'test'
            : null,
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
  const canonicalEmails: Array<{
    id: string;
    subject: string | null;
    classification: string | null;
    parsed_company_name: string | null;
    parsed_drive_numbers: string[] | null;
  }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('college_emails')
      .select('id, subject, classification, parsed_company_name, parsed_drive_numbers')
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
    extracted_rows: unknown;
  }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('college_attachments')
      .select('college_email_id, filename, size_bytes, parse_status, extracted_rows')
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
  const parsedRowsByFile = new Map<string, unknown>();
  for (const attachment of cachedAttachments) {
    if (attachment.parse_status !== 'complete' || !attachment.extracted_rows) continue;
    const key = `${(attachment.filename || '').toLowerCase().trim()}|${attachment.size_bytes || 0}`;
    if (!parsedRowsByFile.has(key)) parsedRowsByFile.set(key, attachment.extracted_rows);
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
  const canonicalIdsWithAttachments = new Set((cachedAttachments || []).map((attachment) => attachment.college_email_id));
  const canonicalEmailsWithAttachments = canonicalEmails.filter((email) => canonicalIdsWithAttachments.has(email.id));
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
  const { data: storedVerification, error: storedVerificationError } = await supabase
    .from('shortlist_verification_state')
    .select('placement_drive_id,verification_state')
    .eq('user_id', userId)
    .in('placement_drive_id', Array.from(eligibleDriveIds));
  if (storedVerificationError) throw storedVerificationError;
  for (const row of storedVerification || []) existingVerification.set(row.placement_drive_id, row.verification_state);
  const appRowsByDrive = new Map((applications || []).map((app) => [app.placement_drive_id, app]));
  const pendingSeeds = Array.from(eligibleDriveIds)
    .filter((driveId) => appRowsByDrive.has(driveId) && !appRowsByDrive.get(driveId)?.manual_override && !existingVerification.has(driveId))
    .map((driveId) => ({
      user_id: userId,
      placement_drive_id: driveId,
      verification_state: 'pending',
      checked_roster_count: 0,
      last_error: null,
      checked_at: null,
      updated_at: new Date().toISOString(),
    }));
  if (pendingSeeds.length) {
    const { error: seedError } = await supabase
      .from('shortlist_verification_state')
      .upsert(pendingSeeds, { onConflict: 'user_id,placement_drive_id', ignoreDuplicates: true });
    if (seedError) throw seedError;
  }

  const verificationByDrive = new Map<string, {
    rosterResults: Array<{ relevant: boolean; parsed: boolean; candidatePresent: boolean }>;
    matchDetails: string | null;
  }>();
  for (const match of existingMatches || []) {
    if (!match.placement_drive_id || !isShortlistMatchEvidence({
      matchType: match.match_type,
      matchedValue: match.matched_value,
      matchedRoundType: match.matched_round_type,
    })) continue;
    const state = verificationByDrive.get(match.placement_drive_id) || { rosterResults: [], matchDetails: null };
    state.rosterResults.push({ relevant: true, parsed: true, candidatePresent: true });
    state.matchDetails = match.matched_value || state.matchDetails;
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
    let driveId = directDriveId || (new Set(matchedByNumber).size === 1 ? matchedByNumber[0] : undefined);
    if (!driveId && email.parsed_company_name) {
      const companyDrives = driveByCompanyName.get(email.parsed_company_name.toLowerCase().trim()) || [];
      if (companyDrives.length === 1) driveId = companyDrives[0];
      else if (companyDrives.length > 1) {
        // An ambiguous same-company circular cannot prove absence for any one
        // sibling drive. Defer only the drives evidenced for this user.
        for (const possibleDriveId of companyDrives.filter((id) => eligibleDriveIds.has(id))) {
          const unresolved = verificationByDrive.get(possibleDriveId) || { rosterResults: [], matchDetails: null };
          unresolved.rosterResults.push({ relevant: true, parsed: false, candidatePresent: false });
          verificationByDrive.set(possibleDriveId, unresolved);
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
      const unresolved = verificationByDrive.get(driveId) || { rosterResults: [], matchDetails: null };
      unresolved.rosterResults.push({ relevant: true, parsed: false, candidatePresent: false });
      verificationByDrive.set(driveId, unresolved);
    }
  }

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
    verificationByDrive.set(driveId, driveResult);
    if (existingRefs.has(`${driveId}|${email.id}`) || evaluation.state !== 'verified_present') continue;

    const round = /interview|selection\s+process/i.test(email.subject || '')
      ? 'interview'
      : /final\s*selection|selection\s*list/i.test(email.subject || '')
      ? 'selected'
      : /online\s+test|coding\s+test|assessment|test\s+shortlist/i.test(email.subject || '')
      ? 'test'
      : null;
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

  const applicationsByDrive = new Map((applications || []).map((application) => [application.placement_drive_id, application]));
  for (const driveId of eligibleDriveIds) {
    const app = applicationsByDrive.get(driveId);
    if (!app || app.manual_override) continue;
    const result = verificationByDrive.get(driveId);
    if (!result) {
      const priorState = existingVerification.get(driveId);
      if (priorState === 'verified_present' || priorState === 'verified_absent' || priorState === 'not_published') continue;
      const emptyScanState = archiveReadyForNegative ? 'not_published' : 'deferred';
      const { error: pendingError } = await supabase.from('shortlist_verification_state').upsert({
        user_id: userId,
        placement_drive_id: driveId,
        verification_state: emptyScanState,
        checked_roster_count: 0,
        last_error: archiveReadyForNegative ? null : 'Shared College archive scan is not complete yet.',
        checked_at: archiveReadyForNegative ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,placement_drive_id' });
      if (pendingError) throw pendingError;
      if (app.status === 'not_shortlisted') {
        const { error: appError } = await supabase
          .from('applications')
          .update({ status: 'applied', status_source: 'sync_reprocess', last_updated: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('placement_drive_id', driveId);
        if (appError) throw appError;
      }
      continue;
    }
    const verification = resolveDriveVerification({ scans: result.rosterResults, archiveComplete: archiveReadyForNegative });
    const priorState = existingVerification.get(driveId);
    if (verification.state === 'not_published' && priorState === 'verified_absent') {
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

    const { error: verificationError } = await supabase
      .from('shortlist_verification_state')
      .upsert({
        user_id: userId,
        placement_drive_id: driveId,
        verification_state: verification.state,
        checked_roster_count: verification.checkedRosterCount,
        last_error: verification.state === 'deferred' ? 'One or more relevant rosters could not be verified.' : null,
        checked_at: verification.state === 'deferred' ? null : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,placement_drive_id' });
    if (verificationError) throw verificationError;

    if (['deferred', 'not_published'].includes(verification.state) && app.status === 'not_shortlisted') {
      const { error: appError } = await supabase
        .from('applications')
        .update({ status: 'applied', status_source: 'sync_reprocess', last_updated: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('placement_drive_id', driveId);
      if (appError) throw appError;
    }

    if (nextStatus && app.status !== nextStatus) {
      const { error: appError } = await supabase
        .from('applications')
        .update({ status: nextStatus, status_source: 'sync_reprocess', status_confidence: 'high', last_updated: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('placement_drive_id', driveId);
      if (appError) throw appError;
    }
  }

  return matchesCreated;
}
