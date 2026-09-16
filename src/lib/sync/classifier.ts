import type { ParsedEmail } from '@/lib/gmail/client';
import { extractDriveNumber } from '@/lib/sync/events';

// ============================================
// Email Classification Types
// ============================================

export type EmailClassification =
  | 'registration'
  | 'registration_confirmation'
  | 'application_status'
  | 'withdrawal'
  | 'decline'
  | 'shortlist'
  | 'ppt'
  | 'test'
  | 'interview'
  | 'jd'
  | 'venue_update'
  | 'result'
  | 'general'
  | 'unclassified_placement_notice'
  | 'irrelevant'
  | 'unclassified';

export interface ClassificationResult {
  classification: EmailClassification;
  confidence: 'high' | 'medium' | 'low';
  companyName: string | null;
  reason: string;
}

// ============================================
// Classification Rules
// ============================================

interface ClassificationRule {
  classification: EmailClassification;
  confidence: 'high' | 'medium' | 'low';
  /** Returns true if the rule matches. Checked against lowercase subject + body snippet. */
  match: (subject: string, body: string, sender: string) => boolean;
  reason: string;
}

const CLASSIFICATION_RULES: ClassificationRule[] = [
  // --- NON-PLACEMENT / PROMOTIONAL SENDER FILTER ---
  {
    classification: 'irrelevant',
    confidence: 'high',
    match: (s, b, sender) =>
      /bookmyshow|pinterest|manutd|netflix|spotify|quora|chess\.com|myntra|plumgoodness|truecaller|dribbble|rockstargames|ifttt|openrouter|emergent\.sh|resumeworded|insideapple|mygate|newsgram\.hp|digital\.metamail|cron-job|vercel|onlinegdb/i.test(
        sender
      ) ||
      (/bookmyshow/i.test(s + ' ' + b) && !/placement|vitbhopal|cdc/i.test(sender)),
    reason: 'Non-placement marketing, entertainment, or personal newsletter sender',
  },
  {
    classification: 'irrelevant',
    confidence: 'high',
    match: (s) =>
      /\b(?:campus\s+connect\s+hackathon|hackathon|ideathon)\b/i.test(s) &&
      !/hiring\s+event|recruitment\s+drive/i.test(s),
    reason: 'Hackathon or competition announcement, not a placement drive',
  },
  {
    classification: 'general',
    confidence: 'high',
    match: (s) => /new learning contents?|practice.*tests?\s+added/i.test(s),
    reason: 'Generic LMS / NeoPAT practice course update (non-placement drive)',
  },

  // --- HIGH CONFIDENCE ---
  {
    classification: 'shortlist',
    confidence: 'high',
    match: (s, b) =>
      (/shortlist(ed)?/i.test(s) &&
        !/not\s+shortlist/i.test(s) &&
        !/un-?shortlist/i.test(s)) ||
      /(?:find\s+the\s+below\s+shortlist|below\s+is\s+the\s+shortlist|find\s+the\s+shortlist|shortlisted\s+candidates|shortlist\s+for\s+next\s+round)/i.test(b) ||
      /next\s+round\s+of\s+selection/i.test(s),
    reason: 'Email announces candidate shortlist or next round selection',
  },
  {
    classification: 'result',
    confidence: 'high',
    match: (s, b) =>
      /(result|selected|final\s*selection|offer\s*(letter|release))/i.test(s) &&
      !/not\s+selected/i.test(s),
    reason: 'Subject mentions results or selection',
  },
  {
    classification: 'result',
    confidence: 'high',
    match: (s, b) =>
      /not\s+selected|regret\s+to\s+inform|unfortunately|could\s+not\s+be\s+selected/i.test(s + ' ' + b),
    reason: 'Rejection language detected',
  },
  {
    classification: 'interview',
    confidence: 'high',
    match: (s, b) =>
      (/interview/i.test(s) &&
        (/(schedule|invite|call|round|panel|virtual|onsite)/i.test(s) ||
          /technical\s+interview|hr\s+interview|final\s+interview/i.test(s))) ||
      /selection\s+process\s+is\s+scheduled|next\s+round\s+of\s+selection\s+process/i.test(s),
    reason: 'Subject contains interview or selection process schedule',
  },
  {
    classification: 'test',
    confidence: 'high',
    match: (s) =>
      /(online\s+test|coding\s+test|online\s+assessment|aptitude\s+test|test\s+schedule|test\s+link|assessment\s+(?:test|link|scheduled|window)|thanks\s+for\s+taking\s+(?:the\s+)?assessment)/i.test(s),
    reason: 'Subject mentions online test or assessment',
  },
  {
    classification: 'ppt',
    confidence: 'high',
    match: (s) =>
      /pre[\s-]*placement\s*talk|ppt\b/i.test(s) &&
      !/ppt\s*file|\.ppt/i.test(s),
    reason: 'Subject mentions pre-placement talk (PPT)',
  },
  {
    classification: 'withdrawal',
    confidence: 'high',
    match: (s, b) => {
      const full = s + ' ' + b;
      if (
        /who\s+(?:wish|want)\s+to\s+opt|if\s+you\s+(?:wish|want)\s+to\s+opt|opt[\s-]*out\s+(?:form|link|google|portal)|voluntary\s+withdrawal\s+only|forms\.gle/i.test(
          full
        )
      ) {
        return false;
      }
      return (
        /registration.*has been withdrawn|drive.*has been withdrawn|status:\s*withdrawn/i.test(full) ||
        (/confirmation.*drive\s+registration\s+update/i.test(s) && /withdrawn/i.test(full)) ||
        /your\s+registration\s+for\s+the\s+following\s+placement\s+drive\s+has\s+been\s+withdrawn/i.test(full)
      );
    },
    reason: 'Email confirms registration withdrawal',
  },
  {
    classification: 'decline',
    confidence: 'high',
    match: (s, b) => {
      const full = s + ' ' + b;
      if (
        /who\s+(?:wish|want)\s+to\s+opt|if\s+you\s+(?:wish|want)\s+to\s+opt|opt[\s-]*out\s+(?:form|link|google|portal)|voluntary\s+withdrawal\s+only|forms\.gle/i.test(
          full
        )
      ) {
        return false;
      }
      return (
        /confirmation.*drive\s+registration\s+update.*withdrawn/i.test(full) ||
        /your\s+registration\s+for\s+the\s+following\s+placement\s+drive\s+has\s+been\s+withdrawn/i.test(full) ||
        /you\s+have\s+(?:successfully\s+)?(?:declined|opted\s*out)/i.test(full) ||
        /declined\s+(?:the\s+)?(?:placement\s+)?drive/i.test(full) ||
        /status:\s*(?:declined|opted\s*out|withdrawn)/i.test(full)
      );
    },
    reason: 'Email confirms decline or opt-out',
  },
  {
    classification: 'jd',
    confidence: 'high',
    match: (s) =>
      /(job\s*description|jd\s*(attached|enclosed|herewith|for)|jd\s*-\s*\w)/i.test(s),
    reason: 'Subject mentions job description',
  },
  {
    classification: 'venue_update',
    confidence: 'high',
    match: (s) =>
      /(venue\s*(change|update)|change\s*(of|in)\s*venue|revised\s*schedule|reschedule|date\s+change)/i.test(s),
    reason: 'Subject mentions venue change or reschedule',
  },

  // --- MEDIUM CONFIDENCE ---
  {
    classification: 'registration_confirmation',
    confidence: 'high',
    match: (s, b) =>
      /(successfully\s+registered|registration\s+confirmed|application\s+received|thank\s+you\s+for\s+(registering|applying)|confirmed:\s*(?:your\s+registration|.*placement\s+drive)|confirmation:\s*.*drive\s+registration)/i.test(s + ' ' + b),
    reason: 'Confirmation language detected',
  },
  {
    classification: 'registration',
    confidence: 'high',
    match: (s) =>
      /(?:eligible\s+for|eligibility\s+for|placement\s+drive|campus\s+drive|optional\s+form|drive\s+information|drive\s+registration|drive\s+update)/i.test(
        s
      ) &&
      !/course|assessment\s+course|mock\s+test|learning\s+contents|practice\s+assessment|nerd\s+season|codeathon/i.test(
        s
      ),
    reason: 'Subject announces placement drive eligibility, update, or registration',
  },
  {
    classification: 'registration',
    confidence: 'medium',
    match: (s) =>
      /(register|registration|apply\s+(now|here|for)|application\s+(open|link|form|deadline))/i.test(s),
    reason: 'Subject mentions registration or apply',
  },
  {
    classification: 'application_status',
    confidence: 'medium',
    match: (s) =>
      /application\s+status|status\s+update|update\s+on\s+your\s+application/i.test(s),
    reason: 'Subject mentions application status update',
  },
  {
    classification: 'test',
    confidence: 'medium',
    match: (s) =>
      /(hackerrank|hackerearth|codility|mettl|amcat|cocubes)/i.test(s),
    reason: 'Subject mentions a known test platform',
  },
  {
    classification: 'interview',
    confidence: 'medium',
    match: (s, b) =>
      /interview/i.test(s) && !/(schedule|invite|call)/i.test(s),
    reason: 'Subject mentions interview (no schedule keyword)',
  },

  // --- COHORT / PROGRAM ANNOUNCEMENTS (before general catchall) ---
  // Subjects like: "Capgemini Exceller 2027: Introducing Our Cohorts & Career Opportunities"
  //                "TCS NQT 2027: Registration Open" / "Infosys Springboard Hiring"
  // These are always placement-relevant registrations, never 'general' junk.
  {
    classification: 'registration',
    confidence: 'high',
    match: (s) =>
      /^[A-Za-z0-9\s&]+?\s+(?:exceller|nqt|springboard|ignite|codevita|hackwithinfy|genc|genplorer|launchpad|catalyst)\b/i.test(s) ||
      /(?:exceller|nqt|springboard|ignite|codevita|hackwithinfy|genc|genplorer|launchpad|catalyst)\s+\d{4}/i.test(s),
    reason: 'Known campus program/cohort name detected in subject (Capgemini Exceller, TCS NQT, Infosys Springboard, etc.)',
  },
  {
    classification: 'registration',
    confidence: 'medium',
    match: (s, b, sender) =>
      /vitlions2027|vitbhopal|vitstudent|cdc|placementoffice/i.test(sender) &&
      /(?:introducing\s+(?:our\s+)?cohorts|flagship\s+hiring|campus\s+hiring\s+season|apply\s+in\s+the\s+neo\s*pat|career\s+opportunities|cohort.*career|campus\s+recruitment)/i.test(b),
    reason: 'Trusted CDC sender + cohort/flagship program announcement in body',
  },

  // --- TRUSTED CDC UNCLASSIFIED NOTICES ---
  // Emails from official placement offices or student placement mailing lists that did not match
  // a specific round rule (e.g. general circulars, cohort announcements, student briefings).
  // These are NEVER discarded as irrelevant; they remain visible as placement notices.
  {
    classification: 'unclassified_placement_notice',
    confidence: 'medium',
    match: (_s, _b, sender) =>
      /vitlions2027|vitbhopal|vitstudent|cdc|placementoffice|noreply\.cdc/i.test(sender),
    reason: 'Email from trusted placement office/cell with general circular content',
  },

  // --- LOW CONFIDENCE CATCHALLS (Non-trusted senders) ---
  {
    classification: 'general',
    confidence: 'low',
    match: (s, _b, _sender) =>
      /(placement|campus|recruit|career|hiring|drive)/i.test(s),
    reason: 'General placement-related keywords from non-trusted sender',
  },
];

