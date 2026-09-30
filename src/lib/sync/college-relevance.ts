/**
 * Relevance gate for noisy college senders (placement office, etc.).
 *
 * The vitlions2027 batch group is ~99% placement content, so everything from it is
 * ingested unconditionally. The placement office inbox is the opposite: the
 * overwhelming majority of its mail is meeting-start pings ("we will start now",
 * "join if you can", Google Meet links) with a small fraction of actual drive
 * circulars (Infosys and Gulluk ran through the office directly).
 *
 * Strategy: score each message on structural + lexical signals. Only messages that
 * look like a company/drive communication pass. Chatter is dropped at the ingest
 * boundary — it never reaches college_emails, so it costs no canonical storage and
 * no fan-out work.
 */

/** Chatter patterns that almost never appear in a real circular. */
const CHATTER_PATTERNS: RegExp[] = [
  /^\s*(dear\s+)?(lions?|lionesses?|students?|all)\b.{0,60}\b(start|join|begin)/i,
  /\bwe\s+will\s+start\b/i,
  /\blet\s+us\s+start\b/i,
  /\bstart(ing)?\s+(now|in\s+\d+\s+min|shortly|ma)\b/i,
  /\bjoin\s+(if\s+you\s+can|now|soon)\b/i,
  /\bplease\s+join\b/i,
  /\bmeeting\s+(is\s+)?(live|starting)\b/i,
  /meet\.google\.com|zoom\.us\/j\/|teams\.microsoft\.com/i,
  /^(re|fwd)\s*:\s*(god bless|meeting|join)/i,
];

/** Positive signals that a message is a drive circular. */
interface RelevanceInput {
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
}

const DRIVE_KEYWORDS = [
  'registration', 'register', 'placement drive', 'recruitment', 'hiring',
  'shortlist', 'shortlisted', 'selected', 'selection', 'interview',
  'online test', 'assessment', 'eligibility', 'ctc', 'lpa', 'stipend',
  'job description', 'designation', 'pre-placement', 'ppt', 'drive number',
  'pat-pl-', 'neo pat', 'neopat', 'batch', 'passout', 'round',
];

const COMPANY_HINT = /(?:\b[A-Z][a-zA-Z0-9&]+\s){1,3}\b(?:Technologies|Technology|Solutions|Systems|Services|Labs|Consulting|Consultancy|Group|Industries|Motors|Bank|Capital|Analytics|Softwares?|Software|Digital|Healthcare|Logistics|Energy|Infotech|Infosec|Communications|Networks|Media|Entertainment|Retail|Realty|Financial)\b|\b(?:infosys|tcs|wipro|cognizant|accenture|capgemini|deloitte|ey\b|kpmg|ibm|amazon|microsoft|google|oracle|sap|adobe|goldman|jpmorgan|morgan stanley|delloitte|zoho|freshworks|mu sigma|musigma|quantiphi|fractal|ltimindtree|mindtree|virtusa|hexaware|mphasis|zensar|persistent|nagarro|publicis|sapient|epam|chegg|salesforce|servicenow|atlassian|uber|flipkart|paytm|phonepe|razorpay|cred|unacademy|swiggy|zomato|gullak)\b/i;

/** VIT student registration numbers, e.g. 23BCE11664 / 21BCE04923. */
const REG_NUMBER_PATTERN = /\b\d{2}[A-Z]{3}\d{4,5}\b/gi;

/**
 * Forwarded official circular chain: the placement office relaying a vitlions/
 * CDC broadcast ("---------- Forwarded message ---------" + trusted sender).
 */
const FORWARDED_CHAIN_PATTERN = /-{5,}\s*Forwarded message\s*-{5,}/i;
const TRUSTED_RELAY_PATTERN = /vitlions2027@vitbhopal\.ac\.in|noreply\.cdcinfo@vitstudent\.ac\.in/i;

/**
 * Scores a message from a gated college sender. Messages need a minimum signal
 * mass — a bare meet link or a "starting now" ping never accumulates enough.
 */
