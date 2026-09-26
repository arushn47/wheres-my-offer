import { google } from 'googleapis';
import { createAdminClient } from '@/lib/supabase/admin';
import { decrypt } from '@/lib/crypto/tokens';
import { getNotificationPreferences } from '@/lib/notifications/preferences';
import { isInactiveStatus } from '@/lib/stages';
import { deriveEventEndTime } from '@/lib/event-duration';

export interface SyncCalendarEventParams {
  userId: string;
  title: string;
  startTime: string; // ISO string
  endTime?: string | null;
  venue?: string | null;
  description?: string | null;
  mode?: string | null;
  /** If provided, the existing GCal event will be updated in-place instead of searching/inserting. */
  gcalEventId?: string | null;
  eventId?: string | null;
  placementDriveId?: string | null;
  applicationId?: string | null;
}

/**
 * Creates an authorized OAuth2 client for Google Calendar API
 */
async function getCalendarOAuthClient(userId: string) {
  const supabase = createAdminClient();

  const { data: accounts } = await supabase
    .from('gmail_accounts')
    .select('*')
    .eq('user_id', userId)
    .not('refresh_token_encrypted', 'is', null);

  if (!accounts || accounts.length === 0) return null;

  const account = accounts.find((a) => a.account_type === 'personal') || accounts[0];
  if (!account.refresh_token_encrypted) return null;

  const refreshToken = decrypt(account.refresh_token_encrypted);
  const accessToken = account.access_token_encrypted ? decrypt(account.access_token_encrypted) : undefined;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
    access_token: accessToken,
  });

  return oauth2Client;
}

/**
 * Pushes an event to the user's primary Google Calendar.
 * - If `gcalEventId` is provided, updates that specific event (no duplicates).
 * - Otherwise falls back to a time-window fuzzy search, then inserts if no match found.
 * Returns the canonical GCal event ID so callers can persist it.
 */
export async function pushEventToGoogleCalendar(params: SyncCalendarEventParams): Promise<string | null> {
  try {
    const auth = await getCalendarOAuthClient(params.userId);
    if (!auth) return null;

    const calendar = google.calendar({ version: 'v3', auth });

    const startDate = new Date(params.startTime);
    if (isNaN(startDate.getTime())) return null;

    const fallbackEndDate = deriveEventEndTime(null, params.title, startDate);
    let endDate = params.endTime && !isNaN(new Date(params.endTime).getTime())
      ? new Date(params.endTime)
      : fallbackEndDate || new Date(startDate.getTime() + 60 * 60 * 1000);

    // Guard: Enforce positive duration if parsed endTime <= startTime
    if (endDate.getTime() <= startDate.getTime()) {
      endDate = fallbackEndDate || new Date(startDate.getTime() + 60 * 60 * 1000);
    }

    // Fetch user reminder preferences for Google Calendar alert popups
    const prefs = await getNotificationPreferences(params.userId);
    const reminderOverrides =
      prefs.notifyReminders && prefs.reminderLeadTimeMins?.length
        ? prefs.reminderLeadTimeMins.map((mins) => ({
            method: mins >= 1440 ? 'email' : 'popup',
            minutes: mins,
          }))
        : [
            { method: 'popup', minutes: 30 },
            { method: 'popup', minutes: 120 },
            { method: 'email', minutes: 1440 },
          ];

    const eventPayload = {
      summary: params.title,
      location: params.venue || 'Campus / Online',
      description:
        params.description ||
        `Placement Assessment / Event tracked by Where's My Offer.\nMode: ${params.mode || 'Offline'}\nVenue: ${params.venue || 'Campus / Online'}`,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: 'Asia/Kolkata',
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: 'Asia/Kolkata',
      },
      reminders: {
        useDefault: false,
        overrides: reminderOverrides,
      },
      extendedProperties: {
        private: {
          neotrackEventId: params.eventId || '',
          placementDriveId: params.placementDriveId || '',
          applicationId: params.applicationId || '',
        },
      },
    };

    // --- Path 1: We have a stored GCal event ID — update directly, no search needed ---
    if (params.gcalEventId) {
      try {
        const updateRes = await calendar.events.update({
          calendarId: 'primary',
          eventId: params.gcalEventId,
          requestBody: eventPayload,
        });
        return updateRes.data.id || null;
      } catch (updateErr: unknown) {
        // If the event was manually deleted from GCal (404), fall through to insert
        const status = (updateErr as { code?: number })?.code;
        if (status !== 404 && status !== 410) {
          console.error('Google Calendar update error:', updateErr);
          return null;
        }
        // Event no longer exists — fall through to insert a fresh one
      }
    }

    // Drive-owned events must not use company-name fuzzy matching: two drives
    // can have the same company prefix. Insert with stable metadata instead.
    if (params.placementDriveId) {
      const insertRes = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: eventPayload,
      });
      return insertRes.data.id || null;
    }

    // --- Path 2: No stored ID — legacy fuzzy search within ±4h window ---
    const timeMin = new Date(startDate.getTime() - 4 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(startDate.getTime() + 4 * 60 * 60 * 1000).toISOString();
    const companyPrefix = params.title.split(' - ')[0].trim();

    try {
      const searchRes = await calendar.events.list({
        calendarId: 'primary',
        timeMin,
        timeMax,
        q: companyPrefix,
      });

      const existingMatch = searchRes.data.items?.find((item) =>
        item.summary?.toLowerCase().includes(companyPrefix.toLowerCase())
      );

      if (existingMatch?.id) {
        const updateRes = await calendar.events.update({
          calendarId: 'primary',
          eventId: existingMatch.id,
          requestBody: eventPayload,
        });
        return updateRes.data.id || null;
      }
    } catch {
      // List failed or search error — proceed to insert directly
    }

    // --- Path 3: No existing event found — insert fresh ---
    const insertRes = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: eventPayload,
    });

    return insertRes.data.id || null;
  } catch (err) {
    console.error('Google Calendar Auto-Sync Error (user may need to reconnect for calendar scope):', err);
    return null;
  }
}