// ============================================
// Classify Email
// ============================================

/**
 * Classifies a parsed email into a placement category using deterministic rules.
 * Rules are evaluated in priority order — first match wins.
 */
export function classifyEmail(
  email: ParsedEmail,
  knownDriveResolutions?: Map<string, string>
): ClassificationResult {
  const subject = email.subject.toLowerCase();
  const body = (email.bodySnippet || email.bodyPlain || '').toLowerCase().slice(0, 1000);
  const sender = email.senderEmail.toLowerCase();

  for (const rule of CLASSIFICATION_RULES) {
    if (rule.match(subject, body, sender)) {
      return {
        classification: rule.classification,
        confidence: rule.confidence,
        companyName: extractCompanyName(
          email.subject,
          email.senderEmail,
          email.bodySnippet || email.bodyPlain,
          email.receivedAt,
          knownDriveResolutions
        ),
        reason: rule.reason,
      };
    }
  }

  const isTrustedSender =
    sender === 'noreply.cdcinfo@vitstudent.ac.in' ||
    sender === 'vitlions2027@vitbhopal.ac.in';
  return {
    classification: isTrustedSender ? 'unclassified_placement_notice' : 'unclassified',
    confidence: isTrustedSender ? 'medium' : 'low',
    companyName: extractCompanyName(
      email.subject,
      email.senderEmail,
      email.bodySnippet || email.bodyPlain,
      email.receivedAt
    ),
    reason: isTrustedSender
      ? 'Trusted placement sender with unclassified content'
      : 'No classification rule matched',
  };
}

// ============================================
// Company Name Extraction
// ============================================

/**
 * Common corporate legal entity suffixes.
 * Substantive business and brand words (e.g. "India", "Tech", "Technologies",
 * "Technology", "Solutions", "Services", "Systems", "Software", "Consulting", "Group")
 * are DELIBERATELY EXCLUDED so companies like "WorkIndia", "Tech Mahindra",
 * "Cognizant Technology Solutions", "Tata Consultancy Services" are never mutilated.
 */
const COMPANY_NOISE_WORDS = [
  'pvt', 'ltd', 'limited', 'private', 'inc', 'corp', 'corporation',
  'co', 'company', 'llc', 'llp',
];

/**
 * Legal corporate suffixes stripped during canonical key computation.
 * Distinctive brand words like 'india' (e.g. WorkIndia), 'tech' (Tech Mahindra),
 * 'solutions', 'technologies', 'services' are never stripped.
 */
export const KEY_NOISE_WORDS = new Set([
  'pvt', 'ltd', 'limited', 'private', 'inc', 'corp', 'corporation', 'llc', 'llp', 'co', 'company',
  'services', 'service', 'financial', 'technologies', 'technology', 'tech', 'solutions', 'solution',
  'consulting', 'consultancy', 'holdings', 'holding', 'group', 'enterprises', 'enterprise',
  'international', 'global', 'management', 'advisory', 'capital', 'systems', 'system', 'labs', 'lab', 'analytics',
]);

/**
 * Computes a canonical matching key for a company name.
 * Strips legal/noise words, removes all spaces and punctuation, lowercases.
 *
 * This makes the following equivalent:
 *   "Goldman Sachs"  → "goldmansachs"
 *   "Tresvista Financial Services" → "tresvista"
 *   "Tresvista"                    → "tresvista"  ← same key → same company
 *   "HCL Technologies" → "hcl"
 *   "HCL Tech"         → "hcl"          ← same key → same company
 *   "Exxon Mobil"    → "exxonmobil"
 *   "ExxonMobil"     → "exxonmobil"    ← same key → same company
 *   "Infosys BPM"    → "infosys"
 *   "Infosys"        → "infosys"       ← same key → same company
 */
