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
  | 'post_ppt'      // Screened out after PPT (attended PPT, not shortlisted for test)
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
    /(?:round\s*2|second\s+(?:round\s+of\s+)?(?:online\s+)?(?:test|assessment)|assessment\s*(?:round\s*)?(?:ii|2)|r2\s*[–\-]?\s*(?:test|assessment)|game\s+round|gamified\s+assessment)/i.test(text)
  ) return 'test_r2';

  if (
    /online\s+test|coding\s+test|assessment|test\s+(?:shortlist|link|invitation|schedule)/i.test(subj) ||
    (/shortlist/i.test(subj) && /(?:online\s+)?tests?|assessment|coding/i.test(text)) ||
    /shortlist\s+and\s+dates/i.test(subj)
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
  post_ppt:     'Not Shortlisted (Post PPT)',
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
      if (rt === 'post_ppt') {
        return { roundType: 'post_ppt', label: 'Not Shortlisted (Post PPT)' };
      }
      return { roundType: rt, label: ELIMINATION_LABELS[rt] ?? `Eliminated (${rt})` };
    }

    // Explicit post-PPT status tokens or legacy freeform text
    if (/not\s*shortlisted\s*\(post\s*ppt\)|not\s*shortlisted\s*post[\s-]*ppt|not\s*shortlisted\s*after\s*ppt/i.test(trimmed)) {
      return { roundType: 'post_ppt', label: 'Not Shortlisted (Post PPT)' };
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

// ---------------------------------------------------------------------------
// 8. Announced Recruitment Process (Structured pipeline from circular)
// ---------------------------------------------------------------------------

export interface AnnouncedRound {
  id: string;
  label: string;
  shortLabel: string;
  dateStr?: string;
  roundType: 'ppt' | 'test' | 'gd' | 'interview' | 'other';
  roundNumber?: number;
}

/**
 * Extracts structured recruitment process rounds from a drive's circular text
 * when it explicitly details the process schedule (e.g. under "Date of Visit:",
 * "Recruitment Process:", "Selection Process:").
 *
 * High-confidence requirement: Must find at least 2 structured rounds with known
 * round keywords (test, interview, game round, gd, ppt).
 */
export function parseRecruitmentProcess(text: string): AnnouncedRound[] | null {
  if (!text) return null;

  // 1. Isolate the process schedule section
  const processMatch = text.match(
    /(?:date\s+of\s+visit|recruitment\s+process|selection\s+process|process\s+schedule|hiring\s+process)\s*[:\-–—\t*]*\s*([\s\S]{1,500}?)(?:\b(?:eligible\s+branches|eligibility(?:\s+criteria)?|ctc|stipend|salary|last\s+date|website|job\s+description|about\s+the\s+company)\b|$)/i
  );

  if (!processMatch || !processMatch[1]) return null;
  const block = processMatch[1].trim();

  // Split into lines
  const lines = block
    .split(/\r?\n/)
    .map(l => l.replace(/^[•\-\*#\s]*(?:\d+[\.\)\-:]\s+)?/, '').trim())
    .filter(l => l.length > 3 && l.length < 100);

  const ROUND_KEYWORD_REGEX = /\b(test|assessment|coding|ppt|pre[\s-]*placement|interview|game\s*round|gd|group\s+discussion|hackathon|technical|hr)\b/i;

  interface RawRound {
    roundType: AnnouncedRound['roundType'];
    explicitNumber?: number;
    dateStr?: string;
    rawText: string;
    isGameRound: boolean;
    isHackathon: boolean;
  }

  const rawRounds: RawRound[] = [];

  for (const line of lines) {
    if (!ROUND_KEYWORD_REGEX.test(line)) continue;

    // Extract date if present (e.g., "2nd October", "6th October", "15-10-2026", "31 august 2026")
    const dateMatch = line.match(/\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:\s+\d{2,4})?|\d{1,2}[-\/.]\d{1,2}(?:[-\/.]\d{2,4})?)\b/i);
    const dateStr = dateMatch ? dateMatch[0] : undefined;

    // Clean round label by removing date strings anywhere in the line
    let cleanLine = line;
    if (dateStr) {
      cleanLine = cleanLine.replace(new RegExp(`\\b${dateStr}\\b\\s*[:\\-–—]?\\s*`, 'i'), ' ').replace(/\s{2,}/g, ' ').trim();
    }

    if (!cleanLine || cleanLine.length < 3) continue;

    // Check for explicit round numbering in text (1-10 only to prevent calendar days like "31" being treated as round 31)
    const numMatch = cleanLine.match(/\b(?:(?:test|interview|round|assessment|stage)\s*([1-9]|10)\b|([1-9]|10)(?:st|nd|rd|th)?\s+(?:test|interview|round|assessment|stage)\b|r([1-9]|10)\b)/i);
    const explicitNumber = numMatch ? parseInt(numMatch[1] || numMatch[2] || numMatch[3], 10) : undefined;

    let roundType: AnnouncedRound['roundType'] = 'other';
    let isGameRound = false;
    let isHackathon = false;

    if (/\b(ppt|pre[\s-]*placement)\b/i.test(cleanLine)) {
      roundType = 'ppt';
    } else if (/\b(game\s*round|gamified(?:\s+assessment|\s+round)?)\b/i.test(cleanLine)) {
      roundType = 'other';
      isGameRound = true;
    } else if (/\b(hackathon)\b/i.test(cleanLine)) {
      roundType = 'other';
      isHackathon = true;
    } else if (/\b(gd|group\s+discussion)\b/i.test(cleanLine)) {
      roundType = 'gd';
    } else if (/\b(interview|hr|technical)\b/i.test(cleanLine)) {
      roundType = 'interview';
    } else if (/\b(test|assessment|coding)\b/i.test(cleanLine)) {
      roundType = 'test';
    }

    rawRounds.push({
      roundType,
      explicitNumber,
      dateStr,
      rawText: cleanLine,
      isGameRound,
      isHackathon,
    });
  }

  // Must have at least 2 distinct rounds to qualify as a structured process
  if (rawRounds.length < 2) return null;

  // Campus placement rule: A drive never jumps directly from PPT (or Applied) to Interview without a Test.
  // When circulars list PPT and Interview/GD dates but omit the test schedule (announced separately),
  // inject a Test round before Interview/GD rounds.
  const hasTestRound = rawRounds.some(r => r.roundType === 'test');
  const hasInterviewOrGd = rawRounds.some(r => r.roundType === 'interview' || r.roundType === 'gd');
  if (!hasTestRound && hasInterviewOrGd) {
    const insertIdx = rawRounds.findIndex(r => r.roundType === 'interview' || r.roundType === 'gd');
    rawRounds.splice(insertIdx !== -1 ? insertIdx : rawRounds.length, 0, {
      roundType: 'test',
      rawText: 'Test',
      isGameRound: false,
      isHackathon: false,
    });
  }

  const totalTests = rawRounds.filter(r => r.roundType === 'test').length;
  const totalInterviews = rawRounds.filter(r => r.roundType === 'interview').length;

  let testSeq = 0;
  let interviewSeq = 0;
  const rounds: AnnouncedRound[] = [];
  const seenIds = new Set<string>();

  for (const raw of rawRounds) {
    let label = '';
    let shortLabel = '';
    let roundNumber: number | undefined;
    let baseId = '';

    if (raw.roundType === 'ppt') {
      label = 'Pre-Placement Talk';
      shortLabel = 'PPT';
      baseId = 'ppt';
    } else if (raw.roundType === 'gd') {
      label = 'Group Discussion';
      shortLabel = 'GD';
      baseId = 'gd';
    } else if (raw.isGameRound) {
      label = 'Game Round';
      shortLabel = 'Game Round';
      baseId = 'game_round';
    } else if (raw.isHackathon) {
      label = 'Hackathon';
      shortLabel = 'Hackathon';
      baseId = 'hackathon';
    } else if (raw.roundType === 'test') {
      testSeq++;
      roundNumber = raw.explicitNumber ?? (totalTests > 1 ? testSeq : 1);
      if (totalTests > 1 || raw.explicitNumber) {
        label = `Test ${roundNumber}`;
        shortLabel = `Test ${roundNumber}`;
      } else {
        label = 'Test';
        shortLabel = 'Test';
      }
      baseId = `test_${roundNumber}`;
    } else if (raw.roundType === 'interview') {
      interviewSeq++;
      roundNumber = raw.explicitNumber ?? (totalInterviews > 1 ? interviewSeq : 1);
      if (totalInterviews > 1 || raw.explicitNumber) {
        label = `Interview ${roundNumber}`;
        shortLabel = `Interview ${roundNumber}`;
      } else {
        label = 'Interview';
        shortLabel = 'Interview';
      }
      baseId = `interview_${roundNumber}`;
    } else {
      const clean = raw.rawText.replace(/\s*\([^)]*\)/g, '').replace(/[-–—].*$/, '').trim();
      label = clean || 'Round';
      shortLabel = clean || 'Round';
      baseId = shortLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'round';
    }

    let id = baseId;
    let counter = 2;
    while (seenIds.has(id)) {
      id = `${baseId}_${counter++}`;
    }
    seenIds.add(id);

    rounds.push({
      id,
      label,
      shortLabel,
      dateStr: raw.dateStr,
      roundType: raw.roundType,
      roundNumber,
    });
  }

  return sanitizeAnnouncedRounds(rounds);
}

export function buildAnnouncedProcessToken(rounds: AnnouncedRound[]): string {
  return `announced_process:${JSON.stringify(rounds)}`;
}

/**
 * Normalizes and sanitizes announced process rounds, ensuring verbose email text,
 * dates, campus venues, or unstructured notes never leak into stage stepper labels.
 */
export function sanitizeAnnouncedRounds(rounds: AnnouncedRound[]): AnnouncedRound[] {
  if (!Array.isArray(rounds)) return [];

  // Campus placement rule: Ensure a Test round exists between PPT and Interview/GD
  let normalized = [...rounds];
  const hasTest = normalized.some(r => r.roundType === 'test');
  const hasInterviewOrGd = normalized.some(r => r.roundType === 'interview' || r.roundType === 'gd');

  if (!hasTest && hasInterviewOrGd) {
    const insertIdx = normalized.findIndex(r => r.roundType === 'interview' || r.roundType === 'gd');
    normalized.splice(insertIdx !== -1 ? insertIdx : normalized.length, 0, {
      id: 'test_1',
      label: 'Test',
      shortLabel: 'Test',
      roundType: 'test',
      roundNumber: 1,
    });
  }

  // Canonical placement recruitment round order:
  // 1. PPT / Pre-Placement Talk
  // 2. Test 1 / Online Assessment
  // 3. Game Round / Gamified Assessment (conducted after Test 1 and before in-campus Test 2)
  // 4. Test 2+ / In-Campus Assessment
  // 5. GD / Group Discussion
  // 6. Other (Hackathon, etc.)
  // 7. Interview (Interview MUST NEVER precede a Test)
  const getRoundSortOrder = (r: AnnouncedRound): number => {
    if (r.roundType === 'ppt') return 10;
    if (r.roundType === 'test') {
      const num = r.roundNumber ?? (
        r.id.match(/_(\d+)$/)?.[1]
          ? parseInt(r.id.match(/_(\d+)$/)![1], 10)
          : (r.label.match(/\b([2-9]|10)\b/)?.[1] ? parseInt(r.label.match(/\b([2-9]|10)\b/)![1], 10) : 1)
      );
      return num === 1 ? 20 : 40;
    }
    if (/game/i.test(r.id || r.label || r.shortLabel)) {
      return 30;
    }
    if (r.roundType === 'gd') return 50;
    if (r.roundType === 'other') return 60;
    if (r.roundType === 'interview') return 70 + (r.roundNumber ?? 1);
    return 99;
  };

  normalized.sort((a, b) => {
    const orderA = getRoundSortOrder(a);
    const orderB = getRoundSortOrder(b);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    if (a.dateStr && b.dateStr) {
      const timeA = parseScheduledDateInSubject(a.dateStr);
      const timeB = parseScheduledDateInSubject(b.dateStr);
      if (timeA && timeB && timeA !== timeB) {
        return timeA - timeB;
      }
    }
    return (a.roundNumber ?? 1) - (b.roundNumber ?? 1);
  });

  const totalTests = normalized.filter(r => r.roundType === 'test').length;
  const totalInterviews = normalized.filter(r => r.roundType === 'interview').length;

  let testSeq = 0;
  let interviewSeq = 0;

  return normalized.map(r => {
    let { label, shortLabel, id, roundType, roundNumber, dateStr } = r;

    if (label?.includes('PPT & GD') || shortLabel?.includes('PPT & GD') || id === 'ppt_gd') {
      label = 'PPT & GD';
      shortLabel = 'PPT & GD';
    } else if (roundType === 'ppt') {
      label = 'Pre-Placement Talk';
      shortLabel = 'PPT';
    } else if (roundType === 'gd') {
      label = 'Group Discussion';
      shortLabel = 'GD';
    } else if (roundType === 'test') {
      testSeq++;
      const num = totalTests > 1 ? (roundNumber && roundNumber <= totalTests ? roundNumber : testSeq) : 1;
      roundNumber = num;
      if (totalTests > 1) {
        label = `Test ${num}`;
        shortLabel = `Test ${num}`;
      } else {
        label = 'Test';
        shortLabel = 'Test';
      }
    } else if (roundType === 'interview') {
      interviewSeq++;
      const num = totalInterviews > 1 ? (roundNumber && roundNumber <= totalInterviews ? roundNumber : interviewSeq) : 1;
      roundNumber = num;
      if (totalInterviews > 1) {
        label = `Interview ${num}`;
        shortLabel = `Interview ${num}`;
      } else {
        label = 'Interview';
        shortLabel = 'Interview';
      }
    } else if (roundType === 'other') {
      if (/game/i.test(label || shortLabel || id)) {
        label = 'Game Round';
        shortLabel = 'Game Round';
      } else if (/hackathon/i.test(label || shortLabel || id)) {
        label = 'Hackathon';
        shortLabel = 'Hackathon';
      } else {
        const clean = (shortLabel || label || 'Round')
          .replace(/\s*\([^)]*\)/g, '')
          .replace(/[-–—].*$/, '')
          .trim();
        label = clean || 'Round';
        shortLabel = clean || 'Round';
      }
    }

    return {
      id: id || `${shortLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      label,
      shortLabel,
      dateStr,
      roundType,
      roundNumber,
    };
  });
}

/**
 * Fallback: infer the announced recruitment pipeline from the email **subject line** alone.
 *
 * Used when the email body lacks a structured "Recruitment Process:" / "Selection Process:"
 * section but the subject directly names the round(s) being announced — e.g.
 *   "Deloitte India PPT & Group Discussion is scheduled on (01-10-2026)"
 *   "Infosys next round of selection process (Technical Interview) is scheduled"
 *   "Amazon online (Test - 2) is scheduled on 29th September"
 *
 * Returns null when the subject is too ambiguous (fewer than 2 distinct round tokens found),
 * to avoid polluting single-event schedule announcements with a fake process pipeline.
 */
export function parseAnnouncedRoundsFromSubject(subject: string): AnnouncedRound[] | null {
  if (!subject) return null;
  const subj = subject
    .replace(/^(?:fwd?|re|fw)\s*:\s*/i, '')   // strip forward/reply prefixes
    .toLowerCase();

  const rawRounds: Array<{ roundType: AnnouncedRound['roundType']; label: string; shortLabel: string }> = [];

  // Check for PPT (pre-placement talk)
  if (/\bppt\b|pre[- ]*placement\s*talk/i.test(subj)) {
    rawRounds.push({ roundType: 'ppt', label: 'Pre-Placement Talk', shortLabel: 'PPT' });
  }

  // Check for Group Discussion / GD
  if (/\bgroup\s+discussion\b|\bgd\b/i.test(subj)) {
    rawRounds.push({ roundType: 'gd', label: 'Group Discussion', shortLabel: 'GD' });
  }

  // Check for Test (detect round 2 first)
  const testR2 = /\b(?:test|online\s+test|assessment)\s*[-–]?\s*2\b|\btest\s+2\b|\bround\s+2\s+(?:online\s+)?(?:test|assessment)\b/i.test(subj);
  const hasTest = /\bonline\s+test\b|\bcoding\s+test\b|\bassessment\b|\btest\b/i.test(subj);
  if (testR2) {
    rawRounds.push({ roundType: 'test', label: 'Test 2', shortLabel: 'Test 2' });
  } else if (hasTest && !rawRounds.some(r => r.roundType === 'ppt' || r.roundType === 'gd')) {
    // Only add test when it's the sole round keyword in subject (otherwise it's a schedule email for that test)
    rawRounds.push({ roundType: 'test', label: 'Test', shortLabel: 'Test' });
  }

  // Check for Interview
  if (/\btechnical\s+interview\b|\bhr\s+interview\b|\bfinal\s+interview\b|\binterview\b/i.test(subj)) {
    rawRounds.push({ roundType: 'interview', label: 'Interview', shortLabel: 'Interview' });
  }

  // Must contain at least two recognizable round types to infer a structured pipeline.
  // A subject that only says "Test scheduled" doesn't tell us the full process.
  if (rawRounds.length < 2) return null;

  // Determine the authoritative round ordering from the subject.
  // PPT always comes first, then test, then GD, then interview.
  const ORDER: Array<AnnouncedRound['roundType']> = ['ppt', 'test', 'gd', 'interview'];
  const sorted = [...rawRounds].sort(
    (a, b) => ORDER.indexOf(a.roundType) - ORDER.indexOf(b.roundType)
  );

  // Campus placement rule: inject a Test between PPT/applied and Interview/GD
  // when no test was explicitly found in the subject.
  const hasTestRound = sorted.some(r => r.roundType === 'test');
  const hasInterviewOrGd = sorted.some(r => r.roundType === 'interview' || r.roundType === 'gd');
  if (!hasTestRound && hasInterviewOrGd) {
    const insertIdx = sorted.findIndex(r => r.roundType === 'interview' || r.roundType === 'gd');
    sorted.splice(insertIdx !== -1 ? insertIdx : sorted.length, 0, {
      roundType: 'test',
      label: 'Test',
      shortLabel: 'Test',
    });
  }

  // Build final AnnouncedRound objects with de-duplicated IDs
  const seenIds = new Set<string>();
  const rounds: AnnouncedRound[] = [];
  for (const r of sorted) {
    const baseId = r.roundType === 'gd' ? 'gd' : r.roundType === 'ppt' ? 'ppt' : r.roundType === 'interview' ? 'interview_1' : 'test_1';
    let id = baseId;
    let counter = 2;
    while (seenIds.has(id)) id = `${baseId}_${counter++}`;
    seenIds.add(id);
    rounds.push({ id, label: r.label, shortLabel: r.shortLabel, roundType: r.roundType });
  }

  return rounds.length >= 2 ? rounds : null;
}

export function parseAnnouncedProcessToken(notes: string | null | undefined): AnnouncedRound[] | null {
  if (!notes) return null;
  for (const line of notes.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('announced_process:')) {
      try {
        const json = trimmed.slice('announced_process:'.length);
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed) && parsed.length >= 2) {
          return sanitizeAnnouncedRounds(parsed);
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseScheduledDateInSubject(sub: string): number | null {
  if (!sub) return null;
  const m1 = sub.match(/(?:scheduled\s+on\s+[([]?|^|\b)(\d{1,2}(?:st|nd|rd|th)?)\s+([A-Za-z]+)(?:\s+(20\d{2}|\b2[4-7]\b))?/i);
  if (m1) {
    const day = m1[1].replace(/\D/g, '');
    const month = m1[2];
    const year = m1[3] ? (m1[3].length === 2 ? '20' + m1[3] : m1[3]) : '2026';
    const p = Date.parse(`${day} ${month} ${year} UTC`);
    if (!isNaN(p)) return p;
  }
  const m2 = sub.match(/(?:scheduled\s+on\s+[([]?|^|\b)(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2}|\b2[4-7]\b)/i);
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
 * Extracts the announced recruitment pipeline by synthesizing all emails/circulars for a placement drive.
 * Handles drives where the company conducts Test 1 first, followed by PPT & GD and Interviews (e.g. Deloitte),
 * as well as conventional drives where PPT precedes the Test.
 */
export function extractAnnouncedRoundsFromEmails(
  emails: Array<{
    subject?: string | null;
    snippet?: string | null;
    body_snippet?: string | null;
    body_text?: string | null;
    received_at?: string | null;
    receivedAt?: string | null;
  }>
): AnnouncedRound[] | null {
  if (!emails || emails.length === 0) return null;

  // 1. Structured text in body takes precedence if available
  for (const e of emails) {
    const text = `${e.subject || ''}\n${e.body_text || e.body_snippet || e.snippet || ''}`;
    const structured = parseRecruitmentProcess(text);
    if (structured && structured.length >= 2) {
      return structured;
    }
  }

  // 2. Discover rounds across subjects and determine chronological / structural ordering
  const roundMap = new Map<
    string,
    {
      id: string;
      label: string;
      shortLabel: string;
      roundType: AnnouncedRound['roundType'];
      date: number;
    }
  >();

  for (const e of emails) {
    const subj = (e.subject || '').replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim();
    if (!subj) continue;
    const sLower = subj.toLowerCase();
    const date = parseScheduledDateInSubject(subj) || new Date(e.receivedAt || e.received_at || 0).getTime() || 0;

    const isTest = /\bonline\s+test\b|\btest\b|\bassessment\b/i.test(sLower) && !sLower.includes('shortlist') && !sLower.includes('result');
    const isTest2 = /\btest\s*[-–]?\s*2\b|\bround\s+2\s+(?:online\s+)?test\b/i.test(sLower);
    const isPpt = /\bppt\b|pre[- ]*placement\s*talk/i.test(sLower);
    const isGd = /\bgroup\s+discussion\b|\bgd\b/i.test(sLower);
    const isInterview = /\binterview\b|\bnext\s+round\s+of\s+selection\b/i.test(sLower);

    if (isTest && !isTest2) {
      const existing = roundMap.get('test_1');
      if (!existing || (date > 0 && (existing.date === 0 || existing.date > date))) {
        roundMap.set('test_1', { id: 'test_1', label: 'Online Test', shortLabel: 'Test', roundType: 'test', date });
      }
    }
    if (isTest2) {
      const existing = roundMap.get('test_2');
      if (!existing || (date > 0 && (existing.date === 0 || existing.date > date))) {
        roundMap.set('test_2', { id: 'test_2', label: 'Test 2', shortLabel: 'Test 2', roundType: 'test', date });
      }
    }
    if (isPpt && isGd) {
      const existing = roundMap.get('ppt_gd');
      if (!existing || (date > 0 && (existing.date === 0 || existing.date > date))) {
        roundMap.set('ppt_gd', { id: 'ppt_gd', label: 'PPT & GD', shortLabel: 'PPT & GD', roundType: 'gd', date });
      }
    } else {
      if (isPpt && !roundMap.has('ppt_gd')) {
        const existing = roundMap.get('ppt');
        if (!existing || (date > 0 && (existing.date === 0 || existing.date > date))) {
          roundMap.set('ppt', { id: 'ppt', label: 'Pre-Placement Talk', shortLabel: 'PPT', roundType: 'ppt', date });
        }
      }
      if (isGd && !roundMap.has('ppt_gd')) {
        const existing = roundMap.get('gd');
        if (!existing || (date > 0 && (existing.date === 0 || existing.date > date))) {
          roundMap.set('gd', { id: 'gd', label: 'Group Discussion', shortLabel: 'GD', roundType: 'gd', date });
        }
      }
    }
    if (isInterview) {
      const existing = roundMap.get('interview');
      if (!existing || (date > 0 && (existing.date === 0 || existing.date > date))) {
        roundMap.set('interview', { id: 'interview_1', label: 'Interview', shortLabel: 'Interview', roundType: 'interview', date });
      }
    }
  }

  // If combined ppt_gd exists, omit redundant standalone ppt / gd
  if (roundMap.has('ppt_gd')) {
    roundMap.delete('ppt');
    roundMap.delete('gd');
  }

  const rawList = Array.from(roundMap.values());
  if (rawList.length < 2) {
    for (const e of emails) {
      const single = parseAnnouncedRoundsFromSubject(e.subject || '');
      if (single && single.length >= 2) return single;
    }
    return null;
  }

  // Determine chronological order between Test and PPT:
  // If Test date is strictly before PPT/GD date, Test is before PPT!
  // Otherwise, default to standard order (PPT -> Test -> GD -> Interview).
  const testRound = rawList.find(r => r.id === 'test_1');
  const pptRound = rawList.find(r => r.id === 'ppt' || r.id === 'ppt_gd');
  const isTestBeforePpt = Boolean(testRound && pptRound && testRound.date > 0 && pptRound.date > 0 && testRound.date < pptRound.date);

  const sorted = [...rawList].sort((a, b) => {
    if (isTestBeforePpt) {
      const orderA = a.id === 'test_1' ? 1 : a.id === 'test_2' ? 2 : a.id === 'ppt' || a.id === 'ppt_gd' ? 3 : a.id === 'gd' ? 4 : 5;
      const orderB = b.id === 'test_1' ? 1 : b.id === 'test_2' ? 2 : b.id === 'ppt' || b.id === 'ppt_gd' ? 3 : b.id === 'gd' ? 4 : 5;
      return orderA - orderB;
    }
    const orderA = a.id === 'ppt' ? 1 : a.id === 'test_1' ? 2 : a.id === 'test_2' ? 3 : a.id === 'ppt_gd' || a.id === 'gd' ? 4 : 5;
    const orderB = b.id === 'ppt' ? 1 : b.id === 'test_1' ? 2 : b.id === 'test_2' ? 3 : b.id === 'ppt_gd' || b.id === 'gd' ? 4 : 5;
    return orderA - orderB;
  });

  return sanitizeAnnouncedRounds(
    sorted.map((r) => ({
      id: r.id,
      label: r.label,
      shortLabel: r.shortLabel,
      roundType: r.roundType,
    }))
  );
}


