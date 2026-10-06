import { createAdminClient } from '@/lib/supabase/admin';
import { DEFAULT_PREFERENCES, type NotificationPreferences } from './preferences-model';
export { DEFAULT_PREFERENCES, type NotificationPreferences } from './preferences-model';

const fallbackMemoryPrefs = new Map<string, { reminderEventTypes?: string[]; reminderLeadTimeMins?: number[] }>();

export async function getNotificationPreferences(
  userId: string
): Promise<NotificationPreferences> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('user_id', userId)
    .single();

  const memory = fallbackMemoryPrefs.get(userId);

  if (error || !data) {
    // Return defaults if not found
    return {
      userId,
      ...DEFAULT_PREFERENCES,
      reminderEventTypes: memory?.reminderEventTypes || DEFAULT_PREFERENCES.reminderEventTypes,
      reminderLeadTimeMins: memory?.reminderLeadTimeMins || DEFAULT_PREFERENCES.reminderLeadTimeMins,
    };
  }

  return {
    userId: data.user_id,
    browserPushEnabled: data.browser_push_enabled ?? true,
    inAppEnabled: data.in_app_enabled ?? true,
    notifyStatusChange: data.notify_status_change ?? true,
    notifyShortlist: data.notify_shortlist ?? true,
    notifyTests: data.notify_tests ?? true,
    notifyInterviews: data.notify_interviews ?? true,
    notifyPpt: data.notify_ppt ?? true,
    notifyNewJds: data.notify_new_jds ?? true,
    notifyReminders: data.notify_reminders ?? true,
    reminderEventTypes:
      data.reminder_event_types || memory?.reminderEventTypes || DEFAULT_PREFERENCES.reminderEventTypes,
    reminderLeadTimeMins:
      data.reminder_lead_time_mins || memory?.reminderLeadTimeMins || DEFAULT_PREFERENCES.reminderLeadTimeMins,
  };
}

/**
 * Updates the notification preferences for a user.
 */
export async function updateNotificationPreferences(
  userId: string,
  updates: Partial<Omit<NotificationPreferences, 'userId'>>
): Promise<NotificationPreferences> {
  const supabase = createAdminClient();

  const dbPayload: Record<string, unknown> = {
    user_id: userId,
    updated_at: new Date().toISOString(),
  };

  if (updates.browserPushEnabled !== undefined)
    dbPayload.browser_push_enabled = updates.browserPushEnabled;
  if (updates.inAppEnabled !== undefined)
    dbPayload.in_app_enabled = updates.inAppEnabled;
  if (updates.notifyStatusChange !== undefined)
    dbPayload.notify_status_change = updates.notifyStatusChange;
  if (updates.notifyShortlist !== undefined)
    dbPayload.notify_shortlist = updates.notifyShortlist;
  if (updates.notifyTests !== undefined)
    dbPayload.notify_tests = updates.notifyTests;
  if (updates.notifyInterviews !== undefined)
    dbPayload.notify_interviews = updates.notifyInterviews;
  if (updates.notifyPpt !== undefined)
    dbPayload.notify_ppt = updates.notifyPpt;
  if (updates.notifyNewJds !== undefined)
    dbPayload.notify_new_jds = updates.notifyNewJds;
  if (updates.notifyReminders !== undefined)
    dbPayload.notify_reminders = updates.notifyReminders;

  if (updates.reminderEventTypes !== undefined)
    dbPayload.reminder_event_types = updates.reminderEventTypes;
  if (updates.reminderLeadTimeMins !== undefined)
    dbPayload.reminder_lead_time_mins = updates.reminderLeadTimeMins;

  // Cache in fallback memory
  const existingMem = fallbackMemoryPrefs.get(userId) || {};
  if (updates.reminderEventTypes !== undefined) {
    existingMem.reminderEventTypes = updates.reminderEventTypes;
  }
  if (updates.reminderLeadTimeMins !== undefined) {
    existingMem.reminderLeadTimeMins = updates.reminderLeadTimeMins;
  }
  fallbackMemoryPrefs.set(userId, existingMem);

  let data: any = null;

  try {
    const res = await supabase
      .from('notification_preferences')
      .upsert(dbPayload, { onConflict: 'user_id' })
      .select('*')
      .single();

    if (res.error) throw res.error;
    data = res.data;
  } catch (err: any) {
    // If column doesn't exist yet in Supabase, retry without the new reminder columns
    if (err.message && (err.message.includes('reminder_event_types') || err.message.includes('reminder_lead_time_mins'))) {
      delete dbPayload.reminder_event_types;
      delete dbPayload.reminder_lead_time_mins;
      const retryRes = await supabase
        .from('notification_preferences')
        .upsert(dbPayload, { onConflict: 'user_id' })
        .select('*')
        .single();
      data = retryRes.data;
    } else {
      console.warn('[NotificationPreferences] Upsert warning, using memory fallback:', err.message);
    }
  }

  const memory = fallbackMemoryPrefs.get(userId);

  return {
    userId,
    browserPushEnabled: data?.browser_push_enabled ?? updates.browserPushEnabled ?? true,
    inAppEnabled: data?.in_app_enabled ?? updates.inAppEnabled ?? true,
    notifyStatusChange: data?.notify_status_change ?? updates.notifyStatusChange ?? true,
    notifyShortlist: data?.notify_shortlist ?? updates.notifyShortlist ?? true,
    notifyTests: data?.notify_tests ?? updates.notifyTests ?? true,
    notifyInterviews: data?.notify_interviews ?? updates.notifyInterviews ?? true,
    notifyPpt: data?.notify_ppt ?? updates.notifyPpt ?? true,
    notifyNewJds: data?.notify_new_jds ?? updates.notifyNewJds ?? true,
    notifyReminders: data?.notify_reminders ?? updates.notifyReminders ?? true,
    reminderEventTypes:
      data?.reminder_event_types || memory?.reminderEventTypes || updates.reminderEventTypes || DEFAULT_PREFERENCES.reminderEventTypes,
    reminderLeadTimeMins:
      data?.reminder_lead_time_mins || memory?.reminderLeadTimeMins || updates.reminderLeadTimeMins || DEFAULT_PREFERENCES.reminderLeadTimeMins,
  };
}