export function computeNormalizedKey(name: string): string {
  if (!name) return '';
  // 1. Lowercase
  let str = name.toLowerCase();

  // Fix known typos
  str = str.replace(/\bunthikable\b/g, 'unthinkable');

  // 2. Remove punctuation (dashes, dots, ampersands, parens, etc.) — treat as spaces
  str = str.replace(/[^a-z0-9\s]/g, ' ');

  // 3. Split into words, drop noise words
  const words = str.split(/\s+/).filter((w) => w.length > 0 && !KEY_NOISE_WORDS.has(w));

  // 4. If all words were stripped (e.g. brand itself is a noise word), fallback to collapsed raw string
  if (words.length === 0) {
    return str.replace(/[^a-z0-9]/g, '');
  }

  // 5. Collapse — remove all remaining spaces so "goldman sachs" === "goldmansachs"
  return words.join('');
}

// Removed: COMPANY_ALIASES (was a static lookup table that required manual maintenance).
// De-duplication is now handled dynamically in upsertCompany via computeNormalizedKey.
export const COMPANY_ALIASES: Record<string, string> = {}; // kept as empty export to avoid breaking any stale imports


/**
 * Patterns commonly found in placement email subjects that help extract company names.
 * The company name is expected in the first capture group.
 */
const SUBJECT_COMPANY_PATTERNS: RegExp[] = [
  // NeoPAT Eligibility & Registration:
  // "Congratulations! You're Eligible for M/s.Value Labs Placement Drive"
  // "Confirmed: Your Registration for Sabre Placement Drive"
  /(?:congratulations\s*!{0,3}\s*(?:you'?re\s+)?eligible\s+for\s+|confirmed:\s*(?:your\s+registration\s+for\s+)?)(?:m\/s\.?\s*)?([A-Za-z0-9&\s\-\.]+?)\s*(?:\([^)]+\))?\s+placement\s+drive/i,
  // "Congratulations!! Zluri Super Dream Internship Selection List - 2027 Batch"
  // "Congratulations!! Flipkart Super Dream Internship Selection list 2027 Batch"
  // "Congratulations !! Valuelabs Super Dream Internship Selection list - 2027 Batch !!"
  /(?:congratulations\s*!{0,3}\s*)(?:for\s+)?([A-Za-z0-9&\s\-\.]+?)\s*(?:\([^)]+\))?\s+(?:super\s+dream|dream|regular|summer)?\s*(?:internship|placement|ppo|offer)?\s*(?:selection\s+list|shortlist)/i,
  // "Important: Date Change for Value Labs Placement Drive"
  // "Important: Date Change for Infosy 2027 batch Placement Drive"
  // "Important : Date change : Sandisk Device Design Centre Placement Drive"
  /(?:important|urgent)\s*:\s*date\s+change\s*(?:for|:)\s*(?:m\/s\.?\s*)?([A-Za-z0-9&\s\-\.]+?)(?:\s+(?:2026|2027|2028)\s+batch|\s+placement|\s+drive|$)/i,
  // "Updated Optional Form Available - Value Labs Drive"
  // "Optional Form Available - Epsilon Drive"
  /(?:updated\s+)?optional\s+form\s+(?:available\s*)?[-–—:]\s*(?:m\/s\.?\s*)?([A-Za-z0-9&\s\-\.]+?)\s+drive/i,
  // "Confirmation: Euler Motors Drive Registration Update"
  // "Euler Motors Drive Registration Update"
  // "Confirmation: Responsive (RFP Software) Drive Registration Update"
  /(?:confirmation:\s*)?((?:[A-Za-z0-9&\s\-\.]|\([^)]+\))+?)\s+drive\s+registration\s*(?:update|$)/i,
  // "Company Name - Drive Registration"
  /^([A-Za-z0-9&\s\-\.]+?)\s*[-–—]\s*drive\s+registration/i,
  // "Zluri Super Dream Internship Selection List..."
  /^([A-Za-z0-9&\s\-\.]+?)\s*(?:\([^)]+\))?\s+(?:super\s+dream|dream|regular)?\s*(?:internship|placement|ppo|offer)?\s*(?:selection\s+list|shortlist)/i,
  // "M/s.Value Labs Placement Drive"
  /(?:m\/s\.?\s*)([A-Za-z0-9&\s\-\.]+?)\s+placement\s+drive/i,
  // "Company Name Placement Drive" / "Company Name Campus Drive"
  /^([A-Za-z0-9&\s\-\.]+?)\s*(?:\([^)]+\))?\s+(?:placement\s+drive|campus\s+drive)\b/i,
  // "MUFG (Mitsubishi UFJ Financial Group) next round of selection process is scheduled on..."
  // "Euler Motors - Online test is scheduled on..."
  // "Amazon PPT & online test is scheduled on..."
  // "BluBridge Technologies Pvt. Ltd Physical selection process is scheduled on..."
  // "Wakefit next round of selection process is scheduled on..."
  // "Goldman sachs application registration link & test link"
  /^([A-Za-z0-9&\s\-\.]+?)\s*(?:\([^)]+\))?\s*[-–—]?\s*(?:online\s+test|assessment|coding\s+test|physical\s+selection|selection\s+process|next\s+round|ppt|interview|selection\s+list|application\s+registration|test\s+link|registration\s+link)/i,
  // "Thanks for taking the Assessment Goldman Sachs UG Summer Internship 2027 - Pooled STEM"
  /(?:thanks\s+for\s+taking\s+(?:the\s+)?assessment|assessment\s+completed)\s+([A-Za-z0-9&\s\-\.]+?)\s+(?:ug|summer|internship|placement|drive|pooled)/i,
  // "Company Name Super Dream Internship..." / "WTW Dream Offer..."
  /^([A-Za-z0-9&\s\-\.]+?)\s+(?:super\s+dream|dream|regular)\s+(?:internship|placement|offer|drive|hiring)/i,
  // "Report Immediately : MUFG PPT"
  /report\s+immediately\s*:\s*([A-Za-z0-9&\s\-\.]+?)\s+(?:ppt|test|drive)/i,
  // "Reminder : ProcDNA Analytics Pvt. Ltd's Next round..."
  /reminder\s*:\s*([A-Za-z0-9&\s\-\.]+?)(?:'s|\s+next\s+round|\s+selection)/i,
  // "Urgent : MUFG (Mitsubishi UFJ Financial Group) : Registration..."
  /^(?:urgent\s*:\s*)?(?:kind\s+(?:attention|attn\.?)|attention|attn\.?)\s*!{0,3}\s*([A-Za-z0-9&\s\-\.]+?)\s*(?:\([^)]+\))?\s*:\s*(?:registration|ppt|test|interview|shortlist|super\s+dream|dream|regular|placement|hiring|drive)/i,
  // "Urgent : Kind Attention!! MUFG Applied candidates!!"
  // "Kind Attn: Value labs applied students"
  /^(?:urgent\s*:\s*)?(?:kind\s+(?:attention|attn\.?)|attention|attn\.?)\s*!{0,3}\s*([A-Za-z0-9&\s\-\.]+?)\s*(?:\([^)]+\))?\s+(?:applied|shortlisted|registered|selected)\s+(?:candidates|students|list)/i,
  /^([A-Za-z0-9&\s\-\.]+?)\s*(?:\([^)]+\))?\s+(?:applied|shortlisted|registered|selected)\s+(?:candidates|students|list)/i,
  // "Fwd: MUFG (Mitsubishi UFJ Financial Group) Pre-placement talk..."
  /^(?:urgent\s*:\s*)?([A-Za-z0-9&\s\-\.]+?)\s*(?:\([^)]+\))?\s+(?:pre-placement|ppt|online\s+test|coding\s+test|interview|placement\s+drive|next\s+round)/i,
  // "Campus Placement | Company Name | Role"
  /(?:campus\s+)?placement\s*(?:\||[-–—]|:)\s*([A-Za-z0-9&\s\-\.]+?)(?:\s*(?:\||[-–—]|:)\s*.+)?$/i,
  // "Registration: Company Name"
  /(?:registration|register)\s*(?:\||[-–—]|:|\s+for)\s*([A-Za-z0-9&\s\-\.]+?)(?:\s*(?:\||[-–—])\s*.+)?$/i,
  // "Eligible for Company Name"
  /(?:eligible|eligibility)\s*(?:for|:)\s*(?:m\/s\.?\s*)?([A-Za-z0-9&\s\-\.]+?)(?:\s+placement|\s+drive|$)/i,
];

