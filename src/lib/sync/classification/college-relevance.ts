import { isGatedCollegeSender } from '../canonical/canonical-email';

/**
 * Relevance gate for college senders (especially the placement office).
 *
 * Strict Placement Office Rule:
 * ONLY emails that are explicitly:
 *   1. Shortlists / selection rosters (student IDs or roster attachments)
 *   2. Test schedules (online test / assessment dates, slots & timings)
 *   3. Interview schedules (interview dates, slots & shortlisted candidate interviews)
 * are allowed into the database.
 *
 * All chatter, greetings ("God bless you"), policy circulars ("restricted offer 10 LPA+"),
 * meeting pings ("we will start now", meet links), and general hiring notices without
 * schedules or shortlists are REJECTED IMMEDIATELY at the ingest boundary and
 * MUST NEVER enter the database.
 */

/** Hard veto patterns that immediately disqualify any message from placement office / college. */
export const HARD_VETO_PATTERNS: RegExp[] = [
  /\bgod\s+bless(\s+you)?\b/i,
  /\b(inbox\s+)?restricted\s+offer\b/i,
  /\brestricted\s+offer\s+\d+\s*lpa/i,
  /^\s*(dear\s+)?(lions?|lionesses?|students?|all)\b.{0,60}\b(start|join|begin)/i,
  /\bwe\s+will\s+start\b/i,
  /\blet\s+us\s+start\b/i,
  /\bstart(ing)?\s+(now|in\s+\d+\s+min|shortly|ma)\b/i,
  /\bjoin\s+(if\s+you\s+can|now|soon)\b/i,
  /\bplease\s+join\b/i,
  /\bmeeting\s+(is\s+)?(live|starting)\b/i,
  /meet\.google\.com|zoom\.us\/j\/|teams\.microsoft\.com/i,
  /^(?:re|fwd?)\s*:\s*(?:god\s+bless|meeting|join)/i,
];

/** VIT student registration numbers, e.g. 23BCE11664 / 21BCE04923. */
const REG_NUMBER_PATTERN = /\b\d{2}[A-Z]{3}\d{4,5}\b/gi;

/** Positive shortlist indicators. */
const SHORTLIST_PATTERNS = [
  /\b(shortlist(ed)?|selected\s+candidates|selection\s+list|candidate\s+list|roster)\b/i,
  /\b(following\s+is\s+the\s+shortlist|shortlisted\s+students|below\s+shortlisted)\b/i,
];

/** Positive test schedule indicators. */
const TEST_SCHEDULE_PATTERNS = [
  /\b(online\s+test|assessment\s+schedule|test\s+schedule|exam\s+schedule|test\s+slot|assessment\s+slot|test\s+link|test\s+date|assessment\s+date|proctored\s+test|coding\s+assessment|coding\s+test|aptitude\s+test|hacker(?:rank|earth)|amcat|cocubes|mobiq|superset)\b/i,
];

/** Positive interview schedule indicators. */
const INTERVIEW_SCHEDULE_PATTERNS = [
  /\b(interviews?\s+schedule|technical\s+interview|hr\s+interview|interview\s+slot|interview\s+round|interview\s+link|interview\s+date|interview\s+time|shortlisted\s+for\s+interview|interview\s+call|f2f\s+interview|virtual\s+interview|interviews?\s+(?:are\s+in|in|at|venue|venues))\b/i,
  /\binterviews?\b.{0,30}\b(?:lc\s*\d{3}|ab\s*\d|audi|lab)\b/i,
];

const SCHEDULE_TIMING_PATTERN = /(?:\b(?:on|at|date|time|scheduled|slot|window|am|pm|venue|venues|lc\s*\d{3}|ab\s*\d|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))\b)/i;

/** Positive signals that a message is a drive circular. */
export interface RelevanceInput {
  subject?: string | null;
  body?: string | null;
  hasAttachments?: boolean;
  attachmentFilenames?: string[];
}

export interface CollegeRelevanceResult {
  /** True when the message should be ingested into the canonical archive. */
  isRelevant: boolean;
  score: number;
  reason: string;
  category?: 'shortlist' | 'test_schedule' | 'interview_schedule' | 'circular';
}

