/**
 * round-identity.ts
 *
 * Pure utility functions for round classification and predecessor evidence.
 * NO database access anywhere in this file.
 * All functions are deterministic given their inputs.
 */

// ---------------------------------------------------------------------------
// Round type taxonomy
// ---------------------------------------------------------------------------

/**
 * Fine-grained round classification stored in candidate_matches.matched_round_type.
 * These are TEXT values (not a DB enum), so they are purely additive.
 *
 * Backward-compatible: existing rows may have 'test' | 'interview' | 'selected' | null.
 * The new values ('test_r2', 'gd', 'ppt', 'interview_r2') are additive.
 */
export type RoundType =
  | 'test'          // online/coding assessment — first or only round
  | 'test_r2'       // explicitly labeled Round 2 assessment
  | 'gd'            // group discussion — distinct from PPT and interview
  | 'ppt'           // PPT shortlist (only when candidates are named — rare)
  | 'interview'     // technical/HR/final interview — first or only round
  | 'interview_r2'  // explicitly labeled second/round-2 interview
  | 'selected';     // final selection / offer

/**
 * Explicit predecessor types extracted from email text.
 * null = no explicit predecessor claim found.
 */
export type ExplicitPredecessor =
  | null
  | 'any_test'       // "cleared the (online)? assessment/test/coding round"
  | 'test_r2'        // "cleared round 2 (assessment)"
  | 'any_interview'  // "cleared the interview" (unspecified round)
  | 'interview_r1';  // "cleared round 1 interview / first interview"

// ---------------------------------------------------------------------------
// 1. Email classification: what round does this shortlist announce?
// ---------------------------------------------------------------------------

/**
 * Classifies a shortlist email into the round it is announcing.
 * Pure function of email text — no DB access, no event/match lookups.
 * Returns null when the round is genuinely ambiguous.
 *
 * Replaces the old `announcedShortlistRound()` function, extending
 * its return type to include 'gd', 'ppt', 'test_r2', 'interview_r2'.
 */
export function classifyShortlistEmail(
  subject: string,
  body: string
): RoundType | null {
  const subj = subject.toLowerCase();
  const text = `${subj}\n${body.toLowerCase()}`;

  // Final selection (highest priority — must not be confused with interview)
  if (
    /final\s*selection|offer\s*(?:letter|release)|congratulations.*(?:final|offer)/i.test(subj) &&
    !/interview|test/i.test(subj)
  ) return 'selected';

  if (
    /selection\s*list/i.test(subj) &&
    !/interview|ppt|test|assessment|group\s+discussion|\bgd\b/i.test(subj)
  ) return 'selected';

  // Group Discussion — before generic interview to avoid misclassification
  if (/group\s+discussion|\bgd\s+(?:round|shortlist|schedule)|\bgd\b.*shortlist/i.test(text)) return 'gd';
  if (/shortlist(?:ed)?\s+for\s+(?:the\s+)?(?:group\s+discussion|\bgd\b)/i.test(text)) return 'gd';

  // Interview — detect round 2 BEFORE generic interview
  if (
    /(?:round\s*2.*interview|interview.*round\s*2|second\s+round\s+(?:of\s+)?interview|second\s+interview|interview\s*(?:round\s*)?(?:ii|2)|r2\s*[–\-]?\s*interview)/i.test(text)
  ) return 'interview_r2';

  if (
    /interview|selection\s+process/i.test(subj) ||
    (/next\s+round/i.test(subj) && /interview|in[\s-]*person|f2f/i.test(body))
  ) return 'interview';

  // Test — detect round 2 BEFORE generic test
  if (
    /(?:round\s*2|second\s+(?:round\s+of\s+)?(?:online\s+)?(?:test|assessment)|assessment\s*(?:round\s*)?(?:ii|2)|r2\s*[–\-]?\s*(?:test|assessment))/i.test(text)
  ) return 'test_r2';

  if (
    /online\s+test|coding\s+test|assessment|test\s+(?:shortlist|link|invitation|schedule)/i.test(subj)
  ) return 'test';

  // PPT shortlist (unusual — only when candidates are explicitly named)
  if (
    /(?:shortlist(?:ed)?|selected\s+candidates?).*(?:ppt|pre[\s-]*placement)|(?:ppt|pre[\s-]*placement).*(?:shortlist|selected\s+candidates?)/i.test(text)
  ) return 'ppt';

  return null;
}