/**
 * Common prefixes in email subjects that obscure company names.
 */
const SUBJECT_PREFIXES = [
  /^(?:fwd|re|fw)\s*:\s*/i,
  /^(?:extended\s+deadline|extension\s+of\s+deadline|deadline\s+extended)\s*(?:[-:]\s*)?/i,
  /^(?:updated|update|revised|revision)\s*(?:regarding|on|for)?\s*(?:[-:]\s*)?/i,
  /^(?:urgent|immediately|immediate|important|critical)\s*(?:[-:]\s*)?/i,
  /^(?:kind\s+(?:attention|attn\.?)|attention|attn\.?)\s*!{0,3}\s*(?:[-:]\s*)?/i,
  /^confirmed\s*:\s*(?:your\s+registration\s+for\s+)?/i,
  /^confirmation\s*:\s*/i,
  /^congratulations\s*!{0,3}\s*(?:you'?re\s+)?(?:eligible\s+for\s+)?/i,
  /^(?:important|urgent|update|reminder)?\s*[-:]?\s*date\s+change\s+(?:for|:)\s*/i,
  /^(?:date\s+change|rescheduled|schedule\s+change|time\s+change|venue\s+change)\s*(?:for|:)\s*/i,
  /^(?:placement\s+drive\s+date\s+update|drive\s+date\s+update)\s*(?:[-:]\s*)?/i,
  /^updated\s+optional\s+form\s+available\s*(?:[-–—:]\s*)?/i,
  /^venue\s+update\s*:\s*/i,
  /^registration\s*(?:for)?\s*(?:[-:]\s*)?/i,
  /^reminder\s*:\s*/i,
  /^report\s+immediately\s*[-–—:]\s*/i,
  /^shortlist(?:ed)?\s+(?:candidates|students)?\s*(?:for|of)?\s*(?:[-:]\s*)?/i,
  /^selection\s+(?:list|process)\s+(?:for|of)?\s*(?:[-:]\s*)?/i,
  /^(?:corrigendum|addendum|rescheduled)\s*(?:[-:]\s*)?/i,
  /^(?:registration\s+extended|last\s+date\s+extended)\s*(?:[-:]\s*)?/i,
];

/**
 * Common suffixes to strip from company names.
 */
const SUBJECT_SUFFIXES = [
  /\s+(?:super\s+dream|dream|regular)\s+(?:internship|placement|drive|offer).*$/i,
  /\s+(?:super\s+dream|dream|regular)$/i,
  /\s+(?:placement\s+drive|campus\s+drive|internship\s+drive|drive).*$/i,
  /\s+\d+\s*[-]?\s*months?\b.*$/i,      // "6 months", "6-month"
  /\s+\d+\s*moths?\b.*$/i,              // "6moths"
  /\s+\d+\s*mo\b.*$/i,                  // "6mo", "6 mo"
  /\s+ect\b.*$/i,                       // "ECT" (Early Career Talent style suffixes)
  /\s+\d{4}\s*(?:batch)?.*$/i,          // trailing bare years like "2027", "2027 batch"
  /\s+(?:internship|intern|offer|placement)$/i,
  /\s+2027\s+batch.*$/i,
  /\s+2026\s+batch.*$/i,
  /\s+pre[\s-]*placement.*$/i,
  /\s+(?:applied|shortlisted|registered|selected)\s+(?:candidates|students).*$/i,
  /\s+(?:super\s+dream|dream|regular)?\s*(?:internship|placement|ppo|offer)?\s*(?:selection\s+list|shortlist).*$/i,
  /\s*[-–—:]\s*(?:urgent|immediate|important|critical|reminder|update)$/i,
];

/**
 * Words and role titles that are never company names.
 */
const NON_COMPANY_WORDS = [
  'via email', 'by email', 'via', 'email', 'emails', 'match', 'hr', 'github', 'linkedin', 'supabase', 'vitstudent',
  'accountprotection', 'mycareernet', 'takeuforward', 'codeforces',
  '10 new tools for', 'complete before 05', 'super dream internship',
  'portal', 'cdc portal', 'vit cdc portal', 'vit', 'your vit cdc portal',
  'soft skill assessments', 'soft skills', 'cdc info', 'placement office',
  'congratulations', 'invitation', 'registration update', 'optional form',
  'complete today', 'complete', 'practice test', 'practice assessment',
  'mock test', 'top coders', 'nerd season', 'codeathon', 'course',
  'learning contents', 'reminder', 'q2', 'q2 software', '2027 batch', '2026 batch', 'batch',
  'date change', 'date change for sabre', 'date change for squadstack', 'schedule change', 'venue change',
  // Role titles / profiles that are never company names
  'ps associate software engineer', 'associate software engineer', 'ps associate engineer',
  'associate engineer', 'software engineer', 'software development engineer',
  'data scientist', 'data analyst', 'business analyst', 'graduate engineer trainee',
  'graduate trainee', 'system engineer', 'technical consultant', 'consultant',
  'full stack developer', 'backend developer', 'frontend developer', 'intern', 'internship',
];

/**
 * Common English stopwords, determiners, pronouns, prepositions, and generic placement terms
 * that can NEVER be treated as company names or fuzzy match anchors.
 */
export const ENGLISH_STOPWORDS = new Set([
  // Articles & Determiners
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'each', 'every', 'all', 'any', 'some', 'no', 'none', 'both', 'either', 'neither', 'not', 'never',
  // Pronouns
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours', 'yourself', 'yourselves',
  'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
  // Prepositions & Conjunctions
  'about', 'above', 'across', 'after', 'against', 'along', 'among', 'around', 'at', 'before', 'behind', 'below', 'beneath',
  'beside', 'between', 'beyond', 'by', 'down', 'during', 'except', 'for', 'from', 'in', 'inside', 'into', 'near', 'of',
  'off', 'on', 'onto', 'out', 'outside', 'over', 'past', 'regarding', 'since', 'through', 'throughout', 'to', 'toward',
  'under', 'underneath', 'until', 'up', 'upon', 'with', 'within', 'without', 'and', 'but', 'or', 'nor', 'so', 'yet', 'if', 'via',
  // Auxiliary & Common Verbs
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'get', 'got', 'give', 'given', 'take', 'taken',
  // Common College & Placement Non-Company Entities
  'dear', 'student', 'students', 'candidate', 'candidates', 'batch', 'campus', 'college', 'university', 'department',
  'office', 'notice', 'circular', 'announcement', 'update', 'link', 'form', 'registration', 'placement', 'drive',
  'internship', 'process', 'selection', 'shortlist', 'shortlisted', 'eligible', 'eligibility', 'urgent', 'important',
  'reminder', 'invitation', 'congratulations', 'details', 'information', 'schedule', 'venue', 'timing', 'dates',
  'morning', 'afternoon', 'evening', 'today', 'tomorrow', 'yesterday', 'passout', 'prelims', 'portal', 'day', 'slots',
  'week', 'month', 'year', 'thanks', 'thank', 'regards', 'team', 'attend', 'attended', 'attending', 'report', 'reported',
  'test', 'tests', 'interview', 'interviews', 'assessment', 'assessments', 're', 'fwd', 'fw', 'email', 'emails',
]);

/**
 * Validates whether a candidate string is NOT a legitimate company name.
 * Centrally blocks stopwords, articles, numbers, and generic non-company phrases.
 */
export function isInvalidCompanyName(name: string): boolean {
  if (!name) return true;
  const clean = name.trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  if (clean.length < 2) return true;
  if (/^\d+$/.test(clean)) return true; // Purely numbers

  // Exact match in NON_COMPANY_WORDS
  if (NON_COMPANY_WORDS.includes(clean)) return true;

  // Single word is a stopword
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 1 && ENGLISH_STOPWORDS.has(words[0])) {
    return true;
  }

  // If every word in the phrase is a stopword or noise word, reject it
  // e.g. "Students Who Got The Link But Not In", "Batch 2 Of"
  const substantiveWords = words.filter(
    (w) => !ENGLISH_STOPWORDS.has(w) && !COMPANY_NOISE_WORDS.includes(w) && w.length >= 2
  );
  if (substantiveWords.length === 0) {
    return true;
  }

  return false;
}