/**
 * Evaluates whether an email from `placementoffice@vitbhopal.ac.in` strictly satisfies
 * the requirement: ONLY shortlists, test schedules, and interview schedules.
 */
export function isPlacementOfficeMessageAllowed(input: RelevanceInput): {
  isAllowed: boolean;
  category?: 'shortlist' | 'test_schedule' | 'interview_schedule';
  reason: string;
} {
  const subject = (input.subject || '').trim();
  const body = (input.body || '').trim();
  const fullText = `${subject}\n${body}`;

  // 1. Immediate Hard Veto on Subjects: Standalone "God bless you" mails or "restricted offer" circulars
  if (/\bgod\s+bless(\s+you)?\b/i.test(subject)) {
    return { isAllowed: false, reason: 'hard veto matched: "God bless you" circular' };
  }
  if (/\b(inbox\s+)?restricted\s+offer\b/i.test(subject) || /\brestricted\s+offer\s+\d+\s*lpa/i.test(subject)) {
    return { isAllowed: false, reason: 'hard veto matched: restricted offer circular' };
  }

  // 2. Immediate Hard Veto: Meeting pings and chatter (we will start, let us start, join now)
  const meetingPings = [
    /^\s*(dear\s+)?(lions?|lionesses?|students?|all)\b.{0,60}\b(start|join|begin)/i,
    /\bwe\s+will\s+start\b/i,
    /\blet\s+us\s+start\b/i,
    /\bstart(ing)?\s+(now|in\s+\d+\s+min|shortly|ma)\b/i,
    /\bjoin\s+(if\s+you\s+can|now|soon)\b/i,
    /\bplease\s+join\b/i,
    /\bmeeting\s+(is\s+)?(live|starting)\b/i,
    /^(?:re|fwd?)\s*:\s*(?:meeting|join)/i,
  ];
  for (const pattern of meetingPings) {
    if (pattern.test(fullText)) {
      return { isAllowed: false, reason: `hard veto matched: meeting chatter (${pattern})` };
    }
  }

  // If the email is a bare "God bless you" email where body begins with blessings without company/schedule
  if (/^\s*(?:dear\s+students|dear\s+lions[^\n]*\n+)?\s*god\s+bless\s+you/i.test(body) && !SHORTLIST_PATTERNS.some((p) => p.test(fullText))) {
    return { isAllowed: false, reason: 'hard veto matched: "God bless you" greeting body' };
  }

  // 3. Category A: Shortlist / Selection List
  const regNumbers = body.match(REG_NUMBER_PATTERN) || [];
  const hasRegNumbers = regNumbers.length >= 2;
  const hasShortlistText = SHORTLIST_PATTERNS.some((p) => p.test(fullText));
  const attachmentNames = input.attachmentFilenames || [];
  const hasShortlistAttachment = attachmentNames.some((name) =>
    /\.(xlsx|xls|csv|pdf)$/i.test(name) && /(shortlist|selected|roster|results?|candidates?)/i.test(name)
  );
  const hasGoogleSheetRoster = /docs\.google\.com\/spreadsheets|drive\.google\.com\/(?:file|open)|sheets\.google\.com/i.test(body);

  const isReplyOrForward = /^(?:re|fwd?)\s*:/i.test(subject);

  if (hasRegNumbers || (hasShortlistAttachment && (!isReplyOrForward || hasShortlistText)) || (hasShortlistText && (regNumbers.length > 0 || input.hasAttachments || hasGoogleSheetRoster))) {
    return { isAllowed: true, category: 'shortlist', reason: 'shortlist roster / student IDs / spreadsheet detected' };
  }

  // 3b. Inline shortlist announcement — "Shortlist is as follows.\n\nInfosys"
  // The placement office sometimes pastes just the company name inline with no spreadsheet/IDs.
  // Require: explicit "shortlist is as follows" phrasing + an identifiable company name.
  const hasInlineShortlistAnnouncement =
    /shortlist\s+(?:is\s+as\s+follows|for\s+(?:next|the)\s+round|below|above|attached|released|published|out|confirmed)/i.test(fullText) ||
    /(?:following|below)\s+(?:is\s+)?(?:the\s+)?shortlist/i.test(fullText);
  const hasCompanyMention = COMPANY_HINT.test(fullText);
  if (hasShortlistText && hasInlineShortlistAnnouncement && hasCompanyMention) {
    return { isAllowed: true, category: 'shortlist', reason: 'inline shortlist announcement with company mention detected' };
  }

  // 4. Category B: Test Schedule
  const hasTestSchedule = TEST_SCHEDULE_PATTERNS.some((p) => p.test(fullText));
  const hasScheduleDetails = SCHEDULE_TIMING_PATTERN.test(fullText);
  if (hasTestSchedule && (hasScheduleDetails || hasGoogleSheetRoster)) {
    return { isAllowed: true, category: 'test_schedule', reason: 'online test / assessment schedule detected' };
  }

  // 5. Category C: Interview Schedule
  const hasInterviewSchedule = INTERVIEW_SCHEDULE_PATTERNS.some((p) => p.test(fullText));
  if (hasInterviewSchedule && (hasScheduleDetails || hasGoogleSheetRoster || hasRegNumbers)) {
    return { isAllowed: true, category: 'interview_schedule', reason: 'interview schedule / slot detected' };
  }

  // 6. Category D: Next-round / round-confirmation announcements.
  // e.g. "The next round will happen soon. Maybe on Saturday or Sunday."
  // e.g. "The next round is expected from 28th September onwards. Compulsory for all shortlisted students."
  // These don't use test/interview vocabulary but ARE placement-critical for shortlisted students.
  const hasNextRoundAnnouncement =
    /\b(?:next\s+round|upcoming\s+round|further\s+round|subsequent\s+round)\b/i.test(fullText) &&
    /\b(?:shortlisted|selected|cleared|qualified|compulsory\s+for\s+(?:all\s+)?shortlisted|all\s+shortlisted)\b/i.test(fullText);
  const hasRoundDateHint = SCHEDULE_TIMING_PATTERN.test(fullText) ||
    /\b(?:saturday|sunday|monday|tuesday|wednesday|thursday|friday|tomorrow|today|this\s+week|next\s+week|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|from\s+\d{1,2}(?:th|st|nd|rd)?\s+(?:sept?|oct|nov|dec|jan|feb|mar|apr|may|jun|jul|aug))/i.test(fullText);
  if (hasNextRoundAnnouncement && (hasRoundDateHint || hasCompanyMention)) {
    return { isAllowed: true, category: 'shortlist', reason: 'next-round confirmation for shortlisted students detected' };
  }

  return {
    isAllowed: false,
    reason: 'placement office email does not contain a shortlist, test schedule, or interview schedule',
  };
}

