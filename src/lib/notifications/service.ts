import { createAdminClient } from '@/lib/supabase/admin';
import { sendPushToUser, type PushNotificationPayload } from './push';
import { getNotificationPreferences } from './preferences';

export type NotificationType =
  | 'status_change'
  | 'shortlist_match'
  | 'test_scheduled'
  | 'interview_scheduled'
  | 'ppt_scheduled'
  | 'deadline_approaching'
  | 'new_company'
  | 'sync_complete'
  | 'general';

export interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  companyId?: string | null;
  applicationId?: string | null;
  eventId?: string | null;
  link?: string | null;
  /**
   * Deterministic idempotency key to prevent duplicate notifications.
   * Format: `${userId}:${companyId || 'global'}:${type}:${sourceKey}`
   */
  dedupeKey: string;
  pushPayload?: Partial<PushNotificationPayload>;
}

/**
 * Dispatches a notification to both In-App Notification Center and Web Push.
 * Adheres strictly to user preferences and idempotency.
 */
export async function sendNotification(
  params: CreateNotificationParams
): Promise<{ inAppCreated: boolean; pushSent: boolean }> {
  const {
    userId,
    type,
    title,
    body,
    companyId,
    applicationId,
    eventId,
    link,
    dedupeKey,
    pushPayload,
  } = params;

  const supabase = createAdminClient();

  // 1. Check user preferences
  const prefs = await getNotificationPreferences(userId);

  // Check category preference
  let isCategoryEnabled = true;
  switch (type) {
    case 'status_change':
      isCategoryEnabled = prefs.notifyStatusChange;
      break;
    case 'shortlist_match':
      isCategoryEnabled = prefs.notifyShortlist;
      break;
    case 'test_scheduled':
      isCategoryEnabled = prefs.notifyTests;
      break;
    case 'interview_scheduled':
      isCategoryEnabled = prefs.notifyInterviews;
      break;
    case 'ppt_scheduled':
      isCategoryEnabled = prefs.notifyPpt;
      break;
    case 'new_company':
      isCategoryEnabled = prefs.notifyNewJds;
      break;
    case 'deadline_approaching':
      isCategoryEnabled = prefs.notifyReminders;
      break;
    default:
      isCategoryEnabled = true;
  }

  if (!isCategoryEnabled) {
    return { inAppCreated: false, pushSent: false };
  }

  let inAppCreated = false;

  // 2. Insert into in-app notifications if in-app notifications are enabled
  if (prefs.inAppEnabled) {
    const { data: inserted, error: insertError } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        company_id: companyId || null,
        application_id: applicationId || null,
        event_id: eventId || null,
        type,
        title,
        message: body,
        body,
        link: link || (companyId ? `/companies/${companyId}` : '/'),
        dedupe_key: dedupeKey,
        is_read: false,
      })
      .select('id')
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        // Unique constraint violation on dedupe_key -> In-app was already recorded, continue to push!
        inAppCreated = false;
      } else {
        console.error('[Notification Service] In-app insert error:', insertError);
      }
    } else if (inserted) {
      inAppCreated = true;
    }
  }

  // 3. Dispatch Web Push notification if browser push is enabled
  let pushSent = false;
  if (prefs.browserPushEnabled) {
    const targetLink = link || (companyId ? `/companies/${companyId}` : '/');
    const { sent } = await sendPushToUser(userId, {
      ...pushPayload,
      title,
      body,
      tag: dedupeKey,
      data: {
        ...pushPayload?.data,
        url: targetLink,
        companyId: companyId || undefined,
        eventId: eventId || undefined,
        type,
      },
    });
    pushSent = sent > 0;
  }

  return { inAppCreated, pushSent };
}

// ============================================
// Specialized Notification Triggers
// ============================================

/**
 * Notifies user of an application status change (Applied -> Shortlisted, Withdrawn, etc.)
 */
export async function notifyStatusChange(params: {
  userId: string;
  companyId: string;
  companyName: string;
  oldStatus: string | null;
  newStatus: string;
  sourceEmailId?: string;
}) {
  const { userId, companyId, companyName, oldStatus, newStatus, sourceEmailId } = params;

  if (oldStatus === newStatus) return; // Do not notify if status did not change

  const dedupeKey = `status:${userId}:${companyId}:${newStatus}:${sourceEmailId || 'sync'}`;

  let title = `${companyName} — Status Update`;
  let body = `Your application status for ${companyName} has changed to ${newStatus.toUpperCase().replace(/_/g, ' ')}.`;

  if (newStatus === 'shortlisted') {
    title = `🎉 ${companyName} — Shortlisted!`;
    body = `You have been shortlisted for ${companyName}. Check your schedule for upcoming test rounds.`;
  } else if (newStatus === 'selected') {
    title = `🏆 ${companyName} — Offer / Selected!`;
    body = `Congratulations! You have received a selection/offer update for ${companyName}!`;
  } else if (newStatus === 'withdrawn') {
    title = `${companyName} — Application Withdrawn`;
    body = `Your ${companyName} application has been marked as withdrawn/opted-out.`;
  } else if (newStatus === 'not_shortlisted') {
    title = `${companyName} — Selection List Released`;
    body = `Selection list released for ${companyName}. Status marked as Not Shortlisted.`;
  }

  return sendNotification({
    userId,
    type: 'status_change',
    title,
    body,
    companyId,
    link: `/companies/${companyId}`,
    dedupeKey,
  });
}