/**
 * Known corporate initialisms and acronym mappings.
 */
export const KNOWN_ACRONYMS: Record<string, string[]> = {
  wtw: ['willis towers watson'],
  tcs: ['tata consultancy services'],
  jpmc: ['jpmorgan chase', 'jp morgan chase', 'jpmorgan'],
  pwc: ['pricewaterhousecoopers', 'price waterhouse coopers'],
  baml: ['bank of america merrill lynch', 'bank of america'],
  mufg: ['mitsubishi ufj financial group', 'mitsubishi ufj'],
  bny: ['bny mellon', 'bank of new york mellon'],
  lti: ['larsen & toubro infotech', 'l&t infotech'],
  cts: ['cognizant technology solutions', 'cognizant'],
};

/**
 * Checks whether shortStr is an acronym/initialism for longStr (or vice versa).
 * Handles both algorithmic initialism extraction and parenthetical aliases.
 */
export function checkAcronymMatch(shortStr: string, longStr: string): boolean {
  const candidate = shortStr.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (candidate.length < 2 || candidate.length > 6) return false;
  if (ENGLISH_STOPWORDS.has(candidate) || isInvalidCompanyName(candidate)) return false;

  const longLower = longStr.toLowerCase();

  // 1. Fast path: Known acronym dictionary
  if (KNOWN_ACRONYMS[candidate]) {
    for (const fullName of KNOWN_ACRONYMS[candidate]) {
      if (longLower.includes(fullName) || fullName.includes(longLower)) {
        return true;
      }
    }
  }

  // 2. Parenthetical check: e.g. "Willis Towers Watson (WTW India)" matching "WTW"
  const parenMatches = Array.from(longStr.matchAll(/\(([^)]+)\)/g)).map((m) => m[1].toLowerCase());
  for (const p of parenMatches) {
    const pClean = p.replace(/[^a-z0-9\s]/g, ' ');
    const pWords = pClean.split(/\s+/).filter(Boolean);
    if (pWords.includes(candidate)) return true;

    // Check initials of parenthetical phrase
    if (pWords.length >= 2) {
      const pInitials = pWords.map((w) => w[0]).join('');
      if (pInitials === candidate) return true;
    }
  }

  // 3. Algorithmic initials matching from substantive words in base company name
  // Must have at least 3 characters to prevent catastrophic 2-letter collisions (e.g. TA, AE, EM)
  // Two-letter acronyms (like EY, GS, HP) MUST be explicitly listed in KNOWN_ACRONYMS.
  if (candidate.length < 3) return false;

  // Strip parenthetical content first so "(WTW India)" doesn't pollute base words
  const baseStr = longLower.replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9\s]/g, ' ');
  const rawWords = baseStr.split(/\s+/).filter(Boolean);
  if (rawWords.length < 2) return false;

  const connectorWords = new Set(['of', 'and', 'for', 'in', 'the', 'at', 'on', 'to', 'a', 'an']);
  const meaningfulWords = rawWords.filter((w) => !connectorWords.has(w));
  if (meaningfulWords.length < 3) return false;

  // A. All meaningful words' initials (e.g. "Willis Towers Watson" -> "wtw", "Tata Consultancy Services" -> "tcs")
  const initialsAll = meaningfulWords.map((w) => w[0]).join('');
  if (initialsAll === candidate) return true;

  // B. Initials excluding corporate legal entity suffixes (e.g. "Tata Consultancy Services Pvt Ltd" -> "tcs")
  // Substantive words like 'india', 'tech', 'technology', 'solutions' are NEVER stripped
  const corporateLegalWords = new Set([
    'pvt', 'ltd', 'limited', 'private', 'inc', 'corp', 'corporation', 'llc', 'llp'
  ]);
  const withoutLegal = meaningfulWords.filter((w) => !corporateLegalWords.has(w));
  if (withoutLegal.length >= 3 && withoutLegal.length < meaningfulWords.length) {
    const initialsCore = withoutLegal.map((w) => w[0]).join('');
    if (initialsCore === candidate) return true;
  }

  return false;
}

/**
 * Extracts all relevant aliases for a company from its raw name and canonical name.
 * Captures parenthetical abbreviations, algorithmic acronyms, and known corporate nicknames.
 */
