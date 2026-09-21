import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { runSync } from '@/lib/sync/engine';
import { OAuth2Client } from 'google-auth-library';
import { randomUUID } from 'node:crypto';

interface PubSubPayload {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}

interface GmailPushData {
  emailAddress?: string;
  historyId?: string;
}

/**
 * POST /api/webhooks/gmail
 *
 * Webhook receiver for Google Cloud Pub/Sub push notifications.
 * Automatically triggers incremental sync when a new email arrives in Gmail.
 */
export async function POST(req: NextRequest) {
  try {
    const authorization = req.headers.get('authorization');
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : null;
    const audience = process.env.GOOGLE_PUBSUB_AUDIENCE;
    const expectedServiceAccount = process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT;
    if (!token || !audience || !expectedServiceAccount) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const authClient = new OAuth2Client();
    const ticket = await authClient.verifyIdToken({
      idToken: token,
      audience,
    });
    const payload = ticket.getPayload();
    if (
      payload?.iss !== 'https://accounts.google.com' &&
      payload?.iss !== 'accounts.google.com'
    ) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (payload.email !== expectedServiceAccount) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body: PubSubPayload = await req.json();

    if (!body.message?.data) {
      return NextResponse.json({ message: 'No data in Pub/Sub payload' }, { status: 200 });
    }

    // Decode base64 Pub/Sub payload
    const decodedStr = Buffer.from(body.message.data, 'base64').toString('utf-8');
    let pushData: GmailPushData;

    try {
      pushData = JSON.parse(decodedStr);
    } catch {
      console.warn('Malformed Pub/Sub message data:', decodedStr);
      return NextResponse.json({ message: 'Invalid payload format' }, { status: 200 });
    }

    const { emailAddress, historyId } = pushData;

    if (!emailAddress) {
      return NextResponse.json({ message: 'Missing emailAddress' }, { status: 200 });
    }

    const messageId = body.message.messageId;
    const subscription = body.subscription;
    if (!messageId || !subscription) {
      return NextResponse.json({ error: 'Missing Pub/Sub message identity' }, { status: 400 });
    }

    const supabase = createAdminClient();

    const runId = randomUUID();
    const { data: claimed, error: claimError } = await supabase.rpc('claim_gmail_pubsub_message', {
      p_subscription: subscription,
      p_message_id: messageId,
      p_email_address: emailAddress,
      p_history_id: historyId || null,
      p_publish_time: body.message.publishTime || null,
      p_run_id: runId,
      p_lease_seconds: 120,
    });
    if (claimError) {
      console.error('[Pub/Sub] Idempotency claim failed:', claimError);
      return NextResponse.json({ error: 'Webhook idempotency is unavailable' }, { status: 503 });
    }
    if (claimed !== true) {
      return NextResponse.json({ success: true, duplicate: true }, { status: 200 });
    }

    // Find the user who owns this Gmail account
    const { data: account, error } = await supabase
      .from('gmail_accounts')
      .select('id, user_id, last_history_id')
      .eq('email', emailAddress)
      .eq('is_connected', true)
      .single();

    if (error || !account) {
      console.warn(`No connected account found for email ${emailAddress}`);
      await supabase.rpc('fail_gmail_pubsub_message', {
        p_subscription: subscription,
        p_message_id: messageId,
        p_run_id: runId,
        p_error: 'No connected Gmail account found',
      });
      return NextResponse.json({ message: 'Account not found' }, { status: 200 });
    }

    // Keep the invocation alive after acknowledging Pub/Sub. The lease in
    // runSync still deduplicates concurrent/replayed notifications.
    console.log(`[Pub/Sub] Triggering background sync for user ${account.user_id} (${emailAddress}) at historyId ${historyId}`);
    after(async () => {
      try {
        await runSync(account.user_id);
        const { error: completeError } = await supabase.rpc('complete_gmail_pubsub_message', {
          p_subscription: subscription,
          p_message_id: messageId,
          p_run_id: runId,
        });
        if (completeError) throw completeError;
      } catch (syncErr) {
        console.error(`[Pub/Sub] Background sync failed for user ${account.user_id}:`, syncErr);
        await supabase.rpc('fail_gmail_pubsub_message', {
          p_subscription: subscription,
          p_message_id: messageId,
          p_run_id: runId,
          p_error: syncErr instanceof Error ? syncErr.message : String(syncErr),
        });
        throw syncErr;
      }
    });

    return NextResponse.json({
      success: true,
      message: `Sync queued for ${emailAddress}`,
    }, { status: 200 });

  } catch (err) {
    console.error('Error handling Gmail Pub/Sub webhook:', err);
    return NextResponse.json({ error: 'Internal handler error' }, { status: 500 });
  }
}
