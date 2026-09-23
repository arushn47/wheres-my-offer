import { createAdminClient } from '@/lib/supabase/admin';
import { createGmailClient, GmailAccount } from '@/lib/gmail/client';
import { scanExcelAttachmentsForNeoId } from '@/lib/sync/excel-parser';

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
    .from('emails')
    .select('id, gmail_message_id, gmail_account_id, subject, placement_drive_id, classification, body_snippet')
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
    .select('email_id')
    .eq('user_id', userId);

  const matchedEmailIds = new Set((existingMatches || []).map((m) => m.email_id));
  let emailsToScan = relevantEmails.filter((e) => !matchedEmailIds.has(e.id));
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
        const { error: insertError } = await supabase.from('candidate_matches').insert({
          user_id: userId,
          email_id: email.id,
          placement_drive_id: email.placement_drive_id,
          neo_id: userNeoId || userEmail,
          match_type: 'xlsx_cell',
          matched_round_type: /interview|selection\s+process/i.test(email.subject || '') ? 'interview'
            : /final\s*selection|selection\s*list/i.test(email.subject || '') ? 'selected'
            : /online\s+test|coding\s+test|assessment|test\s+shortlist/i.test(email.subject || '') ? 'test'
            : null,
          matched_value: excelMatch.details,
          confidence: 'high',
        });

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