export function extractCompanyAliases(rawName: string, canonicalName: string, driveName?: string | null): string[] {
  const aliases = new Set<string>();

  const add = (str: string) => {
    if (!str) return;
    const clean = str.trim().toLowerCase();
    if (clean.length >= 2 && !isInvalidCompanyName(clean)) {
      aliases.add(clean);
    }
  };

  add(canonicalName);
  add(rawName);

  if (/^superjoin(?:\s+finance)?$/i.test(canonicalName.trim())) {
    add('super join');
    add('super join finance');
  }

  // Add collapsed alphanumeric form (e.g. "Value Labs" -> "valuelabs", "Squad Stack" -> "squadstack")
  const collapsed = canonicalName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (collapsed.length >= 3 && !ENGLISH_STOPWORDS.has(collapsed) && !isInvalidCompanyName(collapsed)) {
    add(collapsed);
  }

  // ROOT STEM EXTRACTION: Strip generic corporate suffixes to generate a shorter root alias.
  // e.g. "Unilever Industries" → also aliases "unilever", so college circulars that drop the
  // formal suffix still resolve to the same company record.
  // NOTE: Substantive brand words like "India", "Tech", "Solutions", "Services" are intentionally
  // NOT in this list — those are load-bearing brand words (WorkIndia, Tech Mahindra, etc.)
  const CORPORATE_SUFFIXES_REGEX = /\s+(?:financial\s+services|financial|industries|technologies|technology|services|service|solutions|solution|labs|lab|consulting|consultancy|holdings|holding|group|enterprises|enterprise|management|advisory|capital|systems|system|analytics|pvt|ltd|limited|inc|llc|global|international|india|private|corp|corporation)\b/gi;
  let currentStem = canonicalName;
  while (CORPORATE_SUFFIXES_REGEX.test(currentStem)) {
    currentStem = currentStem.replace(CORPORATE_SUFFIXES_REGEX, '').trim();
    if (
      currentStem.length >= 2 &&
      currentStem.toLowerCase() !== canonicalName.toLowerCase() &&
      !ENGLISH_STOPWORDS.has(currentStem.toLowerCase()) &&
      !isInvalidCompanyName(currentStem)
    ) {
      add(currentStem);
    }
  }

  // 1. Parenthetical extraction: e.g. "Willis Towers Watson (WTW India)" -> "wtw india", "wtw"
  // "Eternal (Zomato)" -> "zomato", "eternal", "eternal zomato", "zomato eternal"
  const parenMatches = Array.from(rawName.matchAll(/\(([^)]+)\)/g)).map((m) => m[1].trim());
  const outsideParen = rawName.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (outsideParen && outsideParen.toLowerCase() !== rawName.toLowerCase()) {
    add(outsideParen);
  }
  for (const p of parenMatches) {
    add(p);
    if (outsideParen && outsideParen.length >= 2) {
      add(`${outsideParen} ${p}`);
      add(`${p} ${outsideParen}`);
    }
    const pWords = p.split(/\s+/).filter(Boolean);
    for (const w of pWords) {
      if (w.length >= 2 && w.length <= 6 && !ENGLISH_STOPWORDS.has(w.toLowerCase())) {
        add(w);
      }
    }
    if (pWords.length >= 3) {
      const pInitials = pWords.map((w) => w[0]).join('').toLowerCase();
      if (pInitials.length >= 3 && !ENGLISH_STOPWORDS.has(pInitials)) {
        add(pInitials);
      }
    }
  }

  // 1.5 Drive Name tokens: e.g. "Zomato Eternal Drive Number: ..." -> "eternal", "zomato eternal"
  if (driveName) {
    const cleanDrive = driveName.replace(/\s+drive\s+(?:number|date):.*$/i, '').replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
    if (cleanDrive && cleanDrive.length >= 2) {
      add(cleanDrive);
      const driveWords = cleanDrive.split(/\s+/).filter(Boolean);
      for (const dw of driveWords) {
        if (dw.length >= 3 && !ENGLISH_STOPWORDS.has(dw.toLowerCase()) && !isInvalidCompanyName(dw)) {
          add(dw);
        }
      }
    }
  }

  // 2. Multi-word acronym generation: e.g. "Willis Towers Watson" -> "wtw" (must be >= 3 chars)
  const base = canonicalName.replace(/\([^)]*\)/g, ' ').replace(/[^a-zA-Z0-9\s]/g, ' ');
  const words = base.split(/\s+/).filter(Boolean);
  if (words.length >= 3) {
    const connectors = new Set(['of', 'and', 'for', 'in', 'the', 'at', 'on', 'to']);
    const meaningful = words.filter((w) => !connectors.has(w.toLowerCase()));
    if (meaningful.length >= 3 && meaningful.length <= 6) {
      const acronym = meaningful.map((w) => w[0]).join('').toLowerCase();
      if (acronym.length >= 3 && !ENGLISH_STOPWORDS.has(acronym)) {
        add(acronym);
      }
    }

    const corporateLegalWords = new Set(['pvt', 'ltd', 'limited', 'private', 'inc', 'corp', 'corporation', 'llc', 'llp']);
    const withoutLegal = meaningful.filter((w) => !corporateLegalWords.has(w.toLowerCase()));
    if (withoutLegal.length >= 3 && withoutLegal.length < meaningful.length) {
      const acronymCore = withoutLegal.map((w) => w[0]).join('').toLowerCase();
      if (acronymCore.length >= 3 && !ENGLISH_STOPWORDS.has(acronymCore)) {
        add(acronymCore);
      }
    }
  }

  // 3. Known acronym map additions
  const cLower = canonicalName.toLowerCase();
  for (const [acro, fullNames] of Object.entries(KNOWN_ACRONYMS)) {
    if (cLower === acro || fullNames.some((f) => cLower.includes(f) || f.includes(cLower))) {
      add(acro);
      fullNames.forEach((f) => add(f));
    }
  }

  return Array.from(aliases);
}

/**
 * Extracts and normalizes a company name from the email subject.
 */