// ---------------------------------------------------------------------------
// 2. Extract explicit predecessor from email body
// ---------------------------------------------------------------------------

/**
 * Scans email text for explicit predecessor claims ("students who cleared the test").
 * Pure function — no DB access.
 * Returns null when no explicit predecessor is stated.
 */
export function extractExplicitPredecessor(
  subject: string,
  body: string
): ExplicitPredecessor {
  const text = `${subject}\n${body}`;

  // Round-2 specific test predecessor
  if (
    /cleared\s+round\s+2|passed\s+round\s+2|shortlisted\s+in\s+round\s+2/i.test(text)
  ) return 'test_r2';

  // First-round interview predecessor
  if (
    /cleared\s+(?:round\s+1\s+)?interview|cleared\s+(?:the\s+)?first\s+interview|passed\s+(?:the\s+)?technical\s+interview|shortlisted\s+(?:in|from)\s+(?:the\s+)?(?:technical\s+)?interview/i.test(text)
  ) return 'interview_r1';

  // Any interview predecessor (less specific)
  if (
    /cleared\s+(?:the\s+)?interview|passed\s+(?:the\s+)?interview|based\s+on\s+(?:your\s+)?interview\s+performance/i.test(text)
  ) return 'any_interview';

  // Test/assessment predecessor (most common)
  if (
    /(?:students?|candidates?)\s+who\s+(?:have\s+)?(?:cleared|passed|appeared\s+for|completed)\s+(?:the\s+)?(?:online\s+)?(?:assessment|test|coding\s+(?:round|test))|based\s+on\s+(?:your\s+)?(?:test|assessment|coding\s+round)\s+performance|after\s+(?:clearing|passing)\s+(?:the\s+)?(?:online\s+)?(?:assessment|test)|shortlisted\s+(?:based\s+on|from)\s+(?:the\s+)?(?:online\s+)?(?:assessment|test)/i.test(text)
  ) return 'any_test';

  return null;
}

// ---------------------------------------------------------------------------
// 3. Per-transition predecessor gate
// ---------------------------------------------------------------------------

/**
 * Returns the matched_round_type values that must exist in candidate_matches
 * for the candidate to be considered meaningfully eliminated (status='rejected')
 * when absent from the given announced round's shortlist.
 *
 * Returns [] (empty array) when no predecessor proof is needed — absence from
 * the announced round is itself sufficient for not_shortlisted.
 *
 * Returns null when no predecessor requirement applies because the requirement
 * is conditional on explicit text evidence that was NOT found — meaning the
 * conservative verdict (not_shortlisted) applies.
 */