export function scoreCollegeMessageRelevance(input: RelevanceInput): CollegeRelevanceResult {
  const subject = (input.subject || '').trim();
  const body = (input.body || '').trim();
  const fullText = `${subject}\n${body}`;
  let score = 0;
  const reasons: string[] = [];

  // 1. Hard chatter veto: one meeting-ping signal is enough to drop, unless the
  //    message ALSO carries strong drive structure (attachments + company mention).
  const chatterHits = CHATTER_PATTERNS.filter((p) => p.test(fullText)).length;
  const shortBody = body.replace(/\s+/g, ' ').length < 240;
  if (chatterHits > 0 && shortBody) {
    return { isRelevant: false, score: 0, reason: `chatter (${chatterHits} ping pattern(s), body ${body.length} chars)` };
  }

  // 2. Student registration numbers — the decisive signal for office mail.
  // A pasted shortlist ("the following is the shortlist: Rakshit 23BCE11666...")
  // looks nothing like a formal circular but is exactly what the pipeline needs.
  const regNumbers = body.match(REG_NUMBER_PATTERN) || [];
  if (regNumbers.length >= 3) {
    score += 4;
    reasons.push(`${regNumbers.length} student IDs (shortlist/roster)`);
  } else if (regNumbers.length > 0) {
    score += 1;
    reasons.push('student ID mention');
  }

  // 2b. Forwarded official circular chain — office relaying a vitlions/CDC blast.
  if (FORWARDED_CHAIN_PATTERN.test(body) && TRUSTED_RELAY_PATTERN.test(body)) {
    score += 2;
    reasons.push('forwarded official circular');
  }

  // 3. Company mention — strong supporting signal for an office circular.
  if (COMPANY_HINT.test(subject)) {
    score += 3;
    reasons.push('company in subject');
  } else if (COMPANY_HINT.test(body)) {
    score += 2;
    reasons.push('company in body');
  }

  // 4. Drive vocabulary density (prefix match so plurals like "interviews",
  // "shortlisted" count too).
  const keywordHits = DRIVE_KEYWORDS.filter((kw) => new RegExp(`\\b${kw.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`, 'i').test(fullText));
  if (keywordHits.length >= 3) {
    score += 3;
    reasons.push(`${keywordHits.length} drive keywords`);
  } else if (keywordHits.length >= 1) {
    score += 1;
    reasons.push(`${keywordHits.length} drive keyword(s)`);
  }

  // 5. Structural formatting of real circulars.
  if (/\bdrive\s+(name|number)\s*[:\-]/i.test(fullText)) {
    score += 2;
    reasons.push('drive name/number field');
  }
  if (/(?:last\s+date|deadline|closes?|register\s+on\s+or\s+before)\s*[:\-]?\s*\d/i.test(fullText)) {
    score += 1;
    reasons.push('registration deadline');
  }

  // 6. Attachments (JDs / rosters travel as files).
  const attachmentNames = input.attachmentFilenames || [];
  if (input.hasAttachments || attachmentNames.length > 0) {
    const meaningful = attachmentNames.some((name) => /\.(xlsx|xls|csv|pdf|docx?|pptx?)$/i.test(name || ''));
    if (meaningful) {
      score += 2;
      reasons.push('document attachment');
    } else {
      score += 1;
      reasons.push('attachment');
    }
  }

  // 7. Length floor: real circulars carry substance; pings are one line.
  if (body.length > 600) {
    score += 1;
    reasons.push('substantial body');
  }
  if (body.length < 60 && !subject) {
    return { isRelevant: false, score: 0, reason: 'empty message' };
  }

  const isRelevant = score >= 4;
  return { isRelevant, score, reason: reasons.join(', ') || 'no signals' };
}

/** Convenience wrapper for the ingest path. */
export function isRelevantCollegeMessage(input: RelevanceInput): boolean {
  return scoreCollegeMessageRelevance(input).isRelevant;
}