export function extractCompanyName(
  subject: string,
  _senderEmail: string,
  bodySnippet?: string,
  receivedAt?: Date | string,
  knownDriveResolutions?: Map<string, string>
): string | null {
  const fullEmailText = `${subject}\n${bodySnippet || ''}`;
  const driveNumber = extractDriveNumber(fullEmailText);

  // If this email carries a drive_number that has already been resolved by timing correlation, use it
  if (driveNumber && knownDriveResolutions?.has(driveNumber)) {
    return knownDriveResolutions.get(driveNumber)!;
  }

  // 0. Immediately reject non-placement / marketing / personal senders
  if (
    /bookmyshow|pinterest|manutd|netflix|spotify|quora|chess\.com|myntra|plumgoodness|truecaller|dribbble|rockstargames|ifttt|openrouter|emergent\.sh|resumeworded|insideapple|mygate|newsgram\.hp|digital\.metamail|cron-job|vercel|onlinegdb/i.test(
      _senderEmail || ''
    ) ||
    (/bookmyshow/i.test(subject + ' ' + (bodySnippet || '')) && !/placement|vitbhopal|cdc/i.test(_senderEmail || ''))
  ) {
    return null;
  }

  // 1. Ignore generic coursework, practice tests, mock tests, codeathons, portal invites
  if (
    /you\s+are\s+invited|invited\s+to\s+join|assessment\s+portal|mock\s+test|practice\s+(?:test|assessment)|codeathon|nerd\s+season|learning\s+contents|you\s+have\s+been\s+enrolled|complete\s+today/i.test(
      subject
    ) &&
    !/placement\s+drive|super\s+dream|dream\s+core|regular\s+internship/i.test(subject)
  ) {
    return null;
  }

  // 1.5. Direct High-Precision Extraction from standard College Placement Circular body:
  // e.g. "Super Dream Internship - 2027 Batch Name of the Company Kinaxis Category Super Dream Internship"
  // e.g. "Placement Drive Date Update ... Drive Name: Sabre Drive Number: pat-PL-2026-1108"
  if (bodySnippet) {
    const candidates: Array<{ raw: string; cleaned: string; normalized: string; score: number }> = [];

    const addCandidate = (raw: string | undefined, sourceWeight: number) => {
      if (!raw) return;

      // Pre-strip duration/batch/year noise on raw candidate string before scoring
      const preCleaned = raw
        .replace(/\s+\d+\s*[-]?\s*months?\b.*$/i, '')
        .replace(/\s+\d+\s*moths?\b.*$/i, '')
        .replace(/\s+\d+\s*mo\b.*$/i, '')
        .replace(/\s+ect\b.*$/i, '')
        .replace(/\s+\d{4}\s*(?:batch)?.*$/i, '');

      const cleaned = cleanCompanyName(preCleaned);
      if (!cleaned || isInvalidCompanyName(cleaned)) {
        return;
      }

      let candidateClean = cleaned;
      if (/^honeywell$/i.test(cleaned)) {
        if (/aerospace/i.test(bodySnippet)) candidateClean = 'Honeywell Aerospace';
        else if (/technology\s+solutions/i.test(bodySnippet)) candidateClean = 'Honeywell Technology Solutions Lab';
      }

      const normalized = normalizeCompanyName(candidateClean);
      const lowerNorm = normalized.toLowerCase();
      const lowerClean = candidateClean.toLowerCase();

      if (isInvalidCompanyName(normalized) || ['super', 'dream', 'internship', 'placement', 'drive', 'finance'].includes(lowerNorm)) {
        return;
      }

      let score = sourceWeight;

      // 1. Track / specialization tokens get a scoring boost (+100)
      // e.g. "ey sap" or "ey gds" beats bare "ey" because it has a track token
      if (/\b(?:sdet|sre|sap|gds|aerospace|technology\s+solutions)\b/i.test(lowerClean)) {
        score += 100;
      }

      // 2. Track / specialization tokens (+50)
      if (/\b(?:sdet|sre|sap|gds|aerospace|technology\s+solutions|analytics|bpm)\b/i.test(lowerNorm)) {
        score += 50;
      }

      // Penalize generic single-word abbreviations that have known specializations
      if (['ey'].includes(lowerNorm)) {
        score -= 20;
      }

      candidates.push({ raw, cleaned: candidateClean, normalized, score });
    };

    // 1. Company: <Name> / Name of the Company: <Name>
    const companyStopWords =
      'drive\\s+name|drive\\s+number|new\\s+drive\\s+date|category|date\\s+of\\s+visit|eligibility|eligible|ctc|role|stipend|log\\s+in|next\\s+steps|keep\\s+monitoring|save\\s+this|if\\b|please\\b|stay\\b|this\\b|kindly\\b|note\\b|we\\b|you\\b|dear\\b|all\\s+the\\s+best|best\\s+regards';
    const companyMatch = bodySnippet.match(
      new RegExp(
        `(?:^|\\s|\\n|\\r)(?:name\\s+of\\s+the\\s+company\\s*[:\\-–—*]*|company\\s+name\\s*[:\\-–—*]*|company\\s*[:\\-–—]+)\\s*([A-Za-z0-9&/(). -]+?)(?=[.\\n\\r;]|\\s+(?:${companyStopWords})|\\*|$)`,
        'i'
      )
    );
    let hasHighConfidenceCompany = false;
    if (companyMatch && companyMatch[1]) {
      addCandidate(companyMatch[1], 50);
      hasHighConfidenceCompany = candidates.some((c) => c.score >= 50);
    }

    // 2. Drive Name: <Name> (Specific drive identity like "EY GDS", "EY SAP", "Apple SDET")
    const driveNameMatch = bodySnippet.match(
      /(?:drive\s+name|name\s+of\s+the\s+drive)\s*[:\-*]*\s*([A-Za-z0-9&\s\-\.()]+?)(?:\s+(?:drive\s+number|new\s+drive\s+date|category|date\s+of\s+visit|eligibility|eligible|ctc|role|stipend|company|\n|\r|\*|$))/i
    );
    if (driveNameMatch && driveNameMatch[1]) {
      // Strip trailing academic level tags (e.g. "Pallav tech ug" -> "Pallav tech")
      const cleanDriveRaw = driveNameMatch[1].replace(/\s+(?:ug|pg|b\.?tech|m\.?tech|mca|mba)\b.*$/i, '');
      addCandidate(cleanDriveRaw, 70);
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      // If candidate is high-confidence (e.g. from explicit Company: field), return it
      if (candidates[0].score >= 25) {
        return candidates[0].normalized;
      }
      // If only low-confidence drive name was found (score < 25), verify if subject has a clean company pattern
      for (const pattern of SUBJECT_COMPANY_PATTERNS) {
        const subMatch = subject.match(pattern);
        if (subMatch && subMatch[1]) {
          const sc = cleanCompanyName(subMatch[1]);
          if (sc && !isInvalidCompanyName(sc)) {
            return normalizeCompanyName(sc);
          }
        }
      }
      return candidates[0].normalized;
    }

    // 4. Greeting / Body opening pattern: "Greetings from <Company>!"
    // Used by Capgemini, Infosys and other direct company circulars forwarded via CDC
    const greetingMatch = bodySnippet.match(
      /greetings\s+from\s+(?:the\s+)?([A-Za-z0-9&\s\-\.]+?)\s*[!,\.\n]/i
    );
    if (greetingMatch && greetingMatch[1]) {
      const gc = cleanCompanyName(greetingMatch[1]);
      if (gc && !isInvalidCompanyName(gc)) {
        return normalizeCompanyName(gc);
      }
    }

    // 5. "details about <Company [Program]>" — e.g. "share more details about Capgemini Exceller"
    const detailsMatch = bodySnippet.match(
      /(?:details|information)\s+about\s+(?:the\s+)?([A-Z][A-Za-z0-9&]+(?:\s+[A-Za-z]+)?)/
    );
    if (detailsMatch && detailsMatch[1]) {
      const dc = cleanCompanyName(detailsMatch[1]);
      if (dc && !isInvalidCompanyName(dc)) {
        return normalizeCompanyName(dc);
      }
    }
  }

  // Clean the subject to remove prefixes like "Confirmed: Your Registration for"
  const cleanedSubject = cleanSubjectNoise(subject);
  const lowerCleaned = cleanedSubject.toLowerCase();
  const lowerBody = (bodySnippet || '').toLowerCase();

  // Check subject for program-name patterns:
  // "Capgemini Exceller 2027: Introducing...", "TCS NQT 2027...", "Infosys Springboard..."
  const programSubjectMatch = cleanedSubject.match(
    /^([A-Za-z0-9&\s\-\.]+?)\s+(?:exceller|nqt|springboard|ignite|codevita|hackwithinfy|genc|genplorer|launchpad|catalyst)\b/i
  );
  if (programSubjectMatch && programSubjectMatch[1]) {
    const pc = cleanCompanyName(programSubjectMatch[1]);
    if (pc && !isInvalidCompanyName(pc)) {
      return normalizeCompanyName(pc);
    }
  }

  // Disambiguate EY SAP vs EY GDS
  // Only trigger on subject mention — body-only mentions are too broad and cause false positives
  const isEyEmail =
    /\b(?:ey|ernst\s*&\s*young|ernst\s+and\s+young)\b/i.test(lowerCleaned) ||
    /\b(?:ey\s+sap|ey\s+gds|ey\s*\(ernst\s*&\s*young\))\b/i.test(lowerCleaned);

  if (isEyEmail) {
    if (
      lowerCleaned.includes('sap') ||
      lowerBody.includes('ey sap') ||
      lowerBody.includes('pat-pl-2026-1191')
    ) {
      return 'EY SAP';
    }
    if (
      lowerCleaned.includes('gds') ||
      lowerBody.includes('ey gds') ||
      lowerBody.includes('global delivery') ||
      lowerBody.includes('pat-pl-2026-1210')
    ) {
      return 'EY GDS';
    }
    return 'EY';
  }

  // Disambiguate Honeywell Aerospace vs Honeywell Technology Solutions Lab
  // Note: "Honeywell Technologies Campus Connect Hackathon" is a hackathon, not a placement drive.
  // ONLY trigger when the subject itself mentions "honeywell" — body-only mentions are passing
  // references in forwarded threads (e.g. a WorkIndia email saying "exempt from Honeywell")
  // and must NOT hijack the email's company assignment.
  if (lowerCleaned.includes('honeywell')) {
    if (/\b(?:hackathon|ideathon)\b/i.test(lowerCleaned)) {
      return null;
    }
    if (lowerCleaned.includes('aerospace') || lowerBody.includes('aerospace')) {
      return 'Honeywell Aerospace';
    }
    // All other legitimate campus recruitment drives (Technology Solutions Lab, Dream/Super Dream Internship)
    // belong to Honeywell Technology Solutions Lab
    return 'Honeywell Technology Solutions Lab';
  }

  // Disambiguate Apple SDET vs Apple SRE
  // Must be an actual placement email about Apple (not just an app store link or marketing newsletter)
  const isApplePlacementSubject = /\bapple\b/i.test(lowerCleaned) && !/insideapple|apple\s+store|app\s+store/i.test(lowerCleaned);
  const isApplePlacementBody =
    /\bapple\b/i.test(lowerBody) &&
    /\b(?:super\s+dream|placement|internship|hiring|shortlist|sdet|sre|cdc|vitbhopal|neopat|coderpad)\b/i.test(lowerBody) &&
    !/bookmyshow|pinterest|insideapple|apple\s+store|app\s+store/i.test(_senderEmail || '');

  if (isApplePlacementSubject || isApplePlacementBody) {
    if (lowerCleaned.includes('sdet') || lowerBody.includes('sdet') || lowerBody.includes('lc102') || lowerBody.includes('lc 102')) {
      return 'Apple SDET';
    }
    if (
      lowerCleaned.includes('sre') ||
      lowerBody.includes('sre') ||
      lowerBody.includes('site reliability') ||
      lowerBody.includes('reliability') ||
      lowerCleaned.includes('new role') ||
      lowerBody.includes('new role') ||
      lowerBody.includes('lc101') ||
      lowerBody.includes('lc 101')
    ) {
      return 'Apple SRE';
    }
    // If drive resolution was resolved via timing correlation, use it
    if (driveNumber && knownDriveResolutions?.has(driveNumber)) {
      return knownDriveResolutions.get(driveNumber)!;
    }
    // Generic fallback: timing correlation engine will resolve the drive_number
    return 'Apple';
  }

  // Disambiguate Zluri SWE vs Zluri SDET
  // Only trigger on subject mention — same rationale as Honeywell block above
  if (lowerCleaned.includes('zluri')) {
    if (lowerCleaned.includes('sdet') || lowerBody.includes('sdet')) {
      return 'Zluri SDET';
    }
    return 'Zluri';
  }

  // (Static alias table removed — dedup is handled dynamically in upsertCompany via computeNormalizedKey)

  // Try regex subject patterns
  for (const pattern of SUBJECT_COMPANY_PATTERNS) {
    const match = cleanedSubject.match(pattern);
    if (match && match[1]) {
      const cleaned = cleanCompanyName(match[1]);
      if (
        cleaned &&
        !isInvalidCompanyName(cleaned) &&
        !/^(?:portal|webinar|survey|assessment|feedback|cdc|vit|profile|course|day\s+\d+|session|prelims|passout\s+batch|complete|reminder)/i.test(
          cleaned
        ) &&
        !/^(?:ps\s+)?(?:associate\s+)?(?:software\s+)?(?:engineer|developer|analyst|scientist|trainee|consultant|specialist)$/i.test(
          cleaned
        ) &&
        !/(?:software\s+engineer|associate\s+engineer|data\s+scientist|data\s+analyst|graduate\s+trainee)/i.test(
          cleaned
        )
      ) {
        return normalizeCompanyName(cleaned);
      }
    }
  }

  // If no pattern matched, but the cleaned subject is short (1-4 words) and looks like a company name
  if (cleanedSubject && cleanedSubject.split(/\s+/).length <= 4) {
    const cleaned = cleanCompanyName(cleanedSubject);
    if (
      cleaned &&
      !isInvalidCompanyName(cleaned) &&
      !/^(?:portal|webinar|survey|assessment|feedback|cdc|vit|profile|course|day\s+\d+|session|prelims|passout\s+batch|complete|reminder|shortlist)/i.test(cleaned) &&
      !/^(?:ps\s+)?(?:associate\s+)?(?:software\s+)?(?:engineer|developer|analyst|scientist|trainee|consultant|specialist)$/i.test(cleaned) &&
      !/(?:software\s+engineer|associate\s+engineer|data\s+scientist|data\s+analyst|graduate\s+trainee)/i.test(cleaned)
    ) {
      return normalizeCompanyName(cleaned);
    }
  }

  return null;
}

