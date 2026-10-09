import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { feedbackInput } from '@/lib/security/input';

export async function POST(request: Request) {
  try {
    // 1. Enforce authentication — only logged-in users can submit feedback/bug reports
    const session = await getSession();
    if (!session || !session.userId) {
      return NextResponse.json(
        { error: 'Unauthorized. You must be signed in with Google to submit feedback or report issues.' },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => null);
    const parsed = feedbackInput.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid feedback. Supply a subject (up to 200 characters) and message (up to 10,000 characters).' }, { status: 400 });
    const { category, severity, subject, message, metadata } = parsed.data;

    // Sanitize and validate category & severity
    const validCategories = ['bug', 'feature', 'sync_issue', 'general'];
    const validSeverities = ['low', 'normal', 'high', 'critical'];

    const safeCategory = validCategories.includes(category) ? category : 'general';
    const safeSeverity = validSeverities.includes(severity) ? severity : 'normal';

    const supabase = createAdminClient();

    // Fetch user's neo_id if available
    let neoId: string | null = null;
    try {
      const { data: userProfile } = await supabase
        .from('users')
        .select('neo_id')
        .eq('id', session.userId)
        .single();
      neoId = userProfile?.neo_id || null;
    } catch {
      // Non-fatal if fetch fails
    }

    // 2. Persist to Supabase feedback_reports
    let savedToDb = false;
    let reportId: string | null = null;
    try {
      const { data: inserted, error: dbError } = await supabase
        .from('feedback_reports')
        .insert({
          user_id: session.userId,
          user_email: session.email,
          user_name: session.name || null,
          category: safeCategory,
          severity: safeSeverity,
          subject: subject.trim(),
          message: message.trim(),
          metadata: {
            ...metadata,
            neoId,
            submittedAt: new Date().toISOString(),
          },
          status: 'new',
        })
        .select('id')
        .single();

      if (!dbError && inserted) {
        savedToDb = true;
        reportId = inserted.id;
      } else if (dbError) {
        console.warn('[Feedback API] DB insert warning (migration may be pending):', dbError.message);
      }
    } catch (err: unknown) {
      console.warn('[Feedback API] DB error caught:', err instanceof Error ? err.message : err);
    }

    // 3. Dispatch Email to Developer
    const recipientEmail = process.env.FEEDBACK_RECIPIENT_EMAIL || 'arushmenon.7@gmail.com';
    const emailSubject = `[Where's My Offer ${safeCategory.toUpperCase()}] ${safeSeverity === 'critical' ? '🚨 CRITICAL: ' : ''}${subject.trim()}`;

    const severityColors: Record<string, string> = {
      critical: '#ef4444',
      high: '#f97316',
      normal: '#3b82f6',
      low: '#10b981',
    };

    const categoryBadges: Record<string, string> = {
      bug: '🐛 Bug / Error Report',
      feature: '💡 Feature Request',
      sync_issue: '🔄 Radar / Sync Issue',
      general: '💬 General Feedback',
    };

    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 640px; margin: 0 auto; background: #09090b; color: #e4e4e7; border-radius: 12px; overflow: hidden; border: 1px solid #27272a;">
        <div style="padding: 24px; border-bottom: 1px solid #27272a; background: #121215;">
          <h2 style="margin: 0 0 8px 0; font-size: 20px; color: #ffffff;">New Feedback & Support Submission</h2>
          <div style="display: flex; gap: 8px; align-items: center; font-size: 13px;">
            <span style="background: ${severityColors[safeSeverity] || '#3b82f6'}; color: #ffffff; padding: 3px 8px; border-radius: 6px; font-weight: 600; text-transform: uppercase;">
              ${safeSeverity} priority
            </span>
            <span style="background: #27272a; color: #a1a1aa; padding: 3px 8px; border-radius: 6px; font-weight: 500;">
              ${categoryBadges[safeCategory] || safeCategory}
            </span>
          </div>
        </div>

        <div style="padding: 24px;">
          <h3 style="margin-top: 0; color: #ffffff; font-size: 17px; font-weight: 600;">${escapeHtml(subject.trim())}</h3>
          <div style="background: #18181b; padding: 16px; border-radius: 8px; border: 1px solid #27272a; white-space: pre-wrap; font-size: 14px; line-height: 1.6; color: #d4d4d8;">
${escapeHtml(message.trim())}
          </div>

          <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid #27272a;">
            <h4 style="margin: 0 0 12px 0; font-size: 13px; text-transform: uppercase; color: #71717a; letter-spacing: 0.05em;">Student & Account Details</h4>
            <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
              <tr>
                <td style="padding: 6px 0; color: #a1a1aa; width: 140px;">Name:</td>
                <td style="padding: 6px 0; color: #ffffff; font-weight: 500;">${escapeHtml(session.name || 'Anonymous')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #a1a1aa;">Email:</td>
                <td style="padding: 6px 0; color: #34d399; font-weight: 500;">
                  <a href="mailto:${escapeHtml(session.email)}" style="color: #34d399; text-decoration: none;">${escapeHtml(session.email)}</a>
                </td>
              </tr>
              ${neoId ? `
              <tr>
                <td style="padding: 6px 0; color: #a1a1aa;">NeoPAT Reg ID:</td>
                <td style="padding: 6px 0; color: #ffffff; font-family: monospace;">${escapeHtml(neoId)}</td>
              </tr>
              ` : ''}
              <tr>
                <td style="padding: 6px 0; color: #a1a1aa;">User ID:</td>
                <td style="padding: 6px 0; color: #71717a; font-family: monospace; font-size: 11px;">${session.userId}</td>
              </tr>
              ${metadata.path ? `
              <tr>
                <td style="padding: 6px 0; color: #a1a1aa;">Page URL:</td>
                <td style="padding: 6px 0; color: #a1a1aa; font-family: monospace; font-size: 12px;">${escapeHtml(String(metadata.path))}</td>
              </tr>
              ` : ''}
              ${metadata.browser ? `
              <tr>
                <td style="padding: 6px 0; color: #a1a1aa;">Client Info:</td>
                <td style="padding: 6px 0; color: #a1a1aa; font-size: 12px;">${escapeHtml(String(metadata.browser))} (${escapeHtml(String(metadata.os || 'Unknown OS'))})</td>
              </tr>
              ` : ''}
            </table>
          </div>
        </div>

        <div style="padding: 16px 24px; background: #121215; border-top: 1px solid #27272a; font-size: 12px; color: #71717a; text-align: center;">
          Sent automatically via Where's My Offer Feedback & Support Radar
        </div>
      </div>
    `;

    let emailDispatched = false;

    // A) Resend API (standard direct fetch)
    if (process.env.RESEND_API_KEY) {
      try {
        const fromAddress = process.env.RESEND_FROM_EMAIL || "Where's My Offer <onboarding@resend.dev>";
        const resendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: fromAddress,
            to: [recipientEmail],
            reply_to: session.email,
            subject: emailSubject,
            html: emailHtml,
          }),
        });

        if (resendRes.ok) {
          emailDispatched = true;
          console.log(`[Feedback API] Email dispatched to ${recipientEmail} via Resend.`);
        } else {
          const errText = await resendRes.text();
          console.warn('[Feedback API] Resend API error response:', errText);
        }
      } catch (emailErr) {
        console.warn('[Feedback API] Resend fetch failed:', emailErr);
      }
    }

    // Fallback: If no Resend API key or if it failed, log neatly on server
    if (!emailDispatched) {
      console.warn('[Feedback API] Email was not dispatched; report persisted:', savedToDb);
    }

    return NextResponse.json({
      success: true,
      savedToDb,
      emailDispatched,
      reportId,
      message: 'Your feedback has been received. Thank you for helping us improve!',
    });
  } catch (error: unknown) {
    console.error('[Feedback API] Unexpected error:', error);
    return NextResponse.json(
      { error: 'An unexpected error occurred while processing your feedback.' },
      { status: 500 }
    );
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
