import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Returns the start of the calendar day (00:00:00.000) for a given date in IST (Asia/Kolkata).
 * Campus placement cycles at VIT Bhopal & Vellore operate in Indian Standard Time (UTC+5:30).
 */
export function getStartOfRegistrationDate(date: Date): Date {
  const istDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
  // istDateStr is 'YYYY-MM-DD'
  return new Date(`${istDateStr}T00:00:00+05:30`);
}

/**
 * Formats a date in IST for user-facing admin messages (e.g. "29 Sept 2026").
 */
export function formatIstDate(date: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(date);
}

export interface DriveRegistrationBoundary {
  minAllowedDate: Date | null;
  registrationDate: Date | null;
  formattedRegistrationDate: string | null;
}

/**
 * Resolves the minimum allowed date for circulars and emails that can be linked
 * to a target placement drive.
 * 
 * Rule: Only emails received on or after the calendar date of the drive's NeoPAT
 * registration announcement can be linked to the drive.
 */
export async function getDriveRegistrationDateBoundary(
  supabase: SupabaseClient<any, any, any>,
  targetDriveIds: string[],
  fallbackCreatedAt?: string | null
): Promise<DriveRegistrationBoundary> {
  if (!targetDriveIds || targetDriveIds.length === 0) {
    return { minAllowedDate: null, registrationDate: null, formattedRegistrationDate: null };
  }

  // 1. Fetch earliest registration/eligibility NeoPAT personal email for these drives
  const { data: neopatEmails } = await supabase
    .from('personal_emails')
    .select('received_at')
    .in('placement_drive_id', targetDriveIds)
    .or('sender.ilike.%noreply.cdcinfo@vitstudent.ac.in%,classification.in.(registration,registration_confirmation),subject.ilike.%eligible%,subject.ilike.%registration%')
    .not('received_at', 'is', null)
    .order('received_at', { ascending: true })
    .limit(1);

  let regDate: Date | null = null;
  if (neopatEmails && neopatEmails.length > 0 && neopatEmails[0].received_at) {
    regDate = new Date(neopatEmails[0].received_at);
  }

  // 2. If not found, check source_email_id on target drives
  if (!regDate) {
    const { data: drives } = await supabase
      .from('placement_drives')
      .select('source_email_id, created_at')
      .in('id', targetDriveIds);

    const sourceIds = (drives || []).map((d: any) => d.source_email_id).filter(Boolean);
    if (sourceIds.length > 0) {
      const { data: sourceEmails } = await supabase
        .from('personal_emails')
        .select('received_at')
        .in('id', sourceIds)
        .not('received_at', 'is', null)
        .order('received_at', { ascending: true })
        .limit(1);

      if (sourceEmails && sourceEmails.length > 0 && sourceEmails[0].received_at) {
        regDate = new Date(sourceEmails[0].received_at);
      }
    }

    if (!regDate && drives && drives[0]?.created_at) {
      regDate = new Date(drives[0].created_at);
    }
  }

  // 3. Fallback to provided created_at if available
  if (!regDate && fallbackCreatedAt) {
    regDate = new Date(fallbackCreatedAt);
  }

  if (!regDate || isNaN(regDate.getTime())) {
    return { minAllowedDate: null, registrationDate: null, formattedRegistrationDate: null };
  }

  const minAllowedDate = getStartOfRegistrationDate(regDate);

  return {
    minAllowedDate,
    registrationDate: regDate,
    formattedRegistrationDate: formatIstDate(regDate),
  };
}

/**
 * Checks whether an email received date is on or after the drive's minimum allowed registration date.
 */
export function isEmailAllowedByDriveBoundary(
  emailDate: Date | string | null | undefined,
  minAllowedDate: Date | null
): boolean {
  if (!minAllowedDate) return true;
  if (!emailDate) return false;
  const t = new Date(emailDate).getTime();
  if (isNaN(t)) return false;
  return t >= minAllowedDate.getTime();
}

/**
 * Extracts a scheduled date timestamp from text (e.g. "scheduled on 21st September 2026").
 */
function extractScheduledDateFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  const m1 = text.match(/scheduled\s+on\s+[([]?(\d{1,2}(?:st|nd|rd|th)?)\s+([A-Za-z]+)(?:\s+(20\d{2}|\b2[4-7]\b))?/i);
  if (m1) {
    const day = m1[1].replace(/\D/g, '');
    const month = m1[2];
    const year = m1[3] ? (m1[3].length === 2 ? '20' + m1[3] : m1[3]) : '2026';
    const p = Date.parse(`${day} ${month} ${year} UTC`);
    if (!isNaN(p)) return p;
  }
  const m2 = text.match(/scheduled\s+on\s+[([]?(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2}|\b2[4-7]\b)/i);
  if (m2) {
    const day = parseInt(m2[1], 10);
    const month = parseInt(m2[2], 10) - 1;
    let year = parseInt(m2[3], 10);
    if (year < 100) year += 2000;
    return Date.UTC(year, month, day);
  }
  return null;
}

/**
 * Parses scheduled date from an email subject line or body text.
 * When an email is a forward or reply ("Fwd: Update: ..."), the subject typically preserves
 * an old thread title while the body contains the new current schedule.
 * Returns UTC timestamp in milliseconds or null if no scheduled date is found.
 */
export function parseScheduledDate(
  sub: string | null | undefined,
  bodyText?: string | null | undefined
): number | null {
  const isForwardOrReply = sub ? /^(?:fwd|re|fw)\s*:/i.test(sub) : false;
  if (isForwardOrReply && bodyText) {
    const bodyDate = extractScheduledDateFromText(bodyText.slice(0, 2500));
    if (bodyDate) return bodyDate;
  }

  if (sub) {
    const subDate = extractScheduledDateFromText(sub);
    if (subDate) return subDate;
  }

  if (bodyText) {
    const bodyDate = extractScheduledDateFromText(bodyText.slice(0, 2500));
    if (bodyDate) return bodyDate;
  }

  return null;
}

/**
 * Checks whether a circular's explicit scheduled date (if mentioned in subject or body)
 * is acceptable for the drive's minimum allowed registration date.
 * Rejects circulars whose explicit scheduled date is in the distant past (beyond graceDays).
 */
export function isCircularAllowedByScheduledDate(
  subject: string | null | undefined,
  minAllowedTime: number | null | undefined,
  graceDays = 7,
  bodyText?: string | null | undefined
): boolean {
  if (!minAllowedTime || minAllowedTime <= 0) return true;
  const scheduledDate = parseScheduledDate(subject, bodyText);
  if (!scheduledDate) return true;
  return scheduledDate >= (minAllowedTime - graceDays * 86400000);
}