/**
 * Notifies user when their Neo ID is found in an Excel shortlist.
 */
export async function notifyShortlistMatch(params: {
  userId: string;
  companyId: string;
  companyName: string;
  neoId: string;
  emailSubject: string;
  sourceEmailId?: string;
}) {
  const { userId, companyId, companyName, neoId, emailSubject, sourceEmailId } = params;
  const dedupeKey = `shortlist:${userId}:${companyId}:${neoId}:${sourceEmailId || 'match'}`;

  return sendNotification({
    userId,
    type: 'shortlist_match',
    title: `🎉 ${companyName} Shortlist Match!`,
    body: `Your Neo ID (${neoId}) was found in the official ${companyName} shortlist!`,
    companyId,
    link: `/companies/${companyId}`,
    dedupeKey,
  });
}

/**
 * Notifies user when a new test, PPT, or interview event is scheduled.
 */
export async function notifyEventScheduled(params: {
  userId: string;
  companyId: string;
  companyName: string;
  eventType: string;
  startTime: Date | null;
  venue?: string | null;
  eventId?: string;
}) {
  const { userId, companyId, companyName, eventType, startTime, venue, eventId } = params;

  const dateStr = startTime
    ? startTime.toLocaleString('en-IN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      })
    : 'Date TBD';

  const dateKey = startTime ? startTime.toISOString().slice(0, 10) : 'unknown';
  const dedupeKey = `event:${userId}:${companyId}:${eventType}:${dateKey}`;

  let title = `📅 ${companyName} — Event Scheduled`;
  let body = `${eventType.replace(/_/g, ' ').toUpperCase()} on ${dateStr}${venue ? ` at ${venue}` : ''}.`;
  let notifType: NotificationType = 'test_scheduled';

  if (['online_test', 'coding_test'].includes(eventType)) {
    title = `📝 ${companyName} — Online Test Scheduled`;
    body = `Online assessment scheduled for ${dateStr}${venue ? ` at ${venue}` : ''}.`;
    notifType = 'test_scheduled';
  } else if (['technical_interview', 'hr_interview', 'final_interview'].includes(eventType)) {
    title = `💼 ${companyName} — Interview Scheduled`;
    body = `Interview round scheduled for ${dateStr}${venue ? ` at ${venue}` : ''}.`;
    notifType = 'interview_scheduled';
  } else if (eventType === 'ppt') {
    title = `📢 ${companyName} — PPT Scheduled`;
    body = `Pre-Placement Talk scheduled for ${dateStr}${venue ? ` at ${venue}` : ''}.`;
    notifType = 'ppt_scheduled';
  }

  return sendNotification({
    userId,
    type: notifType,
    title,
    body,
    companyId,
    eventId,
    link: `/calendar`,
    dedupeKey,
  });
}

export async function checkAndNotifyRegistrationDeadlines(userId: string) {
  try {
    const prefs = await getNotificationPreferences(userId);
    if (!prefs.notifyReminders || !prefs.reminderEventTypes.includes('registration_deadline')) return;

    const supabase = createAdminClient();
    const now = Date.now();
    const { data: deadlines } = await supabase
      .from('events')
      .select('id, company_id, start_time, companies(name), applications!inner(status)')
      .eq('user_id', userId)
      .eq('event_type', 'registration_deadline')
      .gt('start_time', new Date(now).toISOString());

    for (const event of deadlines || []) {
      const application = Array.isArray(event.applications) ? event.applications[0] : event.applications;
      if (application?.status && application.status !== 'not_applied') continue;

      const deadlineTime = new Date(event.start_time).getTime();
      const company = Array.isArray(event.companies) ? event.companies[0] : event.companies;
      const companyName = company?.name || 'Placement Drive';

      for (const leadMinutes of prefs.reminderLeadTimeMins) {
        const deltaMinutes = (deadlineTime - now) / 60000;
        if (deltaMinutes > leadMinutes || deltaMinutes < leadMinutes - 15) continue;

        const dateStr = new Date(event.start_time).toLocaleString('en-IN', {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
        });
        await sendNotification({
          userId,
          type: 'deadline_approaching',
          title: `${companyName} — Registration Deadline Approaching`,
          body: `Registration closes ${dateStr}. Apply on NeoPAT before the deadline.`,
          companyId: event.company_id,
          eventId: event.id,
          link: `/companies/${event.company_id}`,
          dedupeKey: `deadline:${userId}:${event.company_id}:${event.start_time}:${leadMinutes}`,
        });
      }
    }
  } catch (err: any) {
    console.warn('[Notification Service] checkAndNotifyRegistrationDeadlines error:', err.message);
  }
}

/**
 * Notifies user when a connected Gmail account is disconnected or its token expires.
 */
export async function notifyAccountDisconnected(params: {
  userId: string;
  email: string;
  accountType: 'personal' | 'college';
}) {
  const { userId, email, accountType } = params;
  const accountLabel = accountType === 'college' ? 'College (VIT)' : 'Personal';
  const dedupeKey = `disconnect:${userId}:${email}`;

  return sendNotification({
    userId,
    type: 'general',
    title: `⚠️ ${accountLabel} Gmail Disconnected`,
    body: `Your ${accountLabel} Gmail (${email}) was disconnected or token expired. Reconnect in Settings to keep receiving placement updates!`,
    link: '/settings',
    dedupeKey,
    pushPayload: {
      title: `⚠️ ${accountLabel} Gmail Disconnected`,
      body: `Your ${email} connection expired. Please reconnect in Settings to keep placement sync active.`,
      data: {
        url: '/settings',
        type: 'general',
      },
    },
  });
}

/**
 * Checks for upcoming or ongoing events starting right now (within the last 20m or next 10m)
 * and dispatches a Live Now notification to the candidate.
 */
export async function checkAndNotifyLiveEvents(userId: string) {
  try {
    const supabase = createAdminClient();
    const now = new Date();
    const windowStart = new Date(now.getTime() - 20 * 60 * 1000).toISOString();
    const windowEnd = new Date(now.getTime() + 10 * 60 * 1000).toISOString();

    const { data: liveEvents } = await supabase
      .from('events')
      .select('id, company_id, event_type, title, start_time, venue, companies(name)')
      .eq('user_id', userId)
      .gte('start_time', windowStart)
      .lte('start_time', windowEnd);

    if (!liveEvents || liveEvents.length === 0) return;

    for (const ev of liveEvents) {
      const compName = (ev as any).companies?.name || 'Company';
      const dedupeKey = `live_event:${userId}:${ev.id}`;
      let title = `🔴 ${compName} — Placement Round Starting Now`;
      let body = `Your event for ${compName} has commenced. Best of luck!`;

      const evType = (ev.event_type || '').toLowerCase();
      if (/test|coding|assessment|hackerearth|mettl|shl/i.test(evType)) {
        title = `📝 ${compName} — Assessment Live Now`;
        body = `Your online test for ${compName} is live. Check your test platform link and begin.`;
      } else if (/interview/i.test(evType)) {
        title = `💼 ${compName} — Interview Live Now`;
        body = `Your interview round for ${compName} has started. Join your meeting room.`;
      } else if (/ppt/i.test(evType)) {
        title = `📢 ${compName} — Pre-Placement Talk Live Now`;
        body = `The pre-placement talk for ${compName} is underway. Join the presentation session.`;
      }

      await sendNotification({
        userId,
        type: 'test_scheduled',
        title,
        body,
        companyId: ev.company_id,
        eventId: ev.id,
        link: `/companies/${ev.company_id}`,
        dedupeKey,
      });
    }
  } catch (err: any) {
    console.warn('[Notification Service] checkAndNotifyLiveEvents error:', err.message);
  }
}

/**
 * Broadcasts an in-app system update notification to all users with deterministic deduplication.
 * Useful when engine rules or parsing improvements are deployed.
 */
export async function broadcastSystemNotification(params: {
  title: string;
  body: string;
  link?: string;
  versionKey: string;
}): Promise<number> {
  const supabase = createAdminClient();
  const { data: users, error } = await supabase.from('users').select('id');
  if (error || !users || users.length === 0) return 0;

  let sent = 0;
  for (const u of users) {
    const res = await sendNotification({
      userId: u.id,
      type: 'general',
      title: params.title,
      body: params.body,
      link: params.link || '/settings#engine-diagnostics',
      dedupeKey: `${u.id}:system_update:${params.versionKey}`,
    });
    if (res.inAppCreated) sent++;
  }
  return sent;
}

