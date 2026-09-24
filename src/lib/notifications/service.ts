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

export function buildDeadlineNotificationDedupeKey(params: {
  userId: string;
  placementDriveId?: string | null;
  companyId?: string | null;
  deadline: Date | string;
  leadMinutes: number;
}): string {
  const identity = params.placementDriveId
    ? `drive:${params.placementDriveId}`
    : `legacy:${params.companyId || 'unscoped'}`;
  const deadlineSlot = new Date(params.deadline).toISOString().slice(0, 13);
  return `deadline:${params.userId}:${identity}:${deadlineSlot}:${params.leadMinutes}`;
}

export interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  companyId?: string | null;
  placementDriveId?: string | null;
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
    
    placementDriveId,
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

  // Fast-path duplicate suppression. The database unique dedupe_key remains
  // the race-safe backstop for concurrent callers.
  const { data: existingNotif } = await supabase
    .from('notifications')
    .select('id')
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();

  if (existingNotif) {
    return { inAppCreated: false, pushSent: false };
  }

  // Always persist the dedupe row even if in-app notifications are disabled so
  // we never double-send notifications or re-trigger dedupe logic
  const { data: inserted, error: insertError } = await supabase
    .from('notifications')
    .insert({
      user_id: userId,
      placement_drive_id: placementDriveId || null,
      event_id: eventId || null,
      type,
      title,
      message: body,
      body,
      link: link || (placementDriveId ? `/companies/${placementDriveId}` : '/'),
      dedupe_key: dedupeKey,
      is_read: !prefs.inAppEnabled,
    })
    .select('id')
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      // Fallback catch if race condition occurred
      inAppCreated = false;
      return { inAppCreated: false, pushSent: false };
    } else {
      console.error('[Notification Service] In-app insert error:', insertError);
    }
  } else if (inserted) {
    inAppCreated = prefs.inAppEnabled;
  }

  // 3. Dispatch Web Push only after provider success. A failed send must not
  // be reported as delivered; a future retry path can then attempt it again.
  let pushSent = false;
  if (prefs.browserPushEnabled) {
    const targetLink = link || (placementDriveId ? `/companies/${placementDriveId}` : '/');
    const pushResult = await sendPushToUser(userId, {
      ...pushPayload,
      title,
      body,
      tag: dedupeKey,
      data: {
        ...pushPayload?.data,
        url: targetLink,
        eventId: eventId || undefined,
        type,
      },
    });
    pushSent = pushResult.sent > 0;
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
  placementDriveId: string;
  companyName: string;
  oldStatus: string | null;
  newStatus: string;
  sourceEmailId?: string;
}) {
  const { userId, placementDriveId, companyName, oldStatus, newStatus, sourceEmailId } = params;

  if (oldStatus === newStatus) return; // Do not notify if status did not change

  const identity = placementDriveId;
  const dedupeKey = `status:${userId}:${identity}:${newStatus}`;

  let title = `${companyName} Update`;
  let body = `Status: ${newStatus.replace(/_/g, ' ')}`;

  if (newStatus === 'shortlisted') {
    title = `🎉 Shortlisted: ${companyName}`;
    body = `You're on the shortlist for the next round!`;
  } else if (newStatus === 'selected' || newStatus === 'offer_received') {
    title = `🏆 Offer: ${companyName}!`;
    body = `Congratulations! You got selected.`;
  } else if (newStatus === 'test_scheduled') {
    title = `📝 ${companyName} Test`;
    body = `Online test scheduled. Check calendar for timings.`;
  } else if (newStatus === 'interview_scheduled') {
    title = `💼 ${companyName} Interview`;
    body = `Interview scheduled. Check calendar for details.`;
  } else if (newStatus === 'ppt_scheduled') {
    title = `📢 ${companyName} PPT`;
    body = `Pre-placement talk scheduled.`;
  } else if (newStatus === 'withdrawn') {
    title = `${companyName}`;
    body = `Registration withdrawn.`;
  } else if (newStatus === 'not_shortlisted') {
    title = `${companyName}`;
    body = `Not shortlisted for the next round.`;
  } else if (newStatus === 'applied') {
    title = `${companyName}`;
    body = `Application confirmed.`;
  } else if (newStatus === 'rejected' || newStatus === 'rejected_test' || newStatus === 'rejected_interview') {
    title = `${companyName}`;
    body = `Not selected in this round.`;
  }

  return sendNotification({
    userId,
    type: 'status_change',
    title,
    body,
    placementDriveId,
    link: `/companies/${placementDriveId}`,
    dedupeKey,
  });
}