const DRIVE_KEYWORDS = [
  'registration', 'register', 'placement drive', 'recruitment', 'hiring',
  'shortlist', 'shortlisted', 'selected', 'selection', 'interview',
  'online test', 'assessment', 'eligibility', 'ctc', 'lpa', 'stipend',
  'job description', 'designation', 'pre-placement', 'ppt', 'drive number',
  'pat-pl-', 'neo pat', 'neopat', 'batch', 'passout', 'round',
];

const COMPANY_HINT = /(?:\b[A-Z][a-zA-Z0-9&]+\s){1,3}\b(?:Technologies|Technology|Solutions|Systems|Services|Labs|Consulting|Consultancy|Group|Industries|Motors|Bank|Capital|Analytics|Softwares?|Software|Digital|Healthcare|Logistics|Energy|Infotech|Infosec|Communications|Networks|Media|Entertainment|Retail|Realty|Financial)\b|\b(?:infosys|tcs|wipro|cognizant|accenture|capgemini|deloitte|ey\b|kpmg|ibm|amazon|microsoft|google|oracle|sap|adobe|goldman|jpmorgan|morgan stanley|delloitte|zoho|freshworks|mu sigma|musigma|quantiphi|fractal|ltimindtree|mindtree|virtusa|hexaware|mphasis|zensar|persistent|nagarro|publicis|sapient|epam|chegg|salesforce|servicenow|atlassian|uber|flipkart|paytm|phonepe|razorpay|cred|unacademy|swiggy|zomato|gullak)\b/i;

const FORWARDED_CHAIN_PATTERN = /-{5,}\s*Forwarded message\s*-{5,}/i;
const TRUSTED_RELAY_PATTERN = /vitlions2027@vitbhopal\.ac\.in|noreply\.cdcinfo@vitstudent\.ac\.in/i;

