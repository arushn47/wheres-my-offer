import { describe, expect, it } from 'vitest';
import {
  classifyShortlistEmail,
  extractExplicitPredecessor,
  getPredecessorRequirement,
  parseEliminationToken,
  buildEliminationToken,
  extractExplicitOrdinal,
  isRescheduleEmail,
  parseRecruitmentProcess,
  buildAnnouncedProcessToken,
  parseAnnouncedProcessToken,
  sanitizeAnnouncedRounds,
} from './round-identity';

// ---------------------------------------------------------------------------
// classifyShortlistEmail
// ---------------------------------------------------------------------------

describe('classifyShortlistEmail', () => {
  // Scenario A: basic test shortlist
  it('A: classifies test shortlist from subject', () => {
    expect(classifyShortlistEmail('Online Assessment Shortlist - Deloitte', '')).toBe('test');
  });

  // Scenario B: basic interview shortlist
  it('B: classifies interview shortlist from subject', () => {
    expect(classifyShortlistEmail('Interview Schedule - Technical Round', '')).toBe('interview');
  });

  // Scenario C: GD round — the Deloitte scenario
  it('C: classifies group discussion shortlist', () => {
    expect(classifyShortlistEmail(
      'Shortlist for Group Discussion and PPT - Deloitte India',
      'Students shortlisted for GD round are as follows'
    )).toBe('gd');
  });

  it('C2: classifies GD from body when subject is generic', () => {
    expect(classifyShortlistEmail(
      'Deloitte India - Next Round',
      'You are shortlisted for the Group Discussion round'
    )).toBe('gd');
  });

  // Scenario D: Round 2 test
  it('D: classifies round 2 assessment', () => {
    expect(classifyShortlistEmail('Round 2 Assessment - Shortlisted Candidates', '')).toBe('test_r2');
  });

  // Scenario E: Round 2 interview
  it('E: classifies round 2 interview', () => {
    expect(classifyShortlistEmail('Second Round Interview Schedule', '')).toBe('interview_r2');
  });

  // Scenario F: final selection (no test/interview in subject)
  it('F: classifies final selection', () => {
    expect(classifyShortlistEmail('Final Selection List - Deloitte', '')).toBe('selected');
  });

  // Scenario G: PPT shortlist (rare)
  it('G: classifies PPT shortlist', () => {
    expect(classifyShortlistEmail(
      'Shortlisted Candidates for Pre-Placement Talk',
      'The following candidates are shortlisted for PPT'
    )).toBe('ppt');
  });

  // Ambiguous — should return null
  it('returns null for completely ambiguous emails', () => {
    expect(classifyShortlistEmail('Results Announced', 'Please check the portal')).toBeNull();
  });

  // Must NOT classify final selection when subject also mentions interview
  it('does not misclassify interview shortlist as selected', () => {
    expect(classifyShortlistEmail('Technical Interview Final Round - Deloitte', '')).toBe('interview');
  });
});

// ---------------------------------------------------------------------------
// extractExplicitPredecessor
// ---------------------------------------------------------------------------

