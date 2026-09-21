import type { gmail_v1 } from 'googleapis';

export interface WatchResponse {
  historyId: string;
  expiration: string;
}

/**
 * Registers a Gmail account for push notifications via Google Cloud Pub/Sub.
 *
 * @param gmail - Authenticated Gmail client
 * @param topicName - Full Pub/Sub topic name, e.g. "projects/my-project/topics/gmail-push"
 */
export async function setupGmailWatch(
  gmail: gmail_v1.Gmail,
  topicName: string
): Promise<WatchResponse | null> {
  try {
    const response = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName,
        labelIds: ['INBOX'],
      },
    });

    if (response.data.historyId && response.data.expiration) {
      return {
        historyId: String(response.data.historyId),
        expiration: String(response.data.expiration),
      };
    }

    return null;
  } catch (error) {
    console.error('Failed to setup Gmail watch:', error);
    return null;
  }
}

/**
 * Stops push notifications for a Gmail account.
 */
export async function stopGmailWatch(gmail: gmail_v1.Gmail): Promise<boolean> {
  try {
    await gmail.users.stop({ userId: 'me' });
    return true;
  } catch (error) {
    console.error('Failed to stop Gmail watch:', error);
    return false;
  }
}

/**
 * Renews Gmail Pub/Sub watch subscriptions for all connected accounts whose
 * watch is missing or expires within the next 48 hours.
 *
 * Called once per day by the cron job as a lightweight safety net.
 * The watch is initially registered at OAuth connect time (auth/callback).
 *
 * @param supabase - Admin Supabase client
 */
export async function renewExpiringWatches(
  supabase: ReturnType<typeof import('@/lib/supabase/admin').createAdminClient>
): Promise<{ renewed: number; failed: number }> {
  const topic = process.env.GOOGLE_PUBSUB_TOPIC;
  if (!topic) {
    console.log('[Watch Renewal] GOOGLE_PUBSUB_TOPIC not set — skipping watch renewal.');
    return { renewed: 0, failed: 0 };
  }

  // Fetch accounts whose watch expires within 48 hours, or has never been set
  const cutoff = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const { data: accounts, error } = await supabase
    .from('gmail_accounts')
    .select('id, email, user_id, access_token_encrypted, refresh_token_encrypted, token_expiry, last_history_id, account_type')
    .eq('is_connected', true)
    .or(`watch_expires_at.is.null,watch_expires_at.lt.${cutoff}`);

  if (error || !accounts || accounts.length === 0) {
    if (error) console.error('[Watch Renewal] Failed to fetch accounts:', error);
    return { renewed: 0, failed: 0 };
  }

  let renewed = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      const { createGmailClient } = await import('@/lib/gmail/client');
      const { gmail } = await createGmailClient(account as any);
      const result = await setupGmailWatch(gmail, topic);

      if (result) {
        // expiration is a Unix timestamp in milliseconds as a string
        const expiresAt = new Date(Number(result.expiration)).toISOString();
        await supabase
          .from('gmail_accounts')
          .update({
            watch_expires_at: expiresAt,
            // Only update history ID if account has already had an initial sync
            ...(account.last_history_id ? { last_history_id: result.historyId } : {}),
          })
          .eq('id', account.id);

        console.log(`[Watch Renewal] Renewed watch for ${account.email} — expires ${expiresAt}`);
        renewed++;
      } else {
        console.warn(`[Watch Renewal] Watch renewal returned null for ${account.email}`);
        failed++;
      }
    } catch (err) {
      console.error(`[Watch Renewal] Failed for ${account.email}:`, err);
      failed++;
    }
  }

  return { renewed, failed };
}
