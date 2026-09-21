/**
 * Utilities for parsing, deduplicating, and consolidating work locations for campus placement drives.
 * 
 * DESIGN PRINCIPLE:
 * In address syntax, "Area, City" or "City, State" (e.g. "Whitefield, Bangalore", "Bangalore, Karnataka")
 * represents an address hierarchy for a SINGLE job location, NOT two distinct hiring locations.
 * Multiple distinct cities are separated by explicit conjunctions ("and", "&"), slashes ("/"),
 * pipes ("|"), semicolons (";"), or lists of 3+ comma-separated cities.
 */

/**
 * Cleans and sanitizes a raw location string for display, stripping out accidental email text
 * like "Criteria : Fluent English communication is", "Requirements : ...", etc.
 */
export function cleanLocationString(raw: string | null | undefined): string {
  if (!raw) return 'Not Specified';
  if (/^\s*(?:remote|work\s+from\s+home|wfh)\s*$/i.test(raw)) return 'Remote';
  if (/^\s*hybrid\s*$/i.test(raw)) return 'Hybrid';

  let cleaned = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s*(?:Criteria|Eligibility|Requirements?|Note|Job\s+Description|JD|Mandatory|Fluent\s+English|Communication|Service\s+Agreement|Bond|Selection|Process|Registration|CTC|Stipend|Designation|Role|PPO|About|Whether|Academic\s+gap|Gap\s+allowed|Allowed|Backlogs?|Standing\s+arrears?|History\s+of\s+arrears?|Cut-?off|Aggregate|CGPA|Branch(?:es)?\s+eligible|Eligible\s+branch(?:es)?|Gender|Batch|Tentative|Internship\s+duration|Joining|Duration|Mode\s+of\s+selection|Assessment|Test\s+date|Interview|Venue|Date\s+of\s+visit|Students?|Candidates?|Kindly|Please|Below\s+attachment|Refer\s+attachment|Allocated|Will\s+be\s+allocated)\b.*$/i, '')
    .replace(/\.\s+[A-Z].*$/, '')
    .replace(/\b(?:fluent\s+english|english\s+communication|communication\s+skills?|good\s+communication)\b.*$/i, '')
    .replace(/\b(?:whether|academic\s+gap|gap\s+allowed|backlogs?|standing\s+arrears?|history\s+of\s+arrears?|allowed\s*:|allowed\b).*$/i, '')
    .replace(/\s*\(?(?:work\s+from\s+office|wfo|in\s+person|on\s*site|in\s+office)\)?/gi, '')
    .replace(/[*_~`]+/g, '')
    .replace(/[:\-–—\s*]+$/, '')
    .replace(/^[:\-–—\s*]+/, '')
    .replace(/\bHyderabed\b/gi, 'Hyderabad')
    .replace(/\bbngalore\b/gi, 'Bangalore')
    .replace(/\s+/g, ' ')
    .trim();

  // Fix unclosed parenthesis (e.g. "Hybrid (Gurgaon/Bangalore/Chennai" -> "Hybrid (Gurgaon/Bangalore/Chennai)")
  if (cleaned.includes('(') && !cleaned.includes(')')) {
    cleaned = cleaned + ')';
  }

  // Normalize multi-city separators: "|", "/", "&", and "and" (between words) to clean commas
  cleaned = cleaned
    .replace(/\s+(?:&|and)\s+/gi, ', ')
    .replace(/\s*(?:\||\/)\s*/g, ', ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(?:,\s*)+/g, ', ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();

  // Strip enclosing parentheses (e.g. "(Gurgaon, Bangalore)" -> "Gurgaon, Bangalore")
  cleaned = cleaned.replace(/^\((.*)\)$/, '$1').trim();

  if (!cleaned || /^(?:tba|tbd|not\s+specified|not\s+mentioned|to\s+be\s+announced)$/i.test(cleaned)) {
    return 'Not Specified';
  }

  // Filter out if it became purely numbers or punctuation
  if (/^[\d\s,.\-]+$/.test(cleaned)) {
    return 'Not Specified';
  }

  return cleaned;
}

/**
 * Normalizes and extracts distinct physical work locations from a raw string.
 * Consolidates address hierarchies ("Whitefield, Bangalore" -> ["Whitefield, Bangalore"])
 * while preserving distinct cities ("Bangalore, Mumbai and Gurgaon" -> ["Bangalore", "Mumbai", "Gurgaon"]).
 */
export function parseAssignedLocations(rawLocation: string | null | undefined): string[] {
  if (!rawLocation) return [];

  const sanitized = cleanLocationString(rawLocation);
  if (!sanitized || sanitized === 'Pan-India') {
    return rawLocation && /pan\s+india/i.test(rawLocation) ? ['Pan India'] : [];
  }

  const trimmed = sanitized.replace(/\s+/g, ' ').trim();
  if (
    !trimmed ||
    /^(?:to\s+be\s+announced|tbd|tba|not\s+(?:specified|mentioned))$/i.test(trimmed)
  ) {
    return [];
  }

  if (/^(?:pan\s+india\s*\/?\s*remote|remote|pan\s+india)$/i.test(trimmed)) {
    return [trimmed];
  }

  // 1. Split across major multi-city delimiters: ";", "|", or "/" (when not hybrid/remote)
  const majorSegments = trimmed
    .split(/\s*(?:;|\|)\s*/i)
    .flatMap((seg) => {
      if (/\b(?:remote|hybrid|wfh)\b/i.test(seg)) return [seg];
      return seg.split(/\s*\/\s*/);
    })
    .map((s) => s.trim())
    .filter(Boolean);

  const results: string[] = [];

  for (const seg of majorSegments) {
    // Check if segment has list conjunction "and" / "&" (e.g. "Bangalore, Mumbai and Gurgaon")
    if (/\s+(?:and|&)\s+/i.test(seg)) {
      const andParts = seg.split(/\s+(?:and|&)\s+/i).map((p) => p.trim()).filter(Boolean);
      for (const ap of andParts) {
        if (ap.includes(',')) {
          const parts = ap.split(',').map((p) => p.trim()).filter(Boolean);
          // If sub-part has 2 tokens and andParts has another city, check if it's "Area, City"
          if (parts.length === 2 && andParts.length > 1) {
            results.push(ap);
          } else {
            results.push(...parts);
          }
        } else {
          results.push(ap);
        }
      }
    } else if (seg.includes(',')) {
      const parts = seg.split(',').map((p) => p.trim()).filter(Boolean);
      // Standard address format: "Area, City" or "City, State" (exactly 2 parts)
      // e.g. "Whitefield, Bangalore", "Bangalore, Karnataka", "Palo Alto, California" -> 1 location!
      if (parts.length === 2) {
        results.push(seg);
      } else {
        // 3+ parts: "Bangalore, Mumbai, Gurgaon" -> multiple distinct cities
        results.push(...parts);
      }
    } else {
      results.push(seg);
    }
  }

  // Clean up any stray quotes, asterisks, or parenthesis
  const cleaned = results
    .map((loc) => loc.replace(/^[*,\.\s>\-]+/, '').replace(/[*,\.\s>\-]+$/, '').trim())
    .filter((loc) => loc.length > 0 && !/^\d+$/.test(loc));

  return cleaned;
}