/**
 * Scores a message from a college sender.
 * When senderEmail is a gated sender (placementoffice@vitbhopal.ac.in), strictly enforces
 * that only shortlists, test schedules, and interview schedules are admitted.
 */
export function scoreCollegeMessageRelevance(
  input: RelevanceInput,
  senderEmail?: string | null
): CollegeRelevanceResult {
  const isOffice = senderEmail ? isGatedCollegeSender(senderEmail) : false;

  // Placement office mail: STRICT WHITELIST (only shortlists, test schedules, interview schedules)
  if (isOffice) {
    const check = isPlacementOfficeMessageAllowed(input);
    if (!check.isAllowed) {
      return { isRelevant: false, score: 0, reason: check.reason };
    }
    return { isRelevant: true, score: 5, reason: check.reason, category: check.category };
  }

  const subject = (input.subject || '').trim();
  const body = (input.body || '').trim();
  const fullText = `${subject}\n${body}`;

  // Hard chatter veto for all senders
  for (const pattern of HARD_VETO_PATTERNS) {
    if (pattern.test(fullText)) {
      return { isRelevant: false, score: 0, reason: `hard veto (${pattern})` };
    }
  }

  let score = 0;
  const reasons: string[] = [];

  // 1. Student registration numbers — shortlist signal
  const regNumbers = body.match(REG_NUMBER_PATTERN) || [];
  if (regNumbers.length >= 3) {
    score += 4;
    reasons.push(`${regNumbers.length} student IDs (shortlist/roster)`);
  } else if (regNumbers.length > 0) {
    score += 1;
    reasons.push('student ID mention');
  }

  // 2. Forwarded official circular chain — office relaying a vitlions/CDC blast
  if (FORWARDED_CHAIN_PATTERN.test(body) && TRUSTED_RELAY_PATTERN.test(body)) {
    score += 2;
    reasons.push('forwarded official circular');
  }

  // 3. Company mention
  if (COMPANY_HINT.test(subject)) {
    score += 3;
    reasons.push('company in subject');
  } else if (COMPANY_HINT.test(body)) {
    score += 2;
    reasons.push('company in body');
  }

  // 4. Drive vocabulary density
  const keywordHits = DRIVE_KEYWORDS.filter((kw) =>
    new RegExp(`\\b${kw.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`, 'i').test(fullText)
  );
  if (keywordHits.length >= 3) {
    score += 3;
    reasons.push(`${keywordHits.length} drive keywords`);
  } else if (keywordHits.length >= 1) {
    score += 1;
    reasons.push(`${keywordHits.length} drive keyword(s)`);
  }

  // 5. Structural formatting of real circulars
  if (/\bdrive\s+(name|number)\s*[:\-]/i.test(fullText)) {
    score += 2;
    reasons.push('drive name/number field');
  }
  if (/(?:last\s+date|deadline|closes?|register\s+on\s+or\s+before)\s*[:\-]?\s*\d/i.test(fullText)) {
    score += 1;
    reasons.push('registration deadline');
  }

  // 6. Attachments
  const attachmentNames = input.attachmentFilenames || [];
  if (input.hasAttachments || attachmentNames.length > 0) {
    const meaningful = attachmentNames.some((name) =>
      /\.(xlsx|xls|csv|pdf|docx?|pptx?)$/i.test(name || '')
    );
    if (meaningful) {
      score += 2;
      reasons.push('document attachment');
    } else {
      score += 1;
      reasons.push('attachment');
    }
  }

  // 7. Length floor
  if (body.length > 600) {
    score += 1;
    reasons.push('substantial body');
  }
  if (body.length < 60 && !subject) {
    return { isRelevant: false, score: 0, reason: 'empty message' };
  }

  const isRelevant = score >= 4;
  return { isRelevant, score, reason: reasons.join(', ') || 'no signals', category: 'circular' };
}

/** Convenience wrapper for the ingest path. */
export function isRelevantCollegeMessage(input: RelevanceInput, senderEmail?: string | null): boolean {
  return scoreCollegeMessageRelevance(input, senderEmail).isRelevant;
}