/**
 * Removes an event from Google Calendar.
 * - If `eventId` is provided, deletes that specific event directly (preferred).
 * - Falls back to name-based search only when no ID is available.
 */
export async function deleteEventFromGoogleCalendar(params: {
  userId: string;
  companyName: string;
  /** Preferred: direct GCal event ID. If provided, skips name-based search entirely. */
  eventId?: string | null;
}): Promise<boolean> {
  try {
    const auth = await getCalendarOAuthClient(params.userId);
    if (!auth) return false;

    const calendar = google.calendar({ version: 'v3', auth });

    // --- Fast path: delete by stored event ID ---
    if (params.eventId) {
      try {
        await calendar.events.delete({
          calendarId: 'primary',
          eventId: params.eventId,
        });
        return true;
      } catch (err: unknown) {
        const status = (err as { code?: number })?.code;
        // 404/410 means it was already deleted from GCal — still consider it a success
        if (status === 404 || status === 410) return true;
        console.error('Google Calendar Delete (by ID) Error:', err);
        return false;
      }
    }

    // --- Fallback: name-based search (legacy path, used when gcal_event_id is missing) ---
    const searchRes = await calendar.events.list({
      calendarId: 'primary',
      q: params.companyName,
    });

    if (searchRes.data.items && searchRes.data.items.length > 0) {
      for (const item of searchRes.data.items) {
        if (item.id) {
          await calendar.events.delete({
            calendarId: 'primary',
            eventId: item.id,
          });
        }
      }
      return true;
    }
    return false;
  } catch (err) {
    console.error('Google Calendar Delete Error:', err);
    return false;
  }
}

export interface ReconcileCalendarResult {
  success: boolean;
  message: string;
  updatedCount: number;
  insertedCount: number;
  deletedCount: number;
  totalEligible: number;
  error?: string;
}

const EVENT_STAGE: Record<string, number> = {
  ppt: 1,
  online_test: 2,
  coding_test: 2,
  aptitude_test: 2,
  group_discussion: 2,
  technical_interview: 3,
  hr_interview: 3,
  interview: 3,
  final_interview: 4,
  offer: 5,
};