export function getPredecessorRequirement(
  announcedRound: RoundType | null,
  emailExplicitPredecessor: ExplicitPredecessor
): RoundType[] | null {
  if (!announcedRound) return null;

  switch (announcedRound) {
    case 'test':
      // First competitive round — no prior clearing required.
      if (emailExplicitPredecessor === 'any_test') return ['test', 'test_r2'];
      return [];

    case 'test_r2':
      // "Round 2" inherently asserts Round 1 was a prerequisite.
      return ['test'];

    case 'gd':
      // GD can appear at any position; predecessor only established via explicit text.
      if (emailExplicitPredecessor === 'any_test') return ['test', 'test_r2'];
      if (emailExplicitPredecessor === 'test_r2') return ['test_r2'];
      return null; // no explicit predecessor → conservative

    case 'ppt':
      // PPT shortlists are not normally contingent on a prior competitive round.
      if (emailExplicitPredecessor === 'any_test') return ['test', 'test_r2'];
      return [];

    case 'interview':
      // Cannot assume test → interview without explicit text.
      if (emailExplicitPredecessor === 'any_test') return ['test', 'test_r2'];
      if (emailExplicitPredecessor === 'test_r2') return ['test_r2'];
      if (emailExplicitPredecessor === 'any_interview') return ['interview'];
      return null; // no explicit predecessor → conservative

    case 'interview_r2':
      // "Round 2" inherently asserts Round 1 interview — test alone insufficient.
      return ['interview'];

    case 'selected':
      return ['interview', 'interview_r2'];

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 4. Explicit ordinal extraction from email text
// ---------------------------------------------------------------------------

const ORDINAL_MAP: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5,
  i: 1, ii: 2, iii: 3, iv: 4, v: 5,
};

/**
 * Tries to extract an explicit round number from email subject + body.
 * Returns { roundNumber, roundLabel } if found, null otherwise.
 *
 * Examples:
 *   "Round 2 Assessment" → { roundNumber: 2, roundLabel: "Round 2" }
 *   "Technical Interview II" → { roundNumber: 2, roundLabel: "Interview II" }
 *   "Second Round of Interviews" → { roundNumber: 2, roundLabel: "Second Round" }
 */
export function extractExplicitOrdinal(
  subject: string,
  body: string
): { roundNumber: number; roundLabel: string } | null {
  const text = `${subject}\n${body.slice(0, 500)}`;

  // Pattern 1: "Round <N>" — most common
  const roundN = text.match(/\bround\s+(\d+)\b/i);
  if (roundN) {
    const n = parseInt(roundN[1], 10);
    if (n >= 1 && n <= 10) return { roundNumber: n, roundLabel: `Round ${n}` };
  }

  // Pattern 2: "<event> <N>" — "Assessment 2", "Interview 3"
  const eventN = text.match(/\b(?:assessment|interview|test)\s+(\d+)\b/i);
  if (eventN) {
    const n = parseInt(eventN[1], 10);
    if (n >= 1 && n <= 10) return { roundNumber: n, roundLabel: eventN[0] };
  }

  // Pattern 3: "<event> <roman>" — "Technical Interview II"
  const romanMatch = text.match(/\b(?:assessment|interview|test)\s+(i{1,3}|iv|v)\b/i);
  if (romanMatch) {
    const roman = romanMatch[1].toLowerCase();
    const n = ORDINAL_MAP[roman];
    if (n) return { roundNumber: n, roundLabel: romanMatch[0] };
  }

  // Pattern 4: "<ordinal> round/interview/assessment" (including plural)
  const ordinalMatch = text.match(
    /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(?:round\s+(?:of\s+)?)?(?:interviews?|assessments?|tests?|online\s+tests?|coding\s+tests?)\b/i
  );
  if (ordinalMatch) {
    const ordinal = ordinalMatch[1].toLowerCase();
    const n = ORDINAL_MAP[ordinal];
    if (n) return { roundNumber: n, roundLabel: ordinalMatch[0] };
  }

  // Pattern 5: "R2" shorthand in subject only
  const r2Match = subject.match(/\bR(\d+)\b/i);
  if (r2Match) {
    const n = parseInt(r2Match[1], 10);
    if (n >= 1 && n <= 10) return { roundNumber: n, roundLabel: `R${n}` };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 5. Reschedule detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the email is a rescheduling notice (not a new round announcement).
 */
export function isRescheduleEmail(subject: string, body: string): boolean {
  const text = `${subject}\n${body.slice(0, 300)}`;
  return /rescheduled?|postponed?|new\s+date|date\s+(?:change|changed|revised)|now\s+scheduled\s+for|revised\s+schedule|updated\s+schedule/i.test(text);
}

// ---------------------------------------------------------------------------
// 6. Elimination label: token ↔ human-readable label
// ---------------------------------------------------------------------------

export const ELIMINATION_LABELS: Partial<Record<RoundType, string>> = {
  test:         'Eliminated in Test Round',
  test_r2:      'Eliminated in Round 2 Assessment',
  gd:           'Eliminated in Group Discussion',
  ppt:          'Not Shortlisted for PPT',
  interview:    'Interviewed · Not Selected',
  interview_r2: 'Eliminated in Round 2 Interview',
};

/**
 * Builds the structured elimination token to be written to applications.notes line 1.
 * e.g. buildEliminationToken('gd') → "eliminated_at:gd"
 */
export function buildEliminationToken(roundType: RoundType): string {
  return `eliminated_at:${roundType}`;
}

/**
 * Parses applications.notes to extract elimination round type + human-readable label.
 * Reads every line looking for either the new token format or legacy freeform prose.
 *
 * Notes format: line 0 = travel token (vellore|online|...), line 1 = elimination token,
 * line 2+ = AI flags. Elimination token may be absent or on any line.
 */
export function parseEliminationToken(notes: string | null | undefined): {
  roundType: RoundType | null;
  label: string;
} {
  if (!notes) return { roundType: null, label: '' };

  for (const line of notes.split('\n')) {
    const trimmed = line.trim();

    // New structured token (preferred)
    const tokenMatch = trimmed.match(/^eliminated_at:(\w+)$/);
    if (tokenMatch) {
      const rt = tokenMatch[1] as RoundType;
      return { roundType: rt, label: ELIMINATION_LABELS[rt] ?? `Eliminated (${rt})` };
    }

    // Legacy freeform prose — backward compat for existing DB rows
    if (/Interviewed.*Not\s+Selected|Not\s+Selected.*Interviewed/i.test(trimmed)) {
      return { roundType: 'interview', label: 'Interviewed · Not Selected' };
    }
    if (/Eliminated\s+in\s+(?:Round\s+2\s+)?(?:Test|Assessment)\s+Round|Eliminated\s+in\s+Round\s+2\s+Assessment/i.test(trimmed)) {
      return { roundType: 'test', label: trimmed };
    }
    if (/Eliminated\s+in\s+Group\s+Discussion/i.test(trimmed)) {
      return { roundType: 'gd', label: trimmed };
    }
  }

  return { roundType: null, label: '' };
}

// ---------------------------------------------------------------------------
// 7. Stage ID helpers (used by stepper + stages.ts)
// ---------------------------------------------------------------------------

/**
 * Builds the canonical stage ID for a given event type and round number.
 * e.g. deriveStageId('online_test', 2) → 'online_test_r2'
 */
export function deriveStageId(eventType: string, roundNumber: number): string {
  return `${eventType}_r${roundNumber}`;
}

/**
 * Returns the display labels for a stage ID.
 * e.g. 'online_test_r2' → { label: 'Online Test Round 2', shortLabel: 'Test 2' }
 */
export function deriveStageLabelFromId(stageId: string): { label: string; shortLabel: string } {
  const match = stageId.match(/^(.+)_r(\d+)$/);
  if (!match) return { label: stageId, shortLabel: stageId };

  const [, eventType, roundStr] = match;
  const round = parseInt(roundStr, 10);

  const TYPE_LABELS: Record<string, [string, string]> = {
    ppt:                   ['Pre-Placement Talk', 'PPT'],
    group_discussion:      ['Group Discussion', 'GD'],
    online_test:           ['Online Test', 'Test'],
    coding_test:           ['Coding Test', 'Test'],
    technical_interview:   ['Technical Interview', 'Interview'],
    hr_interview:          ['HR Interview', 'HR'],
    final_interview:       ['Final Interview', 'Interview'],
    registration_deadline: ['Registration Deadline', 'Deadline'],
  };

  const [baseLabel, baseShort] = TYPE_LABELS[eventType] ?? [eventType, eventType];
  return {
    label:      round > 1 ? `${baseLabel} Round ${round}` : baseLabel,
    shortLabel: round > 1 ? `${baseShort} ${round}` : baseShort,
  };
}