/**
 * Notifies user when their Neo ID is found in an Excel shortlist.
 */
export async function notifyShortlistMatch(params: {
  userId: string;
  placementDriveId: string;
  companyName: string;
  neoId: string;
  emailSubject: string;
  sourceEmailId?: string;
}) {
  const { userId, placementDriveId, companyName, neoId, emailSubject, sourceEmailId } = params;
  const identity = placementDriveId;
  const dedupeKey = `shortlist:${userId}:${identity}:${neoId}:${sourceEmailId || 'match'}`;

  return sendNotification({
    userId,
    type: 'shortlist_match',
    title: `🎉 Shortlisted: ${companyName}!`,
    body: `Found your ID on the shortlist. Check next round details.`,
    placementDriveId,
    link: `/companies/${placementDriveId}`,
    dedupeKey,
  });
}

/**
 * Notifies user when a new placement drive / JD is scanned and created.
 */
export async function notifyNewDrive(params: {
  userId: string;
  placementDriveId: string;
  companyName: string;
  role?: string | null;
  ctc?: string | null;
  stipend?: string | null;
  location?: string | null;
  driveMode?: string | null;
  category?: string | null;
  sourceEmailId?: string;
}) {
  const {
    userId,
    placementDriveId,
    companyName,
    role,
    location,
    driveMode,
    category,
    sourceEmailId,
  } = params;

  const identity = placementDriveId;
  const dedupeKey = `new_drive:${userId}:${identity}`;

  // Human, concise summary: Role • Mode • Location. No CTC, no robotic walls
  const cleanRole = role && !/^(?:tbd|na|n\/a|not\s+specified)$/i.test(role.trim()) ? role.trim() : null;
  const cleanMode = driveMode && !/^(?:unknown|tbd|na)$/i.test(driveMode.trim())
    ? driveMode.charAt(0).toUpperCase() + driveMode.slice(1).toLowerCase()
    : null;
  const cleanLocation = location && !/^(?:not\s+specified|tbd|na|n\/a)$/i.test(location.trim())
    ? location.trim()
    : null;

  const details = [cleanRole, cleanMode, cleanLocation].filter(Boolean);
  const body = details.length > 0
    ? details.join(' • ')
    : 'New placement circular posted. Tap to view details.';

  const categoryTag = category === 'Super Dream' ? '⚡ ' : category === 'Dream' ? '⭐ ' : '';
  const title = `${categoryTag}New Drive: ${companyName}`;

  return sendNotification({
    userId,
    type: 'new_company',
    title,
    body,
    placementDriveId,
    link: `/companies/${placementDriveId}`,
    dedupeKey,
    pushPayload: {
      title,
      body,
      data: {
        url: `/companies/${placementDriveId}`,
        type: 'new_company',
      },
    },
  });
}

/**
 * Notifies user when a new test, PPT, or interview event is scheduled.
 */
