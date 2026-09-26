import { createGmailClient, fetchMessageDetail, type GmailAccount } from '@/lib/gmail/client';
import { canonicalBodyFromEmail } from '@/lib/sync/canonical-email';
import { createAdminClient } from '@/lib/supabase/admin';

type StoredEmailBody = {
  id: string;
  gmail_account_id?: string | null;
  gmail_message_id?: string | null;
  canonical_email_id?: string | null;
  assignment_source?: string | null;
  body_snippet: string | null;
  has_canonical_body?: boolean;
};

/**
 * Restore a truncated receipt body from Gmail when there is no canonical full-body copy,
 * or when the linked canonical_emails row itself has no full body stored.
 * V25 truncated these rows in-place; a follow-up sync skips processed emails, so recovery
 * has to explicitly re-fetch the original message.
 */
export async function recoverTruncatedEmailBodies(
  emails: StoredEmailBody[],
  supabase = createAdminClient()
): Promise<Map<string, string>> {
  const recovered = new Map<string, string>();
  // Deduplicate: only fetch one message per canonical_email_id, and cap candidates per run
  const seenCanonical = new Set<string>();
  const candidates: StoredEmailBody[] = [];
  for (const email of emails) {
    if (email.assignment_source === 'admin_unlinked') continue;
    if (!email.gmail_account_id || !email.gmail_message_id) continue;
    if (email.canonical_email_id) {
      if (!email.has_canonical_body && (!email.body_snippet || email.body_snippet.length <= 500)) {
        if (!seenCanonical.has(email.canonical_email_id)) {
          seenCanonical.add(email.canonical_email_id);
          candidates.push(email);
        }
      }
    } else if (email.body_snippet?.length === 500) {
      candidates.push(email);
    }
    if (candidates.length >= 20) break;
  }
  if (candidates.length === 0) return recovered;

  const accountIds = Array.from(new Set(candidates.map((email) => email.gmail_account_id!)));
  const { data: accountRows, error } = await supabase
    .from('gmail_accounts')
    .select('id, email, account_type, access_token_encrypted, refresh_token_encrypted, token_expiry, last_sync_at, last_history_id')
    .in('id', accountIds);
  if (error) {
    console.warn('[email-body-recovery] Could not load Gmail accounts:', error.message);
    return recovered;
  }

  const accountById = new Map((accountRows || []).map((account) => [account.id, account as GmailAccount]));
  const gmailPromiseByAccountId = new Map<string, ReturnType<typeof createGmailClient>>();
  let nextCandidate = 0;
  let quotaHit = false;
  const workerCount = Math.min(2, candidates.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextCandidate < candidates.length && !quotaHit) {
      const email = candidates[nextCandidate++];
      try {
        const accountId = email.gmail_account_id!;
        const account = accountById.get(accountId);
        if (!account) continue;
        let gmailPromise = gmailPromiseByAccountId.get(accountId);
        if (!gmailPromise) {
          gmailPromise = createGmailClient(account);
          gmailPromiseByAccountId.set(accountId, gmailPromise);
        }
        const { gmail } = await gmailPromise;

        const parsed = await fetchMessageDetail(gmail, email.gmail_message_id!);
        const fullBody = canonicalBodyFromEmail(parsed.bodyPlain, parsed.bodyHtml, parsed.bodySnippet);
        if (!fullBody || fullBody.length <= (email.body_snippet?.length || 0)) continue;

        if (email.canonical_email_id) {
          const { extractJobDetails, extractEvents } = await import('@/lib/sync/events');
          const jobDetails = extractJobDetails(fullBody);
          const events = extractEvents(parsed);

          await supabase
            .from('college_emails')
            .update({
              body_text: fullBody,
              body_snippet: fullBody.slice(0, 50000),
              parsed_job_details: jobDetails,
              parsed_events: events,
              identity_version: 2,
              updated_at: new Date().toISOString(),
            })
            .eq('id', email.canonical_email_id);
        } else {
          const { error: updateError } = await supabase
            .from('personal_emails')
            .update({ body_snippet: fullBody })
            .eq('id', email.id)
            .is('canonical_email_id', null);
          if (updateError) {
            console.warn(`[email-body-recovery] Could not restore email ${email.id}:`, updateError.message);
            continue;
          }
        }
        recovered.set(email.id, fullBody);
        // Pacing delay to stay well under per-minute rate limits
        await new Promise((r) => setTimeout(r, 100));
      } catch (recoveryError) {
        const errorStatus = (recoveryError as { status?: number; code?: number })?.status ??
          (recoveryError as { code?: number })?.code;
        if (errorStatus === 429 || errorStatus === 403) {
          console.warn('[email-body-recovery] Gmail quota limit reached, pausing recovery for this run');
          quotaHit = true;
          break;
        } else if (errorStatus !== 404) {
          console.warn(`[email-body-recovery] Could not fetch email ${email.id}:`, recoveryError);
        }
      }
    }
  });
  await Promise.all(workers);

  return recovered;
}