/**
 * Strips noise prefixes from subject line.
 */
function cleanSubjectNoise(subject: string): string {
  let str = subject.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of SUBJECT_PREFIXES) {
      if (p.test(str)) {
        str = str.replace(p, '').trim();
        changed = true;
      }
    }
    // Also strip standalone leading punctuation and "urgent -" noise
    const leadingNoise = /^[-–—:\s]*(?:urgent|important|reminder|updated|extended\s+deadline)?[-–—:\s]*/i;
    const cleaned = str.replace(leadingNoise, '').trim();
    if (cleaned.length > 0 && cleaned !== str) {
      str = cleaned;
      changed = true;
    }
  }
  return str;
}

/**
 * Cleans a raw company name by removing noise words, prefixes, and suffixes.
 */
export function cleanCompanyName(name: string): string {
  let str = cleanSubjectNoise(name);

  // Fix known CDC typos / misspellings in company names
  str = str.replace(/\bunthikable\b/gi, 'Unthinkable');

  // Strip leading date change / update noise if any slipped through
  str = str.replace(/^(?:date\s+change\s+(?:for|:)?|rescheduled\s+(?:for|:)?)/i, '').trim();

  // Strip duration/batch/year noise before general suffixes
  str = str.replace(/\s+\d+\s*[-]?\s*months?\b.*$/i, '');
  str = str.replace(/\s+\d+\s*moths?\b.*$/i, '');
  str = str.replace(/\s+\d+\s*mo\b.*$/i, '');
  str = str.replace(/\s+ect\b.*$/i, '');
  str = str.replace(/\s+\d{4}\s*(?:batch)?.*$/i, '');

  // Strip trailing suffixes
  for (const s of SUBJECT_SUFFIXES) {
    str = str.replace(s, '').trim();
  }

  // Strip trailing academic level / batch tags: "UG", "PG", "B.Tech", etc.
  str = str.replace(/\s+(?:ug|pg|b\.?tech|m\.?tech|mca|mba)\b.*$/i, '').trim();

  // 1. Check for trading brand names in parentheses: e.g. "RFPIO India Pvt Ltd (DBA Responsive)" -> "Responsive"
  const dbaMatch = str.match(/\((?:dba|d\/b\/a|doing\s+business\s+as|aka|a\.k\.a\.|now)\s+([A-Za-z0-9&\s\-\.]+?)\)/i);
  if (dbaMatch && dbaMatch[1]) {
    const brand = dbaMatch[1].trim();
    if (brand && !isInvalidCompanyName(brand)) {
      return brand;
    }
  }

  // 2. Remove parenthetical subsidiary / owner notes: e.g. "(A Siemens Company)"
  str = str.replace(/\((?:a|an|the)?\s*[^)]*?(?:company|group|subsidiary|division)[^)]*\)/gi, ' ').trim();

  // 3. Strip only generic noise in parentheses (numbers, batch years, categories, academic levels, campuses)
  // Preserves legitimate brand names in parentheses like "Eternal (Zomato)", "Responsive (RFP Software)"
  const NOISE_PARENTHETICAL_REGEX = /\((?:\d+|super\s+dream|dream|regular|core|internship|placement|drive|ppo|fte|off\s+campus|on\s+campus|ug|pg|b\.?tech|m\.?tech|mca|mba|india|vellore|bhopal|chennai|ap|\d{4}(?:\s*batch)?)\)/gi;
  str = str.replace(NOISE_PARENTHETICAL_REGEX, '').trim();

  // Strip trailing corporate legal entity suffixes (e.g. "Euler Motors Pvt. Ltd." -> "Euler Motors")
  // Only strip from the END so brand words (e.g. "India", "Tech", "Technologies", "Solutions", "Services") are fully preserved
  const LEGAL_ENTITY_TRAILING_REGEX = /\s+(?:pvt\.?\s*ltd\.?|private\s+limited|pvt\.?|private|ltd\.?|limited|inc\.?|corp\.?|corporation|llc|llp)\.?$/i;
  while (LEGAL_ENTITY_TRAILING_REGEX.test(str)) {
    str = str.replace(LEGAL_ENTITY_TRAILING_REGEX, '').trim();
  }

  // Remove leading/trailing punctuation
  str = str.replace(/^[:\-\s\|,.\/]+|[:\-\s\|,.\/]+$/g, '').trim();

  if (isInvalidCompanyName(str)) {
    return '';
  }

  return str;
}

/**
 * Normalizes a company name to a clean title-cased form for display.
 * De-duplication matching is handled separately via computeNormalizedKey().
 */
export function normalizeCompanyName(name: string): string {
  if (!name || isInvalidCompanyName(name)) {
    return '';
  }

  const corrected = name.replace(/\bunthikable\b/gi, 'Unthinkable');

  const UPPERCASE_TRACKS = new Set(['SDET', 'SRE', 'SAP', 'GDS', 'TCS', 'IBM', 'UBS', 'EY', 'CDC', 'JPMC', 'PWC', 'BAML', 'MUFG', 'LTI', 'CTS', 'HP', 'GS', 'MS']);

  // Title-case: keep all-caps short tokens (abbreviations) and known track acronyms as-is
  return corrected
    .trim()
    .split(/\s+/)
    .map((word) => {
      const upper = word.toUpperCase();
      if (UPPERCASE_TRACKS.has(upper)) return upper;
      if (word.length <= 3 && word === word.toUpperCase()) return word; // Keep TCS, IBM, UBS, etc.
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}
