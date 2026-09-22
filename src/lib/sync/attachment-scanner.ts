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
  // 1. Fetch user's college Gmail account
  const { data: collegeAccount, error: accError } = await supabase
    .from('gmail_accounts')
    .select('id, email, account_type, access_token_encrypted, refresh_token_encrypted, token_expiry, last_sync_at, last_history_id')
    .eq('user_id', userId)
    .eq('account_type', 'college')
    .eq('is_connected', true)
    .maybeSingle();

  if (accError || !collegeAccount) {
    return 0;
  }

  // 2. Fetch user's NeoPAT ID & college email
  const { data: user } = await supabase
    .from('users')
    .select('neo_id, email')
    .eq('id', userId)
    .single();

  const userNeoId = user?.neo_id || null;
  const userEmail = user?.email || collegeAccount.email;
  if (!userNeoId && !userEmail) return 0;

  // 3. Fetch candidate test/shortlist circular emails linked to placement drives
  let emailQuery = supabase
    .from('emails')
    .select('id, gmail_message_id, subject, placement_drive_id, classification, body_snippet')
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
  const { gmail } = await createGmailClient(collegeAccount as GmailAccount);

  for (const email of emailsToScan) {
    const messageId = email.gmail_message_id || email.id;
    try {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });

      const parts = msg.data.payload?.parts || [];
      const excelAttachments = parts
        .filter((p) => {
          const fn = (p.filename || '').toLowerCase();
          return (fn.endsWith('.xlsx') || fn.endsWith('.xls')) && Boolean(p.body?.attachmentId);
        })
        .map((p) => ({
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
        gmail,
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
