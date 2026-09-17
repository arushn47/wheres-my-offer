import type { ParsedEmail } from '@/lib/gmail/client';

export interface ExtractedEvent {
  eventType:
    | 'registration_deadline'
    | 'ppt'
    | 'online_test'
    | 'coding_test'
    | 'technical_interview'
    | 'hr_interview'
    | 'final_interview'
    | 'result'
    | 'joining_date'
    | 'other';
  title: string;
  startTime: Date | null;
  endTime: Date | null;
  venue: string | null;
  mode: 'online' | 'offline' | 'hybrid' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  hasExplicitTime?: boolean;
}

export interface ExtractedJobDetails {
  role: string | null;
  category: string | null;
  ctc: string | null;
  stipend: string | null;
  location: string | null;
  neoIdMatched: boolean;
  matchedNeoIdValue: string | null;
}

/**
 * Extracts official NeoPAT / CDC Drive Number (e.g. "pat-PL-2026-1261") from text.
 */
export function extractDriveNumber(text: string): string | null {
  if (!text) return null;
  const m =
    text.match(/\b(pat-[A-Za-z0-9]+-\d{4}-\d{3,6})\b/i) ||
    text.match(/drive\s+number\s*[:\-–—\t]?\s*([a-z0-9\-_]+)/i);
  return m ? m[1].trim() : null;
}

/**
 * Extracts ALL drive numbers found anywhere in the text.
 * Used for cross-checking whether an unlinked email shares a drive number
 * with an already-established company (timing-correlation Fix B).
 */
export function extractAllDriveNumbers(text: string): string[] {
  if (!text) return [];
  const results: string[] = [];
  // Match all pat-* style drive IDs
  const patPattern = /\b(pat-[A-Za-z0-9]+-\d{4}-\d{3,6})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = patPattern.exec(text)) !== null) {
    results.push(m[1].trim().toLowerCase());
  }
  // Match "drive number: <token>" style references
  const driveNumPattern = /drive\s+number\s*[:\-–—\t]?\s*([a-z0-9\-_]+)/gi;
  while ((m = driveNumPattern.exec(text)) !== null) {
    const candidate = m[1].trim().toLowerCase();
    if (!results.includes(candidate)) results.push(candidate);
  }
  return results;
}

// ============================================
// Indian Date & Time Parser
// ============================================

/**
 * Month names and abbreviations map.
 */
const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Regex patterns for Indian email date/time formats:
 * - "11th August 2026 by 11:30 AM"
 * - "13th Aug 2026 @ 2.30 Pm"
 * - "14th Aug 2026 10 AM onwards"
 * - "10th August 2026 (6 PM)"
 * - "11/08/2026 at 10:00 AM"
 */
const MONTH_PATTERN =
  'january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec';

/**
 * Parses a date/time string from Indian placement emails.
 * Handles formats like:
 * - "13th August 2026 by 02:30 PM"
 * - "11-08-2026 by 7pm"
 * - "13th August 2026 by 11.00 am sharp"
 * - "14th Aug 2026 by 9.30 am"
 */
export interface ParsedDateTimeResult {
  date: Date | null;
  hasExplicitTime: boolean;
}

/**
 * Parses a date/time string from Indian placement emails.
 * Handles formats like:
 * - "13th August 2026 by 02:30 PM"
 * - "The PPT is at 3.30 pm."
 * - "EY is moved to tomm 8 pm"
 * - "11-08-2026 by 7pm"
 * - "02.09.2026"
 */
export interface ParsedDateTimeResult {
  date: Date | null;
  hasExplicitTime: boolean;
}

/**
 * Parses a date/time string and returns detailed result with explicit time flag.
 */
