import type { PlacementAiExtraction } from './ai-schema';
import { parseDateTimeWithConfidence } from '../extraction/events';

export interface ValidatedAiExtraction {
  companyName: string | null;
  driveNumber: string | null;
  ctc: string | null;
  ctcNum: number | null;
  stipend: string | null;
  category: string;
  events: Array<{
    eventType: 'ppt' | 'online_test' | 'technical_interview' | 'hr_interview' | 'result';
    title: string;
    startTime: string | null;
    venue: string | null;
    sourceQuote: string | null;
    isScheduled: boolean;
  }>;
  confidence: 'high' | 'medium' | 'low' | 'needs_human_review';
  isSanityCheckPassed: boolean;
  sanityFailureReasons: string[];
  extractionNotes: string;
}

/**
 * Deterministically parses compensation strings (sums, ranges, Indian numbering) in TypeScript.
 * Protects against LLM arithmetic hallucinations.
 */
export function parseRawCompensation(rawCtc: string | null | undefined): { formatted: string | null; numericLpa: number | null } {
  if (!rawCtc) return { formatted: null, numericLpa: null };

  const clean = rawCtc.replace(/[\u00A0,]/g, ' ').trim();

  // Pattern 1: Arithmetic sum, e.g. "14 + 1 LPA" or "14+1"
  const sumMatch = clean.match(/(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)\s*(?:lpa|lakh|lac)?/i);
  if (sumMatch) {
    const total = parseFloat(sumMatch[1]) + parseFloat(sumMatch[2]);
    return {
      formatted: `${total.toFixed(total % 1 === 0 ? 0 : 2)} LPA`,
      numericLpa: total,
    };
  }

  // Pattern 2: Range, e.g. "8.5 - 10 LPA"
  const rangeMatch = clean.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(?:lpa|lakh|lac)?/i);
  if (rangeMatch) {
    const high = parseFloat(rangeMatch[2]);
    return {
      formatted: `${rangeMatch[1]} - ${rangeMatch[2]} LPA`,
      numericLpa: high,
    };
  }

  // Pattern 3: Standard LPA e.g. "11.5 LPA" or "11.5 Lakhs"
  const lpaMatch = clean.match(/(\d+(?:\.\d+)?)\s*(?:lpa|lakh|lac|l)/i);
  if (lpaMatch) {
    const val = parseFloat(lpaMatch[1]);
    return {
      formatted: `${val} LPA`,
      numericLpa: val,
    };
  }

  // Pattern 4: Raw Rupee figure e.g. "11,50,000", "11 50 000" or "1150000"
  const rawRupee = rawCtc.replace(/[\u00A0,\s]/g, '');
  const rupeeDigitsMatch = rawRupee.match(/(?:^|[^\d])([1-9]\d{5,7})(?:[^\d]|$)/);
  if (rupeeDigitsMatch) {
    const rawVal = parseInt(rupeeDigitsMatch[1], 10);
    const lpa = rawVal / 100000;
    return {
      formatted: `${parseFloat(lpa.toFixed(2))} LPA`,
      numericLpa: lpa,
    };
  }

  return { formatted: rawCtc.trim(), numericLpa: null };
}

/**
 * Runs deterministic post-processing and sanity checks on LLM extractions.
 */
export function postProcessAndSanitizeAiExtraction(
  rawAi: PlacementAiExtraction,
  emailBodyText: string,
  emailReceivedAt: Date
): ValidatedAiExtraction {
  const sanityFailures: string[] = [];

  // 1. Deterministic Compensation Processing
  const { formatted: ctcFormatted, numericLpa } = parseRawCompensation(rawAi.compensation.ctc_text_raw);

  // Sanity check: CTC believable range (1.5 to 150 LPA)
  if (numericLpa !== null) {
    if (numericLpa < 1.5 || numericLpa > 150) {
      sanityFailures.push(`Extracted CTC (${numericLpa} LPA) is outside plausible range [1.5, 150]`);
    }
  }

  // Sanity check: Ensure raw quote wasn't hallucinated out of nowhere
  if (rawAi.compensation.ctc_text_raw) {
    const snippet = rawAi.compensation.ctc_text_raw.replace(/[\u00A0,\s]/g, '').toLowerCase();
    const cleanBody = emailBodyText.replace(/[\u00A0,\s]/g, '').toLowerCase();
    if (!cleanBody.includes(snippet.slice(0, 15))) {
      sanityFailures.push(`CTC raw text "${rawAi.compensation.ctc_text_raw}" does not correlate with email body`);
    }
  }

  // Sanity check: Ensure Category was explicitly declared in text (prevents LLM inferring tier from CTC)
  let validatedCategory = rawAi.compensation.category;
  if (validatedCategory !== 'Unknown') {
    const quote = rawAi.compensation.category_source_quote?.toLowerCase() || '';
    const cleanBody = emailBodyText.toLowerCase();
    const primaryKeyword = validatedCategory.toLowerCase().includes('super dream')
      ? 'super dream'
      : validatedCategory.toLowerCase().includes('dream')
      ? 'dream'
      : 'regular';

    if (!quote || !cleanBody.includes(quote) || !quote.includes(primaryKeyword)) {
      sanityFailures.push(
        `Category "${validatedCategory}" was rejected because source quote "${rawAi.compensation.category_source_quote}" does not explicitly state "${primaryKeyword}"`
      );
      validatedCategory = 'Unknown';
    }
  }

  // 2. Deterministic Event Processing & Date Sanity Checks
  const validatedEvents: ValidatedAiExtraction['events'] = [];
  const minPlausibleDate = new Date(emailReceivedAt.getTime() - 7 * 24 * 60 * 60 * 1000); // Up to 7 days before email
  const maxPlausibleDate = new Date(emailReceivedAt.getTime() + 180 * 24 * 60 * 60 * 1000); // Up to 6 months after email

  for (const evt of rawAi.events) {
    let parsedStartIso: string | null = null;

    if (evt.is_explicitly_scheduled && evt.date_text_raw) {
      const parsedDate = parseDateTimeWithConfidence(evt.date_text_raw, emailReceivedAt);
      if (parsedDate.date) {
        // Date sanity check
        if (parsedDate.date < minPlausibleDate || parsedDate.date > maxPlausibleDate) {
          sanityFailures.push(
            `Event date (${parsedDate.date.toISOString()}) is outside plausible window relative to email date (${emailReceivedAt.toISOString()})`
          );
        } else {
          parsedStartIso = parsedDate.date.toISOString();
        }
      }
    }

    validatedEvents.push({
      eventType: evt.round_type,
      title: `${rawAi.company_name || 'Placement'} ${evt.round_type.replace('_', ' ').toUpperCase()}`,
      startTime: parsedStartIso,
      venue: evt.venue,
      sourceQuote: evt.source_quote,
      isScheduled: evt.is_explicitly_scheduled && parsedStartIso !== null,
    });
  }

  // 3. Final Calibration
  const isSanityPassed = sanityFailures.length === 0;
  let finalConfidence: ValidatedAiExtraction['confidence'] = rawAi.confidence;
  if (!isSanityPassed) {
    finalConfidence = 'needs_human_review';
  }

  return {
    companyName: rawAi.company_name,
    driveNumber: rawAi.drive_number,
    ctc: ctcFormatted,
    ctcNum: numericLpa,
    stipend: rawAi.compensation.stipend_text_raw,
    category: validatedCategory,
    events: validatedEvents,
    confidence: finalConfidence,
    isSanityCheckPassed: isSanityPassed,
    sanityFailureReasons: sanityFailures,
    extractionNotes: rawAi.extraction_notes,
  };
}