describe('extractExplicitPredecessor', () => {
  it('extracts any_test when email says "students who cleared the online assessment"', () => {
    expect(extractExplicitPredecessor(
      'GD Shortlist',
      'Candidates who have cleared the online assessment are shortlisted for the GD round.'
    )).toBe('any_test');
  });

  it('extracts test_r2 when email says "cleared round 2"', () => {
    expect(extractExplicitPredecessor(
      'Round 2 Shortlist',
      'Students who cleared round 2 of the test are shortlisted for interview.'
    )).toBe('test_r2');
  });

  it('extracts interview_r1 when email says "cleared the first interview"', () => {
    expect(extractExplicitPredecessor(
      'Round 2 Interview',
      'Students who cleared the first interview are invited for the second round.'
    )).toBe('interview_r1');
  });

  it('returns null when no predecessor claim is present', () => {
    expect(extractExplicitPredecessor('Interview Shortlist', 'Please attend the interview')).toBeNull();
  });

  it('returns null for test shortlist (no predecessor needed)', () => {
    expect(extractExplicitPredecessor('Online Assessment Link', 'Your test link: ...')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getPredecessorRequirement
// ---------------------------------------------------------------------------

describe('getPredecessorRequirement', () => {
  // Scenario H: Test round with no prior — no predecessor needed
  it('H: test announcement with no predecessor requires empty list', () => {
    const result = getPredecessorRequirement('test', null);
    expect(result).toEqual([]);
  });

  // Scenario I: test_r2 inherently requires test
  it('I: test_r2 always requires test match', () => {
    const result = getPredecessorRequirement('test_r2', null);
    expect(result).toEqual(['test']);
  });

  // Scenario J: interview_r2 requires interview (not test alone)
  it('J: interview_r2 requires interview match, test alone is insufficient', () => {
    const result = getPredecessorRequirement('interview_r2', null);
    expect(result).toEqual(['interview']);
  });

  // GD with explicit test predecessor
  it('GD with explicit any_test predecessor requires test or test_r2', () => {
    const result = getPredecessorRequirement('gd', 'any_test');
    expect(result).toEqual(['test', 'test_r2']);
  });

  // GD with no explicit predecessor → conservative null
  it('GD with no explicit predecessor returns null (conservative)', () => {
    const result = getPredecessorRequirement('gd', null);
    expect(result).toBeNull();
  });

  // Interview with no explicit predecessor → conservative null
  it('interview with no explicit predecessor returns null (conservative)', () => {
    const result = getPredecessorRequirement('interview', null);
    expect(result).toBeNull();
  });

  // Interview with explicit test predecessor
  it('interview with explicit any_test predecessor requires test or test_r2', () => {
    const result = getPredecessorRequirement('interview', 'any_test');
    expect(result).toEqual(['test', 'test_r2']);
  });

  // Selected always requires interview
  it('selected always requires interview match', () => {
    const result = getPredecessorRequirement('selected', null);
    expect(result).toEqual(['interview', 'interview_r2']);
  });

  // Null announced round → null (ambiguous)
  it('null announced round returns null', () => {
    expect(getPredecessorRequirement(null, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseEliminationToken + buildEliminationToken
// ---------------------------------------------------------------------------

describe('buildEliminationToken + parseEliminationToken', () => {
  it('round-trips test elimination token', () => {
    const notes = `vellore\n${buildEliminationToken('test')}`;
    const result = parseEliminationToken(notes);
    expect(result.roundType).toBe('test');
    expect(result.label).toBe('Eliminated in Test Round');
  });

  it('round-trips gd elimination token', () => {
    const notes = `vellore\n${buildEliminationToken('gd')}`;
    const result = parseEliminationToken(notes);
    expect(result.roundType).toBe('gd');
    expect(result.label).toBe('Eliminated in Group Discussion');
  });

  it('round-trips interview_r2 elimination token', () => {
    const notes = buildEliminationToken('interview_r2');
    const result = parseEliminationToken(notes);
    expect(result.roundType).toBe('interview_r2');
    expect(result.label).toBe('Eliminated in Round 2 Interview');
  });

  it('backward compat: recognises legacy freeform interview prose', () => {
    const result = parseEliminationToken('vellore\nInterviewed · Not Selected');
    expect(result.roundType).toBe('interview');
    expect(result.label).toBe('Interviewed · Not Selected');
  });

  it('backward compat: recognises legacy freeform test prose', () => {
    const result = parseEliminationToken('Eliminated in Test Round');
    expect(result.roundType).toBe('test');
  });

  it('returns null roundType for empty notes', () => {
    expect(parseEliminationToken(null)).toEqual({ roundType: null, label: '' });
    expect(parseEliminationToken('')).toEqual({ roundType: null, label: '' });
  });
});

// ---------------------------------------------------------------------------
// extractExplicitOrdinal
// ---------------------------------------------------------------------------

describe('extractExplicitOrdinal', () => {
  it('extracts round number from "Round 2 Assessment"', () => {
    const result = extractExplicitOrdinal('Round 2 Assessment - Shortlist', '');
    expect(result?.roundNumber).toBe(2);
  });

  it('extracts round number from "Technical Interview II"', () => {
    const result = extractExplicitOrdinal('Technical Interview II', '');
    expect(result?.roundNumber).toBe(2);
  });

  it('extracts round number from "Second Round of Interviews"', () => {
    const result = extractExplicitOrdinal('Second Round of Interviews', '');
    expect(result?.roundNumber).toBe(2);
  });

  it('returns null for a basic email with no ordinal', () => {
    const result = extractExplicitOrdinal('Online Assessment Link', 'Please complete by tonight');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isRescheduleEmail
// ---------------------------------------------------------------------------

describe('isRescheduleEmail', () => {
  it('detects rescheduled notice', () => {
    expect(isRescheduleEmail('Deloitte Assessment Rescheduled', '')).toBe(true);
  });

  it('does not flag a normal email as reschedule', () => {
    expect(isRescheduleEmail('Online Assessment Shortlist', '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseRecruitmentProcess (status pipeline stage derivation)
// ---------------------------------------------------------------------------

describe('parseRecruitmentProcess', () => {
  it('extracts clean round stage names instead of full event descriptions with dates/venues', () => {
    const emailText = `Date of Visit:
Test - 26th Sept 2026 (4 PM) @ VIT Vellore campus & others in respective campus venues
Physical Interview 31 august - Will be announced later`;

    const rounds = parseRecruitmentProcess(emailText);
    expect(rounds).not.toBeNull();
    expect(rounds).toHaveLength(2);

    // Round 1 should be clean "Test" — NOT the full date and venue description!
    expect(rounds![0]).toEqual(
      expect.objectContaining({
        id: 'test_1',
        label: 'Test',
        shortLabel: 'Test',
        roundType: 'test',
        dateStr: '26th Sept 2026',
      })
    );

    // Round 2 should be clean "Interview" — NOT "Physical Interview 31 august - Will be announced later"!
    expect(rounds![1]).toEqual(
      expect.objectContaining({
        id: 'interview_1',
        label: 'Interview',
        shortLabel: 'Interview',
        roundType: 'interview',
        dateStr: '31 august',
      })
    );
  });

  it('numbers multiple tests and interviews sequentially (e.g. Test 1, Test 2, Game Round, Interview)', () => {
    const text = `Recruitment Process:
- Test 1 (Online)
- Test 2 (in campus)
- Game Round
- Interview`;

    const rounds = parseRecruitmentProcess(text);
    expect(rounds).not.toBeNull();
    expect(rounds!.map(r => ({ id: r.id, label: r.label, shortLabel: r.shortLabel }))).toEqual([
      { id: 'test_1', label: 'Test 1', shortLabel: 'Test 1' },
      { id: 'test_2', label: 'Test 2', shortLabel: 'Test 2' },
      { id: 'game_round', label: 'Game Round', shortLabel: 'Game Round' },
      { id: 'interview_1', label: 'Interview', shortLabel: 'Interview' },
    ]);
  });

  it('handles PPT, Test, GD, and multiple interviews', () => {
    const text = `Selection Process:
1. Pre-Placement Talk
2. Online Test
3. Group Discussion
4. Technical Interview
5. HR Interview`;

    const rounds = parseRecruitmentProcess(text);
    expect(rounds).not.toBeNull();
    expect(rounds!.map(r => r.shortLabel)).toEqual([
      'PPT',
      'Test',
      'GD',
      'Interview 1',
      'Interview 2',
    ]);
  });

  it('returns null if fewer than 2 rounds found', () => {
    const text = `Recruitment Process:
- Single Test only`;
    expect(parseRecruitmentProcess(text)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sanitizeAnnouncedRounds + parseAnnouncedProcessToken
// ---------------------------------------------------------------------------

describe('sanitizeAnnouncedRounds & parseAnnouncedProcessToken', () => {
  it('sanitizes legacy verbose tokens stored in application notes', () => {
    const legacyRounds = [
      {
        id: 'test_26th_sept_2026_1',
        label: 'Test - 26th Sept 2026 (4 PM) @ VIT Vellore campus & others in respective campus venues',
        shortLabel: 'Test - 26th Sept 2026 (4 PM) @ VIT Vellore campus & others in respective campus venues',
        roundType: 'test' as const,
        roundNumber: 1,
      },
      {
        id: 'physical_interview_31_august_2',
        label: 'Physical Interview 31 august - Will be announced later',
        shortLabel: 'Physical Interview 31 august - Will be announced later',
        roundType: 'interview' as const,
        roundNumber: 1,
      },
    ];

    const notes = buildAnnouncedProcessToken(legacyRounds);
    const parsed = parseAnnouncedProcessToken(notes);

    expect(parsed).not.toBeNull();
    expect(parsed![0].shortLabel).toBe('Test');
    expect(parsed![0].label).toBe('Test');
    expect(parsed![1].shortLabel).toBe('Interview');
    expect(parsed![1].label).toBe('Interview');
  });

  it('injects a Test round between PPT and Interview when circular omitted test date (e.g. UBS, Chargebee, EY SAP)', () => {
    const text = `Date of Visit:
*Pre-placement talk:* 29-September-26; 4:00 PM to 5:00 PM
*Interview:* 6-October-26; 10:00 AM onwards`;

    const rounds = parseRecruitmentProcess(text);
    expect(rounds).not.toBeNull();
    expect(rounds!.map(r => r.shortLabel)).toEqual(['PPT', 'Test', 'Interview']);
    expect(rounds![1].roundType).toBe('test');
  });

  it('sanitizes legacy notes that only had PPT and Interview by injecting Test round', () => {
    const legacyRounds = [
      { id: 'ppt_1', label: 'Pre-Placement Talk', shortLabel: 'PPT', roundType: 'ppt' as const },
      { id: 'interview_1', label: 'Interview', shortLabel: 'Interview', roundType: 'interview' as const },
    ];
    const notes = buildAnnouncedProcessToken(legacyRounds);
    const parsed = parseAnnouncedProcessToken(notes);

    expect(parsed).not.toBeNull();
    expect(parsed!.map(r => r.shortLabel)).toEqual(['PPT', 'Test', 'Interview']);
  });
});