export async function notifyEventScheduled(params: {
  userId: string;
  placementDriveId: string;
  companyName: string;
  eventType: string;
  startTime: Date | null;
  venue?: string | null;
  eventId?: string;
  candidateConfirmed?: boolean;
}) {
  const {
    userId,
    placementDriveId,
    companyName,
    eventType,
    startTime,
    venue,
    eventId,
    candidateConfirmed = false,
  } = params;

  // Suppress scheduling notifications if candidate is eliminated or opted out
  const supabase = createAdminClient();
  const { data: app } = await supabase
    .from('applications')
    .select('status')
    .eq('user_id', userId)
    .eq('placement_drive_id', placementDriveId)
    .maybeSingle();

  const appStatus = (app?.status || '').toLowerCase();
  const isEliminated = ['not_shortlisted', 'rejected', 'rejected_test', 'rejected_interview', 'withdrawn', 'declined'].includes(appStatus);
  const isTestOrInterview = ['online_test', 'coding_test', 'technical_interview', 'hr_interview', 'final_interview'].includes(eventType);
  const hasEligibleStage = eventType === 'ppt'
    ? ['applied', 'ppt_scheduled', 'shortlisted', 'test_scheduled', 'interview_scheduled'].includes(appStatus)
    : ['shortlisted', 'test_scheduled', 'test_ongoing', 'test_completed', 'interview_scheduled', 'interview_completed', 'selected', 'offer_received'].includes(appStatus);

  if (isEliminated || (isTestOrInterview && !candidateConfirmed && !hasEligibleStage)) {
    return;
  }

  const dateStr = startTime
    ? startTime.toLocaleString('en-IN', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
    : '';

  const dateKey = startTime ? startTime.toISOString().slice(0, 10) : 'unknown';
  const identity = placementDriveId || `legacy-company:unscoped`;
  const dedupeKey = `event:${userId}:${identity}:${eventType}:${dateKey}`;

  const cleanVenue = venue && !/^(?:unknown|not\s+specified|tbd|na|n\/a)$/i.test(venue.trim()) ? venue.trim() : null;
  const details = [dateStr, cleanVenue].filter(Boolean).join(' • ');

  let title = `📅 ${companyName} Event`;
  let body = details || 'Check calendar for schedule.';
  let notifType: NotificationType = 'test_scheduled';

  if (['online_test', 'coding_test'].includes(eventType)) {
    title = `📝 ${companyName} Test`;
    body = details || 'Online test scheduled.';
    notifType = 'test_scheduled';
  } else if (['technical_interview', 'hr_interview', 'final_interview'].includes(eventType)) {
    title = `💼 ${companyName} Interview`;
    body = details || 'Interview round scheduled.';
    notifType = 'interview_scheduled';
  } else if (eventType === 'ppt') {
    title = `📢 ${companyName} PPT`;
    body = details || 'Pre-placement talk scheduled.';
    notifType = 'ppt_scheduled';
  } else if (eventType === 'registration_deadline') {
    title = `⏰ Deadline: ${companyName}`;
    body = dateStr ? `Closes ${dateStr} on NeoPAT.` : 'Registration closing soon.';
    notifType = 'deadline_approaching';
  }

  return sendNotification({
    userId,
    type: notifType,
    title,
    body,
    placementDriveId,
    eventId,
    link: eventType === 'registration_deadline' ? `/companies/${placementDriveId}` : `/calendar`,
    dedupeKey,
  });
}

export async function checkAndNotifyRegistrationDeadlines(userId: string) {
  try {
    const prefs = await getNotificationPreferences(userId);
    if (!prefs.notifyReminders || !prefs.reminderEventTypes.includes('registration_deadline')) return;

    const supabase = createAdminClient();
    const now = Date.now();
    const { data: deadlines, error: deadlinesError } = await supabase
      .from('events')
      .select('id, placement_drive_id, start_time, placement_drives(company_id, companies(name))')
      .eq('user_id', userId)
      .eq('event_type', 'registration_deadline')
      .gt('start_time', new Date(now).toISOString());

    if (deadlinesError || !deadlines || deadlines.length === 0) return;

    const placementDriveIds = Array.from(new Set(deadlines.map((d) => d.placement_drive_id).filter(Boolean)));
    const { data: apps } = await supabase
      .from('applications')
      .select('placement_drive_id, status')
      .eq('user_id', userId)
      .in('placement_drive_id', placementDriveIds);

    const appStatusMap = new Map<string, string>();
    for (const a of apps || []) {
      const s = (a.status || '').toLowerCase();
      if (a.placement_drive_id) appStatusMap.set(a.placement_drive_id, s);
    }

    const sortedLeadTimes = [...prefs.reminderLeadTimeMins].sort((a, b) => a - b);
    const seenEventIdentities = new Set<string>();

    for (const event of deadlines) {
      const targetIdentity = event.placement_drive_id ? `drive:${event.placement_drive_id}` : `event:${event.id}`;
      const timeSlot = new Date(event.start_time).toISOString().slice(0, 13);
      const identityKey = `${targetIdentity}:${timeSlot}`;
      if (seenEventIdentities.has(identityKey)) continue;
      seenEventIdentities.add(identityKey);

      const appStatus = event.placement_drive_id
        ? appStatusMap.get(event.placement_drive_id)
        : undefined;

      // Only remind if candidate has not applied yet
      if (appStatus && appStatus !== 'not_applied') continue;

      const deadlineTime = new Date(event.start_time).getTime();
      const remainingMs = deadlineTime - now;
      if (remainingMs <= 0) continue;

      const remainingMins = remainingMs / (60 * 1000);
      const pd = Array.isArray(event.placement_drives) ? event.placement_drives[0] : event.placement_drives;
      const company = Array.isArray(pd?.companies) ? pd.companies[0] : pd?.companies;
      const companyName = company?.name || 'Placement Drive';

      for (const leadMinutes of sortedLeadTimes) {
        if (remainingMins <= leadMinutes) {
           const dedupeKey = buildDeadlineNotificationDedupeKey({
             userId,
             placementDriveId: event.placement_drive_id,
             deadline: event.start_time,
             leadMinutes,
           });
          const approxTimeStr =
            remainingMins < 60
              ? `${Math.max(1, Math.round(remainingMins))} min`
              : remainingMins < 120
              ? `~1 hour`
              : `~${Math.round(remainingMins / 60)} hours`;

          const dateStr = new Date(event.start_time).toLocaleDateString('en-IN', {
            timeZone: 'Asia/Kolkata',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          });

          await sendNotification({
            userId,
            type: 'deadline_approaching',
            title: `⏰ Deadline: ${companyName}`,
            body: `Closes in ${approxTimeStr} (${dateStr}) on NeoPAT.`,
            placementDriveId: event.placement_drive_id,
            eventId: event.id,
            link: event.placement_drive_id ? `/companies/${event.placement_drive_id}` : '/',
            dedupeKey,
          });

          // Break to trigger only the closest applicable reminder bucket on this tick
          break;
        }
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
  const accountLabel = accountType === 'college' ? 'College' : 'Personal';
  const dedupeKey = `disconnect:${userId}:${email}`;

  return sendNotification({
    userId,
    type: 'general',
    title: `⚠️ Reconnect ${accountLabel} Gmail`,
    body: `Access token expired for ${email}. Reconnect in Settings.`,
    link: '/settings',
    dedupeKey,
    pushPayload: {
      title: `⚠️ Reconnect ${accountLabel} Gmail`,
      body: `Access token expired for ${email}. Reconnect in Settings.`,
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
      .select('id, placement_drive_id, event_type, title, start_time, venue, placement_drives(company_id, companies(name))')
      .eq('user_id', userId)
      .gte('start_time', windowStart)
      .lte('start_time', windowEnd);

    if (!liveEvents || liveEvents.length === 0) return;

    // Fetch application statuses for these companies to check candidate participation
    const placementDriveIds = [...new Set(liveEvents.map((e) => e.placement_drive_id).filter(Boolean))];
    const { data: apps } = await supabase
      .from('applications')
      .select('placement_drive_id, status')
      .eq('user_id', userId)
      .in('placement_drive_id', placementDriveIds);

    const appStatusMap = new Map((apps || []).map((a) => [a.placement_drive_id, (a.status || '').toLowerCase()]));

    for (const ev of liveEvents) {
      const appStatus = (ev.placement_drive_id ? appStatusMap.get(ev.placement_drive_id) : undefined) || 'not_applied';

      // Suppress live notifications if the user was eliminated, opted out, or not applied
      const isEliminatedOrOptedOut = [
        'not_shortlisted',
        'rejected',
        'rejected_test',
        'rejected_interview',
        'withdrawn',
        'declined',
        'not_applied',
      ].includes(appStatus);

      if (isEliminatedOrOptedOut) {
        continue;
      }

      const evType = (ev.event_type || '').toLowerCase();
      const isTestEvent = ['online_test', 'coding_test'].includes(evType);
      const isInterviewEvent = ['technical_interview', 'hr_interview', 'final_interview'].includes(evType);
      const hasEligibleStage = isTestEvent
        ? ['shortlisted', 'test_scheduled', 'test_ongoing', 'test_completed'].includes(appStatus)
        : isInterviewEvent
        ? ['interview_scheduled', 'interview_completed', 'selected', 'offer_received'].includes(appStatus)
        : true;

      if (!hasEligibleStage) {
        continue;
      }

      const pd = Array.isArray(ev.placement_drives) ? ev.placement_drives[0] : ev.placement_drives;
      const company = Array.isArray(pd?.companies) ? pd.companies[0] : pd?.companies;
      const compName = company?.name || 'Company';
      const targetIdentity = ev.placement_drive_id ? `drive:${ev.placement_drive_id}` : `event:${ev.id}`;
      const timeSlot = ev.start_time ? new Date(ev.start_time).toISOString().slice(0, 13) : 'now';
      const dedupeKey = `live_event:${userId}:${targetIdentity}:${evType}:${timeSlot}`;
      let title = `🔴 Live: ${compName}`;
      let body = `Event starting now.`;

      if (/test|coding|assessment|hackerearth|mettl|shl/i.test(evType)) {
        title = `🔴 Live: ${compName} Test`;
        body = `Assessment is live now. Good luck!`;
      } else if (/interview/i.test(evType)) {
        title = `🔴 Live: ${compName} Interview`;
        body = `Interview starting now. Join your meeting.`;
      } else if (/ppt/i.test(evType)) {
        title = `🔴 Live: ${compName} PPT`;
        body = `Pre-placement talk is starting now.`;
      }

      await sendNotification({
        userId,
        type: 'test_scheduled',
        title,
        body,
        placementDriveId: ev.placement_drive_id,
        eventId: ev.id,
        link: ev.placement_drive_id ? `/companies/${ev.placement_drive_id}` : '/',
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