export function parseDateTimeWithConfidence(
  text: string,
  fallbackDate?: Date | null
): ParsedDateTimeResult {
  if (!text) return { date: null, hasExplicitTime: false };

  let day: number | null = null;
  let month: number | null = null;
  let year = fallbackDate ? fallbackDate.getFullYear() : new Date().getFullYear();

  // 1. Check DD-MM-YYYY, DD/MM/YYYY, or DD.MM.YYYY numeric format (e.g. "02.09.2026", "11-08-2026")
  const numMatch = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4}|\d{2})/);
  if (numMatch) {
    day = parseInt(numMatch[1], 10);
    month = parseInt(numMatch[2], 10) - 1;
    year =
      numMatch[3].length === 2
        ? 2000 + parseInt(numMatch[3], 10)
        : parseInt(numMatch[3], 10);
  } else {
    // 2. Check Named Month format: "13th August 2026", "2nd Sep 2026", "1st september"
    const nameMatch =
      text.match(
        new RegExp(
          `(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})(?:\\s+(\\d{4}))?`,
          'i'
        )
      ) ||
      text.match(
        new RegExp(
          `(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,\\s*(\\d{4}))?`,
          'i'
        )
      );

    if (nameMatch) {
      if (MONTHS[nameMatch[2]?.toLowerCase()] !== undefined) {
        day = parseInt(nameMatch[1], 10);
        month = MONTHS[nameMatch[2].toLowerCase()];
        if (nameMatch[3]) year = parseInt(nameMatch[3], 10);
      } else if (MONTHS[nameMatch[1]?.toLowerCase()] !== undefined) {
        month = MONTHS[nameMatch[1].toLowerCase()];
        day = parseInt(nameMatch[2], 10);
        if (nameMatch[3]) year = parseInt(nameMatch[3], 10);
      }
    }
  }

  // 3. Extract Time (e.g. "by 3.30 pm", "is at 3.30 pm", "at 11:30 AM", "by 7pm", "by 8 pm", "by 11.00 am sharp")
  let hours = 9;
  let minutes = 0;
  let hasExplicitTime = false;

  // Strip the matched date portion so "02.09.2026" doesn't get re-matched as time "2:09"
  let timeText = text;
  if (numMatch && numMatch.index !== undefined) {
    timeText = text.slice(0, numMatch.index) + text.slice(numMatch.index + numMatch[0].length);
  }

  const timeMatch =
    timeText.match(/(?:by|at|@|from|is\s+at)?\s*\(?\s*(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm|a\.m\.|p\.m\.|p\b|a\b)/i) ||
    timeText.match(/(?:by|at|@|from|is\s+at)\s*\(?\s*(\d{1,2})(?::|\.)(\d{2})\s*(?:hours|hrs|sharp)?/i);

  if (timeMatch) {
    let h = parseInt(timeMatch[1], 10);
    const indicator = timeMatch[3] ? timeMatch[3].toLowerCase() : '';
    const isPm = indicator.startsWith('p');
    if (isPm && h < 12) h += 12;
    if (!isPm && indicator && h === 12) h = 0;
    hours = h;
    if (timeMatch[2]) minutes = parseInt(timeMatch[2], 10);
    hasExplicitTime = true;
  }

  // 4. If no explicit calendar date was found, check relative words or fallback to email received date
  if (day === null || month === null) {
    if (fallbackDate) {
      const ref = new Date(fallbackDate);
      if (/tomm|tomorrow|tmrw|next\s+day/i.test(text)) {
        ref.setDate(ref.getDate() + 1);
      }
      day = ref.getDate();
      month = ref.getMonth();
      year = ref.getFullYear();
    } else {
      return { date: null, hasExplicitTime: false };
    }
  }

  // Construct explicitly in Indian Standard Time (IST, UTC+05:30)
  // This prevents UTC servers (e.g. Vercel) from shifting 2:30 PM IST into 8:00 PM IST!
  const monthStr = String(month + 1).padStart(2, '0');
  const dayStr = String(day).padStart(2, '0');
  const hourStr = String(hours).padStart(2, '0');
  const minStr = String(minutes).padStart(2, '0');
  const isoWithIstOffset = `${year}-${monthStr}-${dayStr}T${hourStr}:${minStr}:00+05:30`;

  const date = new Date(isoWithIstOffset);
  return {
    date: isNaN(date.getTime()) ? null : date,
    hasExplicitTime,
  };
}

/**
 * Convenience helper returning Date directly.
 */
export function parseDateTime(
  text: string,
  fallbackDate?: Date | null
): Date | null {
  return parseDateTimeWithConfidence(text, fallbackDate).date;
}

// ============================================
// Event Extractor
// ============================================

/**
 * Extracts placement events (PPT, Test, Interview) from an email.
 */
export function extractEvents(email: ParsedEmail): ExtractedEvent[] {
  const events: ExtractedEvent[] = [];

  // Strip email thread reply attributions (e.g. "On Tue, Sep 15, 2026 at 11:40 AM ... wrote:")
  // and quoted lines beginning with > so reply timestamps are NEVER parsed as event dates!
  const unquotedBody = (email.bodyPlain || email.bodySnippet || '')
    .replace(/On\s+[A-Za-z]{3},\s+[A-Za-z]{3}\s+\d{1,2},\s+\d{4}\s+at\s+[\d:apm\s.]+(?:[^\n\r]*?)wrote:?/gi, ' ')
    .replace(/On\s+\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\s+at\s+[\d:apm\s.]+(?:[^\n\r]*?)wrote:?/gi, ' ')
    .replace(/^>+.*$/gm, ' ')
    .replace(/Warm\s+regards[\s\S]*?(?:Dr\.?V\.?Samuel\s+Rajkumar|Director\(Career\s+Development\s+Centre\))[\s\S]*$/i, ' ')
    .replace(/\*?Disclaimer:\*?[\s\S]*$/i, ' ');

  const fullText = `${email.subject}\n${unquotedBody}`;
  const cleanNormalizedText = fullText.replace(/[*_`>#]/g, ' ').replace(/\s+/g, ' ');
  const refDate = email.receivedAt ? new Date(email.receivedAt) : new Date();

  // 0. Check for Registration Deadline or Form/Preference Submission Deadline
  const formOrRegDeadlineMatch =
    cleanNormalizedText.match(
      /(?:fill\s*(?:out|in)?\s*(?:the\s*)?(?:google\s*form|form|preference\s*form|survey)|submit\s*(?:the\s*)?(?:google\s*form|form|preference\s*form)|location\s*preference[\s\S]{0,50}?google\s*form)[\s\S]{0,100}?(?:on\s+or\s+before|by|before)\s*[:\-–—\t]*\s*([^\n\r]{1,80})/i
    ) ||
    cleanNormalizedText.match(
      /(?:last\s+date\s+for\s+registration|registration\s+deadline|register\s+(?:in\s+the\s+neo\s*pat\s+)?on\s+or\s+before|apply\s+before)\s*[:\-–—\t]*\s*([^\n\r]{1,80})/i
    );

  if (formOrRegDeadlineMatch && formOrRegDeadlineMatch[1]) {
    const rawCandidate = formOrRegDeadlineMatch[1].replace(/[*_`>#]/g, ' ').trim();
    const cleanCandidate = rawCandidate.split(/\b(?:website|job|eligibility|jd|note|mandatory|no\s+manual)\b/i)[0].trim();
    const parsed = parseDateTimeWithConfidence(cleanCandidate, refDate);
    if (parsed.date) {
      const isLocPref = /location\s*preference|preference\s*form/i.test(cleanNormalizedText);
      const isGForm = /google\s*form|survey/i.test(cleanNormalizedText);
      events.push({
        eventType: 'registration_deadline',
        title: isLocPref
          ? 'Location Preference Deadline'
          : isGForm
          ? 'Google Form Submission Deadline'
          : 'Registration Deadline',
        startTime: parsed.date,
        endTime: new Date(parsed.date.getTime() + 30 * 60 * 1000),
        venue: isGForm || isLocPref ? 'Google Form / NeoPAT' : 'NeoPAT Portal / Online Form',
        mode: 'online',
        confidence: 'high',
        hasExplicitTime: parsed.hasExplicitTime,
      });
    }
  }

  // 1. Check for Pre-Placement Talk (PPT)
  // Guard 1: exclude ".ppt" file attachment mentions (e.g. "find the attached PPT file")
  // Guard 2: exclude casual mentions like "will be shared post Pre Placement Talk", "after PPT"
  const isCasualPptMention = /shared\s+post|after\s+(?:the\s+)?ppt|will\s+be\s+shared\s+post|post\s+pre[\s-]*placement/i.test(fullText);
  const isPptUnannounced = /(?:date\s+of\s+visit|ppt|pre[\s-]*placement)\s*[:\-–—\t]?\s*(?:will\s+be\s+(?:announced|informed|shared)|tba|tbd|to\s+be\s+(?:announced|disclosed))/i.test(fullText);

  if (
    /ppt|pre[\s-]*placement\s*talk/i.test(fullText) &&
    !/ppt\s*file|\.ppt\b/i.test(fullText) &&
    !isCasualPptMention &&
    !isPptUnannounced
  ) {
    const pptIdx = fullText.search(/(?:ppt|pre[\s-]*placement\s*talk)/i);
    let snippetForPpt = fullText;
    if (pptIdx !== -1) {
      const start = Math.max(0, pptIdx - 50);
      const rawSlice = fullText.slice(start, pptIdx + 120);
      const relIdx = pptIdx - start;
      const afterPpt = rawSlice.slice(relIdx);
      const nextDateMatch = afterPpt.search(/(?:\r?\n|\*)\s*\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i);
      snippetForPpt = nextDateMatch !== -1 ? rawSlice.slice(0, relIdx + nextDateMatch) : rawSlice;
    }
    const parsed = parseDateTimeWithConfidence(snippetForPpt, refDate);
    const venue = extractVenue(snippetForPpt);

    // GUARD: Only schedule a PPT event if the text contains an EXPLICIT date or explicit time!
    const hasExplicitDateInText =
      parsed.hasExplicitTime ||
      /\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|tomm|tomorrow|tmrw)\b/i.test(snippetForPpt);

    if (parsed.date && hasExplicitDateInText) {
      events.push({
        eventType: 'ppt',
        title: 'Pre-Placement Talk (PPT)',
        startTime: parsed.date,
        endTime: new Date(parsed.date.getTime() + 60 * 60 * 1000), // +1 hour
        venue,
        mode: determineMode(snippetForPpt, venue),
        confidence: 'high',
        hasExplicitTime: parsed.hasExplicitTime,
      });
    }
  }

  const isRegistrationCircular =
    /registration/i.test(email.subject) ||
    /last\s+date\s+for\s+registration/i.test(fullText) ||
    /(?:category|eligibility|date\s+of\s+visit)[\s\S]{0,80}?(?:super\s+dream|dream\s+internship|dream\s+offer)/i.test(fullText);

  // Check for structured "Date of Visit:" schedule in registration circulars — ONLY extract PPT (tests and interviews require shortlisting!)
  if (isRegistrationCircular) {
    const visitBlockMatch = fullText.match(
      /date\s+of\s+visit\s*[:\-–—\t*]*\s*([\s\S]{1,400}?)(?:\b(?:eligible\s+branches|eligibility|ctc|stipend|last\s+date|website)\b|$)/i
    );
    if (visitBlockMatch && visitBlockMatch[1]) {
      const block = visitBlockMatch[1];
      const blockDateMatch = block.match(/(?:\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i);
      const visitDatePrefix = blockDateMatch ? blockDateMatch[0] : '';

      const pptInVisit = block.match(/(?:ppt|pre[\s-]*placement\s*talk)\s*[:\-–—\t*]*\s*([^\r\n*]{1,60})/i);
      if (pptInVisit && pptInVisit[1]) {
        const pptText = !/\d{1,2}[\/\-\.]\d{1,2}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(pptInVisit[1]) && visitDatePrefix
          ? `${visitDatePrefix} ${pptInVisit[1]}`
          : pptInVisit[1];
        const parsedPpt = parseDateTimeWithConfidence(pptText, refDate);
        if (parsedPpt.date && !events.some((e) => e.eventType === 'ppt')) {
          const pptVenue = extractVenue(pptInVisit[1]) || null;
          events.push({
            eventType: 'ppt',
            title: 'Pre-Placement Talk (PPT)',
            startTime: parsedPpt.date,
            endTime: new Date(parsedPpt.date.getTime() + 60 * 60 * 1000),
            venue: pptVenue,
            mode: determineMode(pptInVisit[1], pptVenue),
            confidence: parsedPpt.hasExplicitTime ? 'high' : 'medium',
            hasExplicitTime: parsedPpt.hasExplicitTime,
          });
        }
      }
    }
  }

  const subjectMentionsTest = /(?:test|assessment|coding)\s+(?:is\s+)?scheduled/i.test(email.subject);
  const subjectMentionsInterview = /interview/i.test(email.subject);

  // GUARDS against false assessment creation:
  // 1. Post-test / Already completed emails (e.g. "shortlisted based on the test", "already completed the assessment")
  const hasAssessmentAlreadyCompleted =
    /already\s+completed\s+(?:the\s+)?(?:assessment|test)|shortlisted\s+based\s+on\s+(?:the\s+)?test|not\s+(?:the\s+)?shortlist\s+for\s+(?:the\s+)?(?:further|next)\s+(?:selection\s+process|round)|not\s+to\s+consider\s+the\s+attached\s+list\s+as\s+(?:the\s+)?shortlist/i.test(cleanNormalizedText);

  // 2. Google Form / Location Preference submission emails
  const isFormOrPreferenceOnly =
    /(?:collect\s+(?:the\s+)?location\s+preference|fill\s+(?:out\s+)?(?:the\s+)?google\s+form|google\s+form\s+has\s+been\s+shared)/i.test(cleanNormalizedText) &&
    !/(?:coding|online)?\s*test\s+is\s+scheduled\s+on\b|test\s+link\s+is\b|interview\s+(?:is\s+)?scheduled\s+on\b/i.test(cleanNormalizedText);

  // 2. Check for Online / Coding Test
  // GUARD: In registration circulars (where candidate is merely registering/applying),
  // prospective test dates are tentative campus drive milestones, NOT confirmed test invitations.
  // Also guard against emails that are purely about filling a Google Form or where the test is already completed!
  const testMatch = cleanNormalizedText.match(
    /(?:(?:online|coding|aptitude|assessment|written)?\s*test(?:\s+date)?|date\s+of\s+visit[\s\S]{0,40}?\btest)\s*[:\-–—\t]?\s*([^\r\n]{1,100})/i
  );
  const snippetForTest = testMatch ? testMatch[0] : cleanNormalizedText;
  const hasTestKeyword =
    /(?:online|coding|aptitude|assessment|written)\s*test|hackerrank|hackerearth|mettl|amcat/i.test(cleanNormalizedText) ||
    Boolean(testMatch);

  if (
    hasTestKeyword &&
    (!isRegistrationCircular || subjectMentionsTest) &&
    !hasAssessmentAlreadyCompleted &&
    !isFormOrPreferenceOnly
  ) {
    const parsed = parseDateTimeWithConfidence(snippetForTest, refDate);
    const venue = extractVenue(cleanNormalizedText);

    const hasExplicitDate =
      parsed.hasExplicitTime ||
      /\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|tomm|tomorrow|tmrw)\b/i.test(snippetForTest);

    if (parsed.date && (hasExplicitDate || /hiring\s+test|coding\s+test\s+invitation|test\s+is\s+scheduled/i.test(cleanNormalizedText))) {
      events.push({
        eventType: 'online_test',
        title: /coding/i.test(cleanNormalizedText) ? 'Coding Test' : 'Online Assessment',
        startTime: parsed.date,
        endTime: new Date(parsed.date.getTime() + 90 * 60 * 1000), // +1.5 hours
        venue: venue || 'Online Link / Mettl / HackerRank',
        mode: 'online',
        confidence: parsed.hasExplicitTime ? 'high' : 'medium',
        hasExplicitTime: parsed.hasExplicitTime,
      });
    }
  }

  // 3. Check for Interview
  const alreadyHasTestEvent = events.some((e) =>
    ['online_test', 'coding_test'].includes(e.eventType)
  );

  const isInterviewUnannounced = /(?:interview|selection\s+process|date\s+of\s+visit)\s*[:\-–—\t]?\s*(?:will\s+be\s+(?:announced|informed|shared)|tba|tbd|to\s+be\s+(?:announced|disclosed))/i.test(cleanNormalizedText);

  const mentionsExplicitInterview = /interview|f2f|face\s+to\s+face|personal\s+discussion|panel/i.test(email.subject + ' ' + cleanNormalizedText);

  if (
    mentionsExplicitInterview &&
    (!alreadyHasTestEvent || subjectMentionsInterview) &&
    !isInterviewUnannounced &&
    (!isRegistrationCircular || subjectMentionsInterview) &&
    !isFormOrPreferenceOnly
  ) {
    const isTech = /technical/i.test(cleanNormalizedText);
    const isHr = /\bhr\b|human\s+resource/i.test(cleanNormalizedText);
    const interviewMatch = cleanNormalizedText.match(
      /(?:interview|personal\s+discussion|next\s+round\s+of\s+(?:the\s+)?(?:selection\s+process|selection|process)|physical\s+selection\s+process|selection\s+process)\s*(?:is\s+scheduled)?\s*[:\-–—]?\s*(?:from|on)?\s*\(?(.{1,120})/i
    );
    const snippetForInterview = interviewMatch ? interviewMatch[0] : cleanNormalizedText;
    const parsed = parseDateTimeWithConfidence(snippetForInterview, refDate);

    const hasExplicitDateInText =
      parsed.hasExplicitTime ||
      /\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|tomm|tomorrow|tmrw)\b/i.test(snippetForInterview);
    const isExplicitlyScheduled = /(?:interview|selection\s+process|next\s+round)\s+(?:is\s+)?scheduled/i.test(cleanNormalizedText);

    if (parsed.date && (hasExplicitDateInText || isExplicitlyScheduled)) {
      const venue = extractVenue(cleanNormalizedText);

      events.push({
        eventType: isTech ? 'technical_interview' : isHr ? 'hr_interview' : 'technical_interview',
        title: isTech
          ? 'Technical Interview'
          : isHr
          ? 'HR Interview'
          : 'Interview Round',
        startTime: parsed.date,
        endTime: new Date(parsed.date.getTime() + 60 * 60 * 1000),
        venue,
        mode: determineMode(cleanNormalizedText, venue),
        confidence: parsed.hasExplicitTime ? 'high' : 'medium',
        hasExplicitTime: parsed.hasExplicitTime,
      });
    }
  }

  // 4. Disambiguate combined PPT & Test announcements
  // When an email announces both PPT and Test in a single event schedule (e.g. "Chubb PPT & online Test is scheduled on 02.09.2026 by 3.30 pm"),
  // the announced time corresponds to the Pre-Placement Talk. The test is scheduled right after the PPT (+2.5 hours, e.g. 3:30 PM -> 6:00 PM).
  const pptEvent = events.find((e) => e.eventType === 'ppt');
  const testEvent = events.find((e) => ['online_test', 'coding_test'].includes(e.eventType));

  if (pptEvent && testEvent && pptEvent.startTime && testEvent.startTime) {
    const diffMs = Math.abs(testEvent.startTime.getTime() - pptEvent.startTime.getTime());
    if (diffMs < 30 * 60 * 1000) {
      pptEvent.endTime = new Date(pptEvent.startTime.getTime() + 90 * 60 * 1000); // 1.5 hours (3:30 PM - 5:00 PM)
      testEvent.startTime = new Date(pptEvent.startTime.getTime() + 2.5 * 60 * 60 * 1000); // +2.5 hours (e.g. 6:00 PM)
      testEvent.endTime = new Date(testEvent.startTime.getTime() + 90 * 60 * 1000); // 1.5 hours (6:00 PM - 7:30 PM)
    }
  }

  return events;
}

/**
 * Extracts venue / location details from email text.
 * Handles patterns like "@ Respective campus venues", "LC 202", "VIT Vellore campus".
 */
export function extractVenue(text: string): string | null {
  if (!text) return null;

  // 1. Explicit lab / campus mentions in user commands or emails
  if (/\b(?:respective\s+labs?|computer\s+labs?|in\s+labs?|at\s+labs?|physical\s+at\s+labs?)\b/i.test(text)) {
    return 'Respective Labs (Offline)';
  }
  if (/\b(?:physical|offline)\s+(?:at|in)\s+([A-Za-z0-9\s,\-]{2,40})/i.test(text)) {
    const m = text.match(/\b(?:physical|offline)\s+(?:at|in)\s+([A-Za-z0-9\s,\-]{2,40})/i);
    if (m && m[1]) {
      const clean = m[1].replace(/\s*(?:not\s+online|online|and).*$/i, '').trim();
      return `${clean} (Offline)`;
    }
  }
  if (/\b(?:lab|computer\s+lab)\b/i.test(text)) {
    if (/physical|offline|in\s+person|not\s+online/i.test(text)) return 'Respective Labs (Offline)';
  }

  // 2. Explicit "venue: <place>" (Exclude job work locations like "Location - Bangalore")
  const isJobCity = /^(?:bangalore|bengaluru|hyderabad|pune|mumbai|delhi|noida|gurgaon|gurugram|chennai|kolkata|coimbatore|kochi|ernakulam|trivandrum|ahmedabad|jaipur|chandigarh|pan\s+india|remote)\*?$/i;

  const venueMatch = text.match(
    /(?:venue|room|hall|place)\s*[:\-–—]\s*([^\r\n.,]+)/i
  );
  if (venueMatch && venueMatch[1]) {
    const raw = venueMatch[1].trim();
    if (raw.length > 0 && raw.length <= 50 && !isJobCity.test(raw)) return raw;
  }

  // 3. Check @ <place>
  const atMatch = text.match(/@\s*([A-Za-z0-9\s,\-]{3,45})(?:\r?\n|$|\.|\(|\b)/);
  if (atMatch && atMatch[1]) {
    const raw = atMatch[1].trim();
    if (/own\s+location/i.test(raw)) return 'Own Location';
    if (/pearl\s+research\s+park|prp/i.test(raw)) return 'Pearl Research Park (PRP)';
    if (/anna\s+auditorium/i.test(raw)) return 'Anna Auditorium';
    if (/channa\s+reddy/i.test(raw)) return 'Channa Reddy Auditorium';
    if (/sarojini\s+naidu/i.test(raw)) return 'Sarojini Naidu Gallery';
    if (/respective\s+campus/i.test(raw)) return 'Respective Campus Venues';
    if (/lab/i.test(raw)) return 'Respective Labs (Offline)';
    if (!isJobCity.test(raw)) return raw;
  }

  // 4. "at <building/room>"
  const atPlaceMatch = text.match(/\bat\s+(SJT\s*\d+|PRP\s*\d+|TT\s*\d+|MB\s*\d+|SMV\s*\d+|CB\s*\d+|Sarojini\s+Naidu|Anna\s+Auditorium|Channa\s+Reddy|Pearl\s+Research\s+Park|CDC\s+Office)/i);
  if (atPlaceMatch && atPlaceMatch[1]) {
    return atPlaceMatch[1].trim();
  }

  // 4b. "in / at <academic block / audi / auditorium / hall / lab>"
  const audiMatch = text.match(/\b(?:in|at)\s+([A-Za-z0-9\s,\-&/]+?(?:audi(?:torium)?|lab|hall|gallery|block|prp|sjt|mb|tt|smv|ab\s*\d+)(?:\s+and\s+[A-Za-z0-9\s,\-&/]+)?)/i);
  if (audiMatch && audiMatch[1]) {
    const raw = audiMatch[1].trim();
    if (raw.length >= 3 && !isJobCity.test(raw)) {
      return raw;
    }
  }

  if (/own\s+location/i.test(text) && !/not\s+own\s+location/i.test(text)) {
    return 'Own Location';
  }

  // 5. Check online vs offline
  const isExplicitOffline = /physical|offline|in[\s-]person|not\s+online/i.test(text);
  if (!isExplicitOffline && /online|virtual|teams|zoom|meet|google\s+meet/i.test(text)) {
    return 'Online / Virtual';
  }

  if (isExplicitOffline) {
    return 'Campus / Offline';
  }

  return null;
}

function determineMode(
  text: string,
  venue: string | null
): 'online' | 'offline' | 'hybrid' | 'unknown' {
  if (venue && /own\s*location/i.test(venue)) return 'online';
  if (/own\s*location/i.test(text) && !/not\s+own\s+location/i.test(text)) return 'online';
  if (/not\s+online|physical|offline|in[\s-]person/i.test(text)) return 'offline';
  if (venue && /offline|lab|hall|room|building|prp|sjt|auditorium/i.test(venue)) return 'offline';
  if (venue && /online|virtual|teams|zoom|meet/i.test(venue)) return 'online';
  if (/online|virtual|teams|zoom|meet/i.test(text)) return 'online';
  if (venue || /campus|hall|lab|room|building/i.test(text)) return 'offline';
  return 'unknown';
}

export type TravelRequirement = 'vellore' | 'chennai' | 'ap' | 'bhopal' | 'bhopal_lab' | 'online' | null;

/**
 * Extracts campus travel requirement / Mode for VIT Bhopal students strictly from the main circular email.
 */
export function extractTravelRequirement(text: string): TravelRequirement {
  const clean = text
    .replace(/[*_`>#]/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');

  // 1. Isolate the "Date of Visit" / Process Schedule section if present
  const scheduleMatch = clean.match(/(?:Date\s+of\s+Visit|Process\s+details|Process\s+schedule|Hiring\s+process)[\s\S]{1,600}?(?=(?:Eligible|Eligibility|CTC|Stipend|Selection|Website|Last\s+date)|$)/i);
  const targetText = scheduleMatch ? scheduleMatch[0] : clean;

  // 2. Bhopal exemption / deferred schedule / virtual mode check:
  // e.g. "Virtual Interview : 31st August 2026 (AP & Bhopal Campus Students)"
  // or "Interview Date: ... @ VIT Vellore campus (** VIT AP & VIT Bhopal shortlist in virtual mode)"
  // or "Amaravati and Bhopal campus students test dates will be confirmed shortly"
  const isBhopalVirtualOrExempt =
    /virtual\s+interview[^(]*?\(\s*(?:ap\s*&?\s*)?bhopal/i.test(targetText) ||
    /(?:vit\s+ap\s*(?:&|and)\s*)?vit\s+bhopal[^\n)]*?(?:in\s+virtual\s+mode|virtual|online)/i.test(targetText) ||
    /bhopal[^\n)]*?(?:shortlist\s+in\s+virtual\s+mode|in\s+virtual\s+mode)/i.test(targetText) ||
    /(?:amaravati\s+and\s+)?bhopal\s+campus\s+students\s+test\s+dates?\s+will\s+be\s+confirmed\s+shortly/i.test(clean) ||
    /bhopal\s+campus\s+students[^.\n]*?(?:confirmed\s+shortly|wait\s+for\s+the\s+update|separate\s+schedule|dates?\s+will\s+be\s+announced)/i.test(clean);

  if (isBhopalVirtualOrExempt) {
    if (/@\s*respective\s+campus\s+(?:venues|labs|campuses)|in\s+campus\s+lab|conducted\s+on-campus/i.test(clean)) return 'bhopal';
    if (/virtual|online/i.test(targetText)) return 'online';
    return 'bhopal';
  }

  // 3. Explicit Travel to Vellore check (e.g. "Interview : @ Physical VIT Vellore campus", "24th Sep Physical process - at VIT Vellore")
  const velloreRegexes = [
    /(?:physical\s+process|physical\s+interview|interview|process|selection|round|drive|physical)[\s\S]{0,80}?(?:at|@)\s*(?:physical\s+)?(?:vit\s+)?vellore/i,
    /(?:at|@)\s*(?:physical\s+)?vit\s+vellore/i,
    /(?:at|@)\s*vellore\s+campus/i,
    /physical\s+process[^.\n]*?vellore/i,
    /bhopal[\s\S]{0,80}?travel[\s\S]{0,40}?vellore/i,
    /travel\s+to\s+vellore/i,
    /@\s*vit\s+vellore\s+campus\s*\(\s*entire\s+physical/i,
  ];
  if (velloreRegexes.some((r) => r.test(targetText) || r.test(clean))) {
    return 'vellore';
  }

  // 4. Explicit Travel to Chennai check (Must be explicit travel for Bhopal students, not branch test schedules)
  const chennaiRegexes = [
    /bhopal[\s\S]{0,80}?travel[\s\S]{0,40}?chennai/i,
    /travel\s+to\s+chennai/i,
    /(?:physical\s+process|physical\s+interview)[\s\S]{0,50}?(?:at|@)\s*(?:physical\s+)?(?:vit\s+)?chennai/i,
  ];
  if (chennaiRegexes.some((r) => r.test(targetText) || r.test(clean))) {
    return 'chennai';
  }

  // 5. Explicit Travel to AP / Amaravati check
  const apRegexes = [
    /bhopal[\s\S]{0,80}?travel[\s\S]{0,40}?(?:ap|amaravati)/i,
    /travel\s+to\s+(?:ap|amaravati)/i,
    /(?:physical\s+process|physical\s+interview)[\s\S]{0,50}?(?:at|@)\s*(?:physical\s+)?(?:vit\s+)?(?:ap|amaravati)/i,
  ];
  if (apRegexes.some((r) => r.test(targetText) || r.test(clean))) {
    return 'ap';
  }

  // 6. Respective Campus Labs (All stages in campus labs / venues at Bhopal)
  if (
    /@\s*respective\s+campus\s+(?:labs|venues|lab)/i.test(targetText) ||
    /in\s+campus\s+lab\s+only/i.test(targetText) ||
    /report\s+to\s+lc\s*\d+/i.test(targetText) ||
    /@\s*lc\s*\d+/i.test(targetText) ||
    /campus\s*\/\s*offline/i.test(targetText) ||
    /conducted\s+on-campus/i.test(targetText)
  ) {
    return 'bhopal';
  }

  // 6. Online / Virtual
  if (
    /\bvirtual\b/i.test(targetText) ||
    /@\s*own\s+location/i.test(targetText) ||
    /online\s+mode/i.test(targetText) ||
    /@\s*online/i.test(targetText)
  ) {
    return 'online';
  }

  return null;
}

/**
 * Extracts Job Details (Role, CTC, Stipend, Location) from email text.
 */
export function extractJobDetails(text: string): ExtractedJobDetails {
  let role: string | null = null;
  let ctc: string | null = null;
  let stipend: string | null = null;
  let location: string | null = null;

  // Clean HTML tags, styles, CSS hex color codes (e.g. #333333, #666666), and excess whitespace
  const noHtml = text
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/#[0-9a-fA-F]{3,8}\b/g, ' ');

  const cleanText = noHtml
    .replace(/[*_`>#]/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');

  const unannouncedPattern = /will be (?:announced|informed|shared) later|tba|tbd|to be (?:announced|disclosed)|not disclosed/i;

  // 0. CSE Branch Eligibility Guard
  if (/other\s+than\s+(?:cse|computer)|(?:cse|computer|it)[^.\n]*?not\s+eligible|except\s+cse/i.test(cleanText)) {
    return { role: null, category: null, ctc: null, stipend: null, location: null, neoIdMatched: false, matchedNeoIdValue: null };
  }

  // 1. CTC Extraction — handles single LPA, ranges (e.g. "8.5 - 10 LPA", "30 _ 31 LPA"), PPO formulas, and additions ("14+1 LPA")
  const ctcBlockMatch = cleanText.match(/\b(?:CTC|Cost\s+to\s+Company|Salary|Package|Compensation|PPO\s+CTC|Gross\s+CTC|PPO)\b\s*[:\-–—\t]?\s*([\s\S]{1,500}?)(?:\b(?:Last date|Website|Location|Eligible|Eligibility|Stipend|Selection|Process|Registration)\b|$)/i);
  const relocationCompensationMatch = (ctcBlockMatch?.[1] || cleanText).match(
    /annual\s+compensation\s+of\s+(?:INR|₹|Rs\.?)?\s*(\d+(?:\.\d+)?)\s*(?:LPA|L\s*PA|Lakhs?|Lacs?|Lac|\bL\b)[\s\S]{0,220}?relocation\s+allowance[^\d]{0,30}(?:up\s+to\s+)?(\d+(?:\.\d+)?)\s*(?:LPA|L\s*PA|Lakhs?|Lacs?|Lac|\bL\b)/i
  );
  if (relocationCompensationMatch) {
    ctc = `${relocationCompensationMatch[1]} LPA + up to ${relocationCompensationMatch[2]} LPA relocation allowance`;
  } else if (ctcBlockMatch && unannouncedPattern.test(ctcBlockMatch[1])) {
    ctc = null;
  } else {
    // If the email has a section explicitly designated as NOT for Bhopal (e.g. "Below Roles only for 2 Campus Vellore, Chennai")
    // truncate text at that divider so non-Bhopal packages aren't attributed to Bhopal students.
    const nonBhopalSplit = cleanText.match(/(?:below\s+roles?\s+only\s+for|roles?\s+only\s+for\s+(?:2\s+campus\s+)?(?:vellore|chennai)|only\s+for\s+(?:vellore|chennai)\s+campus)/i);
    const textForBhopal = (nonBhopalSplit && nonBhopalSplit.index !== undefined)
      ? cleanText.slice(0, nonBhopalSplit.index)
      : cleanText;

    const isReferBelow = ctcBlockMatch && /refer (?:below|table|attached)|details below|as attached|refer\s+to\s+below/i.test(ctcBlockMatch[1]);
    const ctcText = (ctcBlockMatch && !isReferBelow) ? ctcBlockMatch[1].trim() : textForBhopal;
    
    // 0. Clean out multi-year Retention Bonus (RB) formulas and internal fixed/variable/bonus breakdowns
    // e.g. "14+1 +(RB -2+3+4) LPA" -> "14+1 LPA"
    // e.g. "15 LPA (₹14 LPA Fixed + ₹1 LPA Variable) + Retention Bonus(2 Lakh +3 Lakh +4 Lakh)" -> "15 LPA"
    // e.g. "11 Lakhs (10 LPA + 1L One-time Bonus)" -> "11 Lakhs"
    const sanitizedCtcText = ctcText
      .replace(/\+?\s*\(\s*(?:RB|Retention\s+Bonus)[^)]*\)/gi, ' ')
      .replace(/\+?\s*(?:RB|Retention\s+Bonus)\s*\([^)]*\)/gi, ' ')
      .replace(/\+?\s*Retention\s+Bonus\s*:[^,\n\r\.]+/gi, ' ')
      .replace(/\(\s*(?:INR|₹|Rs\.?)?\s*\d+[^)]*(?:fixed|variable|base|bonus|one-time|jb|joining)[^)]*\)/gi, ' ');

    // 1. Remove remaining bracket punctuation without deleting enclosed figures like "(CTC: ₹22 Lakhs)"
    const cleanCtc = sanitizedCtcText
      .replace(/[()\[\]]/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ');

    const nums: number[] = [];

    // 1.2. Structured TCTC (Total Cost To Company) Table Mapping:
    // When an email has a breakdown table with columns like "Fixed Pay", "Bonus", "TCTC@Target", "TCTC @MEP" (e.g. American Express),
    // extract values directly from the TCTC columns!
    const cleanWithLines = noHtml
      .replace(/[*_`>#]/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/[ \t]+/g, ' ');

    const tctcHeaderIndex = cleanWithLines.search(/\b(?:TCTC|Total\s+CTC)\b/i);
    if (tctcHeaderIndex !== -1) {
      const beforeTctc = cleanWithLines.slice(0, tctcHeaderIndex);
      const lastTableStart = beforeTctc.lastIndexOf('Course') !== -1 
        ? beforeTctc.lastIndexOf('Course') 
        : beforeTctc.lastIndexOf('CTC');
      const sliceStart = lastTableStart !== -1 ? lastTableStart : tctcHeaderIndex;
      const tctcSlice = cleanWithLines.slice(sliceStart, sliceStart + 800);
      const lines = tctcSlice.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !/^CTC$/i.test(l));

      const firstDataIndex = lines.findIndex((l, idx) => idx > 0 && /(?:B\.?Tech|CSE|Engineering|\d{1,3}(?:,\d{2,3})+)/i.test(l));
      if (firstDataIndex !== -1) {
        const headerCount = firstDataIndex;
        for (let i = 0; i < headerCount; i++) {
          if (/\b(?:TCTC|Total\s+CTC)\b/i.test(lines[i])) {
            const valLine = lines[headerCount + i];
            if (valLine) {
              const m = valLine.match(/\b(\d{1,3}(?:,\d{2,3})+|\d{6,8})\b/);
              if (m) {
                const val = parseInt(m[1].replace(/,/g, ''), 10);
                if (val >= 300000 && val <= 50000000) {
                  nums.push(Math.round((val / 100000) * 100) / 100);
                }
              }
            }
          }
        }
      }
    }

    // 1.5. Explicit labeled CTC totals (e.g. "CTC: ₹22 Lakhs", "CTC: 26 Lakhs", "PPO CTC: ₹10 LPA", "Full-Time Compensation: 15 LPA")
    if (nums.length === 0) {
      const labeledCtcMatches = [...cleanCtc.matchAll(/(?:CTC|PPO\s+CTC|Total\s+CTC|Gross\s+CTC|Full-Time\s+Compensation|Compensation)\s*[:\-–—\s]\s*(?:INR|₹|Rs\.?)?\s*(\d+(?:\.\d+)?)\s*(?:LPA|L\s*PA|Lakhs?|Lacs?|Lac|\bL\b)/gi)];
      if (labeledCtcMatches.length > 0) {
        for (const m of labeledCtcMatches) {
          const v = parseFloat(m[1]);
          if (v >= 3 && v < 200) nums.push(v);
        }
      }
    }

    // 2. Check for addition formulas: e.g. "14+1 LPA", "9LPA+1.2 Lakh JB", "9 LPA+1.2 JB"
    if (nums.length === 0) {
      const addMatches = [...cleanCtc.matchAll(/(\d+(?:\.\d+)?)(?:\s*(?:LPA|L\s*PA|Lakhs?|Lacs?|Lac|\bL\b))?\s*\+\s*(\d+(?:\.\d+)?)(?:\s*(?:LPA|L\s*PA|Lakhs?|Lacs?|Lac|\bL\b|JB|Joining\s+Bonus))?/gi)];
      for (const m of addMatches) {
        const sum = parseFloat(m[1]) + parseFloat(m[2]);
        if (sum >= 3 && sum < 200) {
          nums.push(sum);
        }
      }
    }

    // 3. Match ranges like "12 - 15 LPA", "30 _ 31 LPA", "8.5 to 10 LPA"
    if (nums.length === 0) {
      const rangeMatches = [...cleanCtc.matchAll(/(\d+(?:\.\d+)?)\s*(?:-|–|—|_|\bto\b)\s*(\d+(?:\.\d+)?)\s*(?:LPA|L\s*PA|Lakhs?|Lacs?|Lac|\bL\b)/gi)];
      for (const m of rangeMatches) {
        const v1 = parseFloat(m[1]);
        const v2 = parseFloat(m[2]);
        if (v1 >= 3 && v1 < 200) nums.push(v1);
        if (v2 >= 3 && v2 < 200) nums.push(v2);
      }
    }

    // 4. Match individual LPA numbers like "20 LPA", "7.5 LPA", "14.5 LPA", "10 Lakhs"
    // GUARD: When scanning full text (not an isolated CTC block), only accept values that
    // appear within 150 chars of a CTC-related keyword to avoid grabbing stipend/PPO/unrelated figures.
    if (nums.length === 0) {
      const isFallbackFullText = !ctcBlockMatch || isReferBelow;
      const baseMatches = [...cleanCtc.matchAll(/(?:INR|₹|Rs\.?)?\s*(\d+(?:\.\d+)?)\s*(?:LPA|L\s*PA|Lakhs?|Lacs?|Lac|\bL\b|Per\s+Annum|\/\s*annum)\b/gi)];
      for (const m of baseMatches) {
        const v = parseFloat(m[1]);
        if (v < 3 || v >= 200) continue;

        if (isFallbackFullText) {
          // Proximity check: CTC keyword must appear within 150 chars before or after this match
          const matchIdx = m.index ?? 0;
          const window = cleanCtc.slice(Math.max(0, matchIdx - 150), matchIdx + (m[0].length) + 150);
          const hasCTCKeyword =
            /\bLPA\b/i.test(m[0]) ||
            /\b(?:CTC|Cost\s+to\s+Company|Salary|Package|Compensation|PPO\s+CTC|Gross\s+CTC|cohorts?|offerings?|remuneration|stipend|bonus)\b/i.test(window);
          if (!hasCTCKeyword) continue;
        }

        nums.push(v);
      }
    }

    // 5. Match raw rupee amounts like "11,50,000", "INR 6,25,000", or plain 6-8 digit numbers inside an explicit CTC section
    if (nums.length === 0) {
      const rupeeMatches = [
        ...cleanCtc.matchAll(/(?:(?:CTC|Package|Salary|Compensation|PPO)\s*[:\-–—\t]?\s*)?(?:INR|₹|Rs\.?)\s*([\d,]{6,12})(?:\s*(?:INR|₹|\/\-))?/gi),
        ...cleanCtc.matchAll(/(?:CTC|Package|Salary|Compensation|PPO)\s*[:\-–—\t]?\s*([\d,]{6,12})/gi),
        ...cleanCtc.matchAll(/\b(\d{1,3}(?:,\d{2,3})+)\b/g),
        ...(ctcBlockMatch ? cleanCtc.matchAll(/\b(\d{6,8})\b/g) : []),
      ];
      for (const m of rupeeMatches) {
        const val = parseInt(m[1].replace(/,/g, ''), 10);
        if (val >= 300000 && val <= 20000000 && ![2024, 2025, 2026, 2027, 2028, 2029].includes(val)) {
          const lpa = Math.round((val / 100000) * 100) / 100;
          nums.push(lpa);
        }
      }
    }

    if (nums.length > 0) {
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      if (min === max) {
        ctc = `${min.toString().replace(/\.0$/, '')} LPA`;
      } else {
        ctc = `${min.toString().replace(/\.0$/, '')} - ${max.toString().replace(/\.0$/, '')} LPA`;
      }
    }
  }

  // 2. Stipend Extraction — handles single amounts, ranges (e.g. "₹75,000 - ₹1,00,000/month"), and multi-role tiers
  const stipendBlockMatch = cleanText.match(/\b(?:Stipend|Stipened|Internship\s+Stipend)\b\s*[:\-–—\t]?\s*([\s\S]{1,400}?)(?:\b(?:CTC|Last date|Website|Location|Eligible|Eligibility|Selection|Process|Registration)\b|$)/i);
  if (stipendBlockMatch && unannouncedPattern.test(stipendBlockMatch[1])) {
    stipend = null;
  } else if (stipendBlockMatch) {
    const stipendText = stipendBlockMatch[1];

    // 2.1. Check for additive Base Stipend + Housing Stipend (e.g. Apple: Monthly Stipend 1,05,000 + Housing 35,100)
    const baseStipendMatch = cleanText.match(/(?:Monthly\s+Stipend|Base\s+Stipend)\s*[:\-–—\t]?\s*(?:INR|₹|Rs\.?)?\s*([\d,]+)/i);
    const housingMatch = cleanText.match(/(?:Monthly\s+Housing\s+Stipend|Housing\s+Stipend|Accommodation\s+Stipend|HRA)\s*[:\-–—\t]?\s*(?:INR|₹|Rs\.?)?\s*([\d,]+)/i);
    if (baseStipendMatch && housingMatch) {
      const baseVal = parseInt(baseStipendMatch[1].replace(/,/g, ''), 10);
      const housingVal = parseInt(housingMatch[1].replace(/,/g, ''), 10);
      if (baseVal >= 5000 && housingVal >= 5000) {
        stipend = `₹${(baseVal + housingVal).toLocaleString('en-IN')}/month`;
      }
    }

    // 2.2. Check for explicit addition formulas: e.g. "75,000 + 25,000"
    if (!stipend) {
      const addStipendMatch = stipendText.match(/(?:INR|₹|Rs\.?)?\s*([\d,]+)\s*\+\s*(?:INR|₹|Rs\.?)?\s*([\d,]+)/i);
      if (addStipendMatch) {
        const val1 = parseInt(addStipendMatch[1].replace(/,/g, ''), 10);
        const val2 = parseInt(addStipendMatch[2].replace(/,/g, ''), 10);
        if (val1 >= 5000 && val2 >= 1000) {
          stipend = `₹${(val1 + val2).toLocaleString('en-IN')}/month`;
        }
      }
    }

    // 2.3. Default single amount or range
    if (!stipend) {
      const stipendMatches = [...stipendText.matchAll(/(?:INR|₹|Rs\.?)?\s*([\d,]+(?:\.\d+)?)\s*(?:k|thousand|lacs?|lakhs?)?(?:\s*(?:\/\s*month|\/\s*mo|pm|p\.?m\.?|per\s+month))?/gi)];
      const nums: number[] = [];
      for (const m of stipendMatches) {
        const rawNum = m[1].replace(/,/g, '');
        let val = parseFloat(rawNum);
        if (/k\b/i.test(m[0]) && val < 500) {
          val = val * 1000;
        } else if (/(?:lacs?|lakhs?)\b/i.test(m[0]) && val < 50) {
          val = val * 100000;
        }
        if (val >= 5000 && val < 500000 && ![2024, 2025, 2026, 2027, 2028, 2029].includes(val)) {
          nums.push(val);
        }
      }
      if (nums.length > 0) {
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        if (min === max) {
          stipend = `₹${min.toLocaleString('en-IN')}/month`;
        } else {
          stipend = `₹${min.toLocaleString('en-IN')} - ₹${max.toLocaleString('en-IN')}/month`;
        }
      }
    }
  }

  // 3. Category & Job Role Extraction (Strictly Separate!)
  let category: string | null = null;
  const categoryMatch = cleanText.match(
    /\bCategory\b\s*[:\-–—\t]?\s*([A-Za-z0-9\s\/\-\,\&]+?)(?:\s+(?:Date|Visit|Eligible|Eligibility|CTC|Stipend|Selection|Website|Process|Last\s+date)|$|\.|\r?\n)/i
  );
  if (categoryMatch) {
    let rawCat = categoryMatch[1].replace(/^[*,\.\s>\-]+/, '').replace(/[*,\.\s>\-]+$/, '').trim();
    // Normalize e.g. "Super Dream Internship Registration - 2027 Batch" -> "Super Dream Internship"
    rawCat = rawCat.replace(/\s*(?:Registration|Drive|Batch|\d{4}).*$/i, '').trim();
    if (rawCat && rawCat.length >= 3 && !/will be|tba|tbd/i.test(rawCat)) {
      category = rawCat;
    }
  }

  // Also check subject/body for common tier keywords if category not explicitly in table
  if (!category) {
    if (/super\s+dream\s+internship/i.test(cleanText)) category = 'Super Dream Internship';
    else if (/super\s+dream\s+offer/i.test(cleanText)) category = 'Super Dream Offer';
    else if (/super\s+dream/i.test(cleanText)) category = 'Super Dream';
    else if (/dream\s+internship/i.test(cleanText)) category = 'Dream Internship';
    else if (/dream\s+offer/i.test(cleanText)) category = 'Dream Offer';
    else if (/\bdream\b/i.test(cleanText)) category = 'Dream';
    else if (/regular\s+offer/i.test(cleanText)) category = 'Regular';
  }

  // VIT Placement Rule (VIT Bhopal / Vellore CDC Policy):
  // Touching or above 10 LPA (or max of CTC range >= 10) -> Super Dream
  // Below 10 LPA -> Dream (>= 4.5) or Regular (< 4.5)
  if (!category && ctc) {
    const matches = [...ctc.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
    if (matches.length > 0) {
      const maxCtc = Math.max(...matches);
      const isIntern = stipend !== null || /internship|intern\b/i.test(cleanText);
      if (maxCtc >= 10) {
        category = isIntern ? 'Super Dream Internship' : 'Super Dream Offer';
      } else if (maxCtc >= 4.5) {
        category = isIntern ? 'Dream Internship' : 'Dream Offer';
      } else {
        category = 'Regular Offer';
      }
    }
  }

  // Role / Designation Extraction:
  // Uses clean text with preserved line breaks so newline-terminated titles extract cleanly
  const cleanWithLines = noHtml
    .replace(/[*_`>#]/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ');

  const explicitIstRole = cleanWithLines.match(/\bIS&T\s+((?:SDET|SRE)\s+Intern)\b/i);
  if (explicitIstRole) {
    role = `IS&T ${explicitIstRole[1].replace(/\s+/g, ' ').trim()}`;
  }

  // 1. Explicit headers: Designation, Job Role, Job Profile, Role, Position, Job Designation Offered, Title
  const roleMatch = cleanWithLines.match(
    /\b(?:Job\s+Designation\s+Offered|Designation\s+Offered|Designation|Job\s+Role|Job\s+Profile|Role|Position|Job\s+Title|Title)\b\s*[:\-–—\t]?\s*([^\r\n]{2,100}(?:\r?\n[ \t]*[A-Za-z0-9\/\,\& \t\-]{2,80})?)/i
  );

  if (roleMatch) {
    let raw = roleMatch[1].replace(/\r?\n[ \t]*/g, ' ').trim();
    // Strip sub-headers like "Service line - Position Title:"
    raw = raw.replace(/^(?:Service\s+line\s*[-–—]\s*)?Position\s+Title\s*[:\-–—\t]\s*/i, '');
    // Stop at trailing label boundaries like "JD", "Location", "Note", "Duration", etc.
    raw = raw.replace(/\s*(?:JD|Location|Eligible|Eligibility|Selection|CTC|Stipend|Process|Note|Registration|Date|Duration|As\s+part|We\s+would)\b.*$/i, '');
    // Strip parenthetical notes like "(JD Attached)"
    raw = raw.replace(/\s*\([^\)]*\)/g, '').replace(/[\(\[\{]/g, '');
    // Strip trailing prose suffixes like " position", " role", " profile", " job", " Work", " internship"
    raw = raw.replace(/\s+(?:position|role|profile|job|work|internship)\b/gi, '');
    raw = raw.replace(/^[*,\.\s>\-]+/, '').replace(/[*,\.\s>\-]+$/, '').trim().slice(0, 100);

    if (
      raw &&
      raw.length >= 2 &&
      !/\byou\b|\bwe\b|\bi\b|dear\s|greetings|hi\s+|hello\s|upcoming|forwarded|scheduled|not japanese|eligible|please|kindly|hereby|inform|congratulat|registr|passout|batch|drive|internship\s+registration|for the candidate|reserve a position|expect them|next\s+round|depends on the function|^[>,\.\*\s]+$/i.test(raw) &&
      !/^(?:super\s+dream|dream|regular)(?:\s+(?:internship|offer|placement))?$/i.test(raw)
    ) {
      role = raw;
    }
  }

  // 2. Also match PPO offer role formats like "Internship Upon PPO offer Sr. Analyst, Data Science"
  if (!role) {
    const ppoMatch = cleanWithLines.match(
      /(?:Internship\s+Upon\s+PPO\s+offer|Upon\s+PPO\s+offer)\s*[:\-–—\t]?\s*([^\r\n]{2,100})/i
    );
    if (ppoMatch) {
      let raw = ppoMatch[1].replace(/\s*(?:Job\s+location|Location|CTC|Stipend|All\s+the|Mandatory|Website)\b.*$/i, '').trim();
      raw = raw.replace(/^[*,\.\s>\-]+/, '').replace(/[*,\.\s>\-]+$/, '').trim().slice(0, 100);
      if (raw && raw.length >= 2) {
        role = raw;
      }
    }
  }

  // 3. Fallback: match standalone profile header lines (e.g. "Graduate Analyst– Insurance Consulting & Technology")
  if (!role) {
    const titleMatch = cleanWithLines.match(
      /(?:^|\n|\r)[ \t]*(?:[•*\-–—][ \t]*)?([A-Za-z0-9 \t–—\-&/]+?(?:Analyst|Engineer|Developer|Consultant|Scientist|Trainee|Specialist|Associate)(?:[ \t–—\-&/][A-Za-z0-9 \t–—\-&/]{0,50})?)(?:\r?\n|$)/i
    );
    if (titleMatch && titleMatch[1]) {
      const candidateRole = titleMatch[1]
        .replace(/^[*,\.\s>\-]+/, '')
        .replace(/[*,\.\s>\-]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (
        candidateRole.length >= 4 &&
        candidateRole.length <= 80 &&
        !/\byou\b|\bwe\b|\beligible\b|\bcongratulat\b|\bplacement\b|\bdrive\b|\binterview\b/i.test(candidateRole)
      ) {
        role = candidateRole;
      }
    }
  }

  // NOTE: Category and Role are strictly separate!
  // Category is the CDC placement bracket (e.g. "Super Dream Offer").
  // Role is the engineering profile (e.g. "Associate Software Engineer").
  // Never overwrite role with category.

  // 4. Job Location Extraction (extracts clean cities, states, and countries without internship/drive noise)
  // Must NOT match test venue phrases like "@ Own location You can write from LC 103"
  // Supports Office Location, Work Location, Job Location, Tentative Location, Place of Posting, with or without colons/markdown asterisks
  const locMatch = cleanText.match(
    /(?<!@\s*|own\s+)\b(?:Office|Work|Job|Posting|Hiring|Base|Tentative|Placement|Expected|Preferred|Internship)?\s*Locations?\b\s*[:\-–—\t|=]?\s*(?:will\s+be\s*[:\-–—]?|is\s*[:\-–—]?|is\s+at\s*[:\-–—]?)?\s*[*_~`\s]*([^\n\r<>{}_]{2,120})/i
  ) || cleanText.match(
    /\b(?:Place\s+of\s+(?:Posting|Work))\b\s*[:\-–—\t|]?\s*[*_~`\s]*([^\n\r<>{}_]{2,120})/i
  );

  if (locMatch) {
    let rawLoc = locMatch[1]
      .replace(/\s*(?:(?:\d+\.?\s*)?(?:Start\s+Date|Note|Eligibility|Criteria|Requirements?|Registration|CTC|Stipend|Internship\s+Duration|Joining\s+Date|Joining|Graduation\s+Year|Graduation|Batch|Timeline|Internship|Placement|Offer|Process|Website|Warm|Kind|Selection|Designation|Role|Job|JD|Position|Skills|Service|All\s+the|Work\s+Mode|Economy|On\s+Wed|For\s+more|PPO|About|Mandatory|depending\s+on|Fluent\s+English|Communication|You\s+can|Write\s+from|Forwarded|Queries|LC\s*\d|PRP|SJT|Anna|Lab|Hall|Venue|---)|[•*]).*$/i, '')
      .replace(/\s*\(?(?:work\s+from\s+office|wfo|in\s+person|on\s*site|remote|hybrid|in\s+office)\)?/gi, '')
      .replace(/\b(?:internship|placement|drive|hiring|offer|job|role|any\s+honeywell\s+site|only|based|preferred|fluent\s+english|communication)\b/gi, '')
      .replace(/^\s*(?:\(Core\):?|Core\):?)\s*/i, '')
      .replace(/[*_~`]+/g, '')
      .replace(/[\.\,\:\-\(\)\–—]+$/, '')
      .replace(/^[\.\,\:\-\(\)\–—]+/, '')
      .replace(/\bHyderabed\b/gi, 'Hyderabad')
      .replace(/\bbngalore\b/gi, 'Bangalore')
      .replace(/\s+\d+(?:\.\d+)*$/g, '')
      .replace(/\s+\d+\.?\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);

    // Fix unclosed parenthesis (e.g. "Hybrid (Gurgaon/Bangalore/Chennai" -> "Hybrid (Gurgaon/Bangalore/Chennai)")
    if (rawLoc.includes('(') && !rawLoc.includes(')')) {
      rawLoc = rawLoc + ')';
    }

    if (
      rawLoc &&
      rawLoc.length >= 2 &&
      !/\byou\b|\bwe\b|\bi\b|\bcan\b|\bwrite\b|\bwant\b|\bfrom\s+(?:lc|sjt|prp|lab|home|hostel)\b|\bqueries\b|---|forwarded|own\s+location|\b(?:lc|sjt|prp|tt|mb|cb|smv)\s*\d+\b|nonsense|come at|assistance|applicable|candidate|round\s+\d+|results|lab|service agreement|forwarded message|scheduled on|online test|interview|@|pearl research|anna auditorium|students with|clash|tba|tbd|^[>,\.\*\s]+|those in|for you is|services interested|economy class|round\s+trip|will be subject|where we work|entities in|\bpre$|placement\s+office|refer attachment/i.test(rawLoc) &&
      !/^(?:vit\s+(?:vellore|chennai|bhopal|ap)(?:\s+campus)?|(?:vellore|chennai|bhopal|ap)\s+campus)$/i.test(rawLoc.trim())
    ) {
      if (/remote/i.test(rawLoc)) location = 'Remote';
      else if (/pan\s+india/i.test(rawLoc)) location = 'Pan India';
      else location = rawLoc;
    }
  }

  // Fallback 1: Specific office mentions (e.g. "ION's Noida Office", "Noida Office")
  if (!location) {
    const officeMatch = cleanText.match(/\b([A-Z][a-zA-Z]+)\s+Office\b/i) || cleanText.match(/\bOffice\s+(?:in|at)\s+([A-Z][a-zA-Z]+)\b/i);
    if (officeMatch) {
      const city = officeMatch[1].trim();
      if (/^(Bangalore|Bengaluru|Hyderabad|Pune|Mumbai|Chennai|Gurgaon|Gurugram|Noida|Delhi|NCR|Kolkata|Ahmedabad)$/i.test(city)) {
        location = city;
      }
    }
  }

  // Fallback 2: Role with city in parentheses (e.g. "IS&T SDET Intern (Hyderabad)")
  if (!location) {
    const roleLocMatch = cleanText.match(/\b(?:SDET|SRE|Engineer|Developer|Intern|Analyst|Consultant|Manager)\s*(?:Intern)?\s*\(\s*([A-Za-z\s,\/]+)\s*\)/i);
    if (roleLocMatch) {
      const candidate = roleLocMatch[1].trim();
      if (/(?:Bangalore|Bengaluru|Hyderabad|Pune|Mumbai|Chennai|Gurgaon|Gurugram|Noida|Delhi|NCR|Kolkata|Ahmedabad|Pan\s*India|Remote)/i.test(candidate)) {
        location = candidate;
      }
    }
  }

  // Fallback 3: Pan-India posting phrase (e.g. Amazon: "placed in any location & entity pan India")
  if (!location && /placed\s+in\s+any\s+location.*pan\s+india|\bpan\s+india\b/i.test(cleanText)) {
    location = 'Pan India';
  }

  return {
    role,
    category,
    ctc,
    stipend,
    location,
    neoIdMatched: false,
    matchedNeoIdValue: null,
  };
}