const STATUS_MAX_STAGE: Record<string, number> = {
  applied: 2,
  ppt_scheduled: 2,
  shortlisted: 2,
  test_scheduled: 2,
  interview_scheduled: 3,
  selected: 5,
  offer_received: 5,
  rejected: 0,
  not_shortlisted: 0,
  not_applied: 0,
  declined: 0,
  withdrawn: 0,
};

/**
 * Reconciles the user's primary Google Calendar with their active placement schedule.
 * - Enforces identical eligibility filters as the NeoTrack calendar view.
 * - Deletes stale, duplicate, withdrawn, rejected, and deadline events.
 * - Updates changed events in-place.
 * - Inserts missing eligible events and links their gcal_event_id.
 */
export async function reconcileUserGoogleCalendar(userId: string): Promise<ReconcileCalendarResult> {
  const supabase = createAdminClient();

  // 1. Fetch user's eligible site events and pipeline status
  const [
    { data: events },
    { data: companies },
    { data: placementDrives },
    { data: applications },
  ] = await Promise.all([
    supabase
      .from('events')
      .select('id, placement_drive_id, event_type, title, start_time, end_time, venue, mode, manual_override, gcal_event_id')
      .eq('user_id', userId)
      .order('start_time', { ascending: true }),

    supabase
      .from('companies')
      .select('id, name'),

    supabase
      .from('placement_drives')
      .select('id, company_id'),

    supabase
      .from('applications')
      .select('id, placement_drive_id, status')
      .eq('user_id', userId),
  ]);

  const companyMap = new Map((companies || []).map((c) => [c.id, c.name]));
  const driveMap = new Map((placementDrives || []).map((d) => [d.id, d]));
  const appStatusMap = new Map((applications || []).map((a) => [a.placement_drive_id, a.status]));
  const driveAppMap = new Map((applications || []).map((a) => [a.placement_drive_id, a.id]));

  const seenKeys = new Set<string>();
  const eligibleEvents: Array<{
    id: string;
    companyId: string;
    placementDriveId: string | null;
    applicationId: string | null;
    companyName: string;
    eventType: string;
    title: string;
    startTime: string;
    endTime?: string | null;
    venue?: string | null;
    mode?: string | null;
    gcalEventId?: string | null;
    eventId?: string | null;
  }> = [];

  for (const evt of events || []) {
    // NEVER sync registration deadlines to Google Calendar
    if (evt.event_type === 'registration_deadline') continue;
    if (!evt.start_time) continue;

    // Filter by user reminder preferences if configured
    const userPrefs = await getNotificationPreferences(userId);
    if (userPrefs.notifyReminders && userPrefs.reminderEventTypes?.length) {
      if (!userPrefs.reminderEventTypes.includes(evt.event_type)) {
        continue;
      }
    }

    const status = appStatusMap.get(evt.placement_drive_id) || 'not_applied';
    const isManual = (evt as unknown as { manual_override?: boolean }).manual_override;

    // Filter out inactive/eliminated/withdrawn companies unless manually scheduled
    if (isInactiveStatus(status) && !isManual) {
      continue;
    }

    // Filter out stages beyond candidate's current progress
    if (!isManual) {
      const maxStage = STATUS_MAX_STAGE[status] ?? 2;
      const evtStage = EVENT_STAGE[evt.event_type] ?? 2;
      if (evtStage > maxStage) continue;
    }

    // Deduplicate identical company + event_type
    const key = `${evt.placement_drive_id}:${evt.event_type}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      const drive = driveMap.get(evt.placement_drive_id);
      const companyName = drive ? companyMap.get(drive.company_id) || 'Placement Drive' : 'Placement Drive';
      eligibleEvents.push({
        id: evt.id,
        companyId: drive?.company_id || evt.placement_drive_id,
        placementDriveId: evt.placement_drive_id,
        applicationId: (evt.placement_drive_id ? driveAppMap.get(evt.placement_drive_id) : null) || null,
        companyName,
        eventType: evt.event_type,
        title: evt.title || `${companyName} - ${evt.event_type}`,
        startTime: evt.start_time,
        endTime: evt.end_time,
        venue: evt.venue,
        mode: evt.mode,
        gcalEventId: evt.gcal_event_id,
        eventId: evt.id,
      });
    }
  }

  // 2. Fetch Google Calendar credentials
  const auth = await getCalendarOAuthClient(userId);
  if (!auth) {
    return {
      success: false,
      message: 'No personal Google account linked with Calendar permissions',
      updatedCount: 0,
      insertedCount: 0,
      deletedCount: 0,
      totalEligible: eligibleEvents.length,
      error: 'no_calendar_auth',
    };
  }

  const calendar = google.calendar({ version: 'v3', auth });

  // 3. Dynamic season window: 60 days in past to 180 days in future
  const now = Date.now();
  const timeMin = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now + 180 * 24 * 60 * 60 * 1000).toISOString();

  const allGcalItems: any[] = [];
  let pageToken: string | undefined = undefined;
  do {
    try {
      const res: any = await calendar.events.list({
        calendarId: 'primary',
        timeMin,
        timeMax,
        maxResults: 250,
        singleEvents: true,
        pageToken,
      });
      allGcalItems.push(...(res.data.items || []));
      pageToken = res.data.nextPageToken;
    } catch (listErr) {
      console.error('Google Calendar list error during reconcile:', listErr);
      break;
    }
  } while (pageToken);

  // ONLY touch events created by Where's My Offer / NeoTrack (safe guard for personal events)
  const neoTrackGcalEvents = allGcalItems.filter(
    (item) =>
      item.description?.includes("tracked by Where's My Offer") ||
      item.description?.includes("Where's My Offer") ||
      item.description?.includes('tracked by NeoTrack') ||
      item.description?.includes('NeoTrack')
  );

  let deletedCount = 0;
  let updatedCount = 0;
  let insertedCount = 0;

  const matchedAppEventIds = new Set<string>();

  // 4. Reconcile existing GCal events: Update valid active ones, delete duplicates & stale ones
  for (const gItem of neoTrackGcalEvents) {
    const gStart = gItem.start?.dateTime ? new Date(gItem.start.dateTime).getTime() : 0;
    const gSummary = (gItem.summary || '').toLowerCase();

    const itemDriveId = gItem.extendedProperties?.private?.placementDriveId;
    const itemEventId = gItem.extendedProperties?.private?.neotrackEventId;

    // Drive-owned records match by stable private metadata first. Company-name
    // fuzzy matching remains a legacy compatibility path only.
    const match = eligibleEvents.find((e) => {
      if (matchedAppEventIds.has(e.id)) return false; // Already claimed by another GCal event
      if (e.gcalEventId && e.gcalEventId === gItem.id) return true;
      if (e.placementDriveId && itemDriveId && e.placementDriveId === itemDriveId) {
        return e.id === itemEventId;
      }
      if (e.placementDriveId || itemDriveId) return false;

      const eStart = new Date(e.startTime).getTime();
      const sameDay = Math.abs(eStart - gStart) < 24 * 60 * 60 * 1000;
      const compLower = e.companyName.toLowerCase();
      const compMatch = gSummary.includes(compLower);

      const isPptE = e.eventType === 'ppt';
      const isPptG = /ppt|talk|pre[\s-]*placement/i.test(gSummary);
      const isTestE = /test|assessment|coding|aptitude/i.test(e.eventType);
      const isTestG = /test|assessment|coding|assessment/i.test(gSummary);
      const isInterviewE = /interview/i.test(e.eventType);
      const isInterviewG = /interview/i.test(gSummary);

      return sameDay && compMatch && ((isPptE && isPptG) || (isTestE && isTestG) || (isInterviewE && isInterviewG));
    });

    if (match) {
      // Valid event -> Update in place
      matchedAppEventIds.add(match.id);
      const startDate = new Date(match.startTime);
      const fallbackEndDate = deriveEventEndTime(null, match.title, startDate);
      let endDate = match.endTime && !isNaN(new Date(match.endTime).getTime())
        ? new Date(match.endTime)
        : fallbackEndDate || new Date(startDate.getTime() + 60 * 60 * 1000);

      // Guard: Enforce positive duration if parsed endTime <= startTime
      if (endDate.getTime() <= startDate.getTime()) {
        endDate = fallbackEndDate || new Date(startDate.getTime() + 60 * 60 * 1000);
      }

      try {
        await calendar.events.update({
          calendarId: 'primary',
          eventId: gItem.id,
          requestBody: {
            summary: match.title,
            location: match.venue || 'Campus / Online',
            description: `Placement Assessment / Event tracked by Where's My Offer.\nMode: ${match.mode || 'Offline'}\nVenue: ${match.venue || 'Campus / Online'}`,
            start: { dateTime: startDate.toISOString(), timeZone: 'Asia/Kolkata' },
            end: { dateTime: endDate.toISOString(), timeZone: 'Asia/Kolkata' },
            reminders: {
              useDefault: false,
              overrides: [
                { method: 'popup', minutes: 30 },
                { method: 'popup', minutes: 120 },
                { method: 'email', minutes: 1440 },
              ],
            },
            extendedProperties: {
              private: {
                neotrackEventId: match.id,
                placementDriveId: match.placementDriveId || '',
                applicationId: match.applicationId || '',
              },
            },
          },
        });

        // Update gcal_event_id in Supabase if not yet stored
        if (match.gcalEventId !== gItem.id) {
          await supabase.from('events').update({ gcal_event_id: gItem.id }).eq('id', match.id);
        }
        updatedCount++;
      } catch (updErr) {
        console.error(`Failed to update GCal event ${gItem.id}:`, updErr);
      }
    } else {
      // Stale, duplicate, or dead event -> DELETE from GCal!
      try {
        await calendar.events.delete({
          calendarId: 'primary',
          eventId: gItem.id,
        });
        deletedCount++;
      } catch (delErr) {
        console.error(`Failed to delete GCal event ${gItem.id}:`, delErr);
      }
    }
  }

  // 5. Insert any eligible events not yet present in GCal
  const toInsert = eligibleEvents.filter((e) => !matchedAppEventIds.has(e.id));
  for (const ins of toInsert) {
    const startDate = new Date(ins.startTime);
    const fallbackEndDate = deriveEventEndTime(null, ins.title, startDate);
    let endDate = ins.endTime && !isNaN(new Date(ins.endTime).getTime())
      ? new Date(ins.endTime)
      : fallbackEndDate || new Date(startDate.getTime() + 60 * 60 * 1000);

    // Guard: Enforce positive duration if parsed endTime <= startTime
    if (endDate.getTime() <= startDate.getTime()) {
      endDate = fallbackEndDate || new Date(startDate.getTime() + 60 * 60 * 1000);
    }

    try {
      const created = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: ins.title,
          location: ins.venue || 'Campus / Online',
          description: `Placement Assessment / Event tracked by Where's My Offer.\nMode: ${ins.mode || 'Offline'}\nVenue: ${ins.venue || 'Campus / Online'}`,
          start: { dateTime: startDate.toISOString(), timeZone: 'Asia/Kolkata' },
          end: { dateTime: endDate.toISOString(), timeZone: 'Asia/Kolkata' },
          reminders: {
            useDefault: false,
            overrides: [
              { method: 'popup', minutes: 30 },
              { method: 'popup', minutes: 120 },
              { method: 'email', minutes: 1440 },
            ],
          },
          extendedProperties: {
            private: {
              neotrackEventId: ins.id,
              placementDriveId: ins.placementDriveId || '',
              applicationId: ins.applicationId || '',
            },
          },
        },
      });

      if (created.data.id) {
        await supabase.from('events').update({ gcal_event_id: created.data.id }).eq('id', ins.id);
        insertedCount++;
      }
    } catch (insErr) {
      console.error(`Failed to insert GCal event for ${ins.companyName}:`, insErr);
    }
  }

  return {
    success: true,
    message: `Google Calendar synced: ${updatedCount} updated, ${insertedCount} inserted, ${deletedCount} stale events removed.`,
    updatedCount,
    insertedCount,
    deletedCount,
    totalEligible: eligibleEvents.length,
  };
}
