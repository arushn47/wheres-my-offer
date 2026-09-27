import { createAdminClient } from '@/lib/supabase/admin';
import { createGmailClient, GmailAccount } from '@/lib/gmail/client';
import { scanExcelAttachmentsForNeoId, scanSharedCollegeAttachmentsForNeoId } from '@/lib/sync/excel-parser';
import { normalizeDriveNumber } from '@/lib/drive-number';
import { isShortlistMatchEvidence } from '@/lib/sync/participation-evidence';

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
    .select('email_id, college_email_id')
    .eq('user_id', userId);

  const matchedEmailIds = new Set(
    (existingMatches || [])
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
    supabase.from('applications').select('placement_drive_id').eq('user_id', userId),
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
    ...((applications || []).map((app) => app.placement_drive_id).filter(Boolean) as string[]),
    ...((personalEmails || []).map((email) => email.placement_drive_id).filter(Boolean) as string[]),
    ...((existingMatches || [])
      .filter((match) => isShortlistMatchEvidence({
        matchType: match.match_type,
        matchedValue: match.matched_value,
        matchedRoundType: match.matched_round_type,
      }))
      .map((match) => match.placement_drive_id)
      .filter(Boolean) as string[]),
    ...(targetDriveIds || []),
  ]);
  if (eligibleDriveIds.size === 0) return 0;

  const driveRows = (drives || []).filter((drive) => eligibleDriveIds.has(drive.id));
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
  const { data: cachedAttachments, error: cachedAttachmentError } = await supabase
    .from('college_attachments')
    .select('college_email_id, parse_status, extracted_rows')
    .eq('parse_status', 'complete')
    .not('extracted_rows', 'is', null);
  if (cachedAttachmentError) throw cachedAttachmentError;
  const canonicalIdsWithParsedAttachments = new Set((cachedAttachments || []).map((attachment) => attachment.college_email_id));
  const canonicalEmailsWithAttachments = canonicalEmails.filter((email) => canonicalIdsWithParsedAttachments.has(email.id));
  if (canonicalEmailsWithAttachments.length === 0) return 0;

  const driveByCanonicalId = new Map<string, string>();
  const driveByNumber = new Map<string, string>();
  const driveByCompanyName = new Map<string, string[]>();
  for (const drive of driveRows) {
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
    (existingMatches || []).map((match) => `${match.placement_drive_id}|${match.college_email_id || ''}`)
  );

  const workItems = new Map<string, { driveId: string; email: (typeof canonicalEmails)[number] }>();
  for (const email of canonicalEmailsWithAttachments) {
    const text = email.subject || '';
    const shortlistContext =
      email.classification === 'shortlist' ||
      /shortlist|selection\s+list|selected\s+students|online\s+test|coding\s+test|assessment|interview/i.test(text);
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
    }
    if (!driveId || existingRefs.has(`${driveId}|${email.id}`)) continue;
    workItems.set(`${driveId}|${email.id}`, { driveId, email });
  }

  let matchesCreated = 0;
  for (const { driveId, email } of workItems.values()) {
    const result = await scanSharedCollegeAttachmentsForNeoId(
      supabase,
      email.id,
      userNeoId,
      userEmail,
      email.classification === 'shortlist' || /shortlist|selection|selected|test|assessment|interview/i.test(email.subject || '')
    );
    if (!result?.matched || !result.isActualShortlist) continue;

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
      matched_value: result.details,
      confidence: 'high',
    });
    if (!error || error.code === '23505') {
      matchesCreated++;
      existingRefs.add(`${driveId}|${email.id}`);
    }
  }

  return matchesCreated;
}
