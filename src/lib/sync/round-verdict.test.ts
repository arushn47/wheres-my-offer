import { describe, expect, it } from 'vitest';
import { resolveRoundVerdicts, statusForRoundVerdict, canonicalRosterKey, roundEventNumbers, type RoundEvidence } from './round-verdict';
import { buildCandidateIdentity, getStrongIdentityTokens, matchesCandidateRow, matchesCandidateText } from './user-identity';
import { evaluateCachedShortlistRosters } from './shortlist-verification';
import { extractVenue, parseDateTimeWithConfidence, extractEvents, parseExplicitEndTime } from './events';
import { extractScopedEvents } from './scoped-events';
import { classifyEmail } from './classifier';
import type { ParsedEmail } from '@/lib/gmail/client';

const identity = buildCandidateIdentity({ neoId: 'A7X9K3Q1', name: 'Sample Singh', collegeEmail: 'sample.23bce10001@vitbhopal.ac.in', personalEmail: 'sample@example.com' });
const tokens = getStrongIdentityTokens(identity);
function roster(id: string, subject: string, at: string, present: boolean, body = ''): RoundEvidence {
  return { emailId: id, subject, body, receivedAt: at, rosters: [{ filename: 'shortlist.xlsx', parseStatus: 'complete', extractedRows: [{ sheetName: 'Shortlist', rows: [['Neo ID'], [present ? identity.neoId : 'OTHER123']] }] }] };
}
function email(subject: string, body: string): ParsedEmail {
  return { gmailMessageId: 'message', threadId: null, sender: 'Placement Office', senderEmail: 'placementoffice@vitbhopal.ac.in', subject, receivedAt: new Date('2026-10-06T10:00:00Z'), bodyPlain: body, bodySnippet: body, bodyHtml: '', hasAttachments: false, attachments: [], labels: [] };
}

describe('round-specific shortlist decisions', () => {
  it('does not promote a game-round match to a later test excluded by List 1', () => {
    const verdicts = resolveRoundVerdicts([
      roster('game', 'Shortlist for game round', '2026-10-05T06:00:00Z', true),
      roster('test2', 'Next online test on 7th October 2026', '2026-10-06T10:00:00Z', false, 'Please find the shortlisted students (List 1).'),
    ], tokens);
    expect(verdicts[0].roundType).toBe('game');
    expect(verdicts[0].eligible).toBe(true);
    expect(verdicts[1]).toMatchObject({ eligible: false, finalNegative: false, reason: 'partial_list_absence' });
    expect(statusForRoundVerdict(verdicts[1], 'test_scheduled')).toBe('not_shortlisted');
  });

  it('keeps date-scoped later test events distinct from an explicit Test 1', () => {
    const verdicts=resolveRoundVerdicts([roster('one','Test 1 shortlist','2026-10-01T00:00:00Z',true),roster('two','Online test on 7 October 2026','2026-10-06T00:00:00Z',true)],tokens);
    const numbers=roundEventNumbers(verdicts);
    expect(numbers.get('test:1')).toBe(1);expect(numbers.get('test:2026-10-07')).toBe(2);
  });

  it('converges in reversed order and through repeated replay', () => {
    const evidence = [roster('one', 'Test 1 shortlist', '2026-10-01T00:00:00Z', true), roster('two', 'Test 2 shortlist', '2026-10-06T00:00:00Z', false)];
    expect(resolveRoundVerdicts(evidence, tokens)).toEqual(resolveRoundVerdicts([...evidence].reverse(), tokens));
    expect(resolveRoundVerdicts(evidence, tokens).at(-1)).toMatchObject({ eligible: false, finalNegative: true });
  });

  it('does not create a new decision from a quoted reply', () => {
    const original = { emailId: 'one', subject: 'Shortlist for game round', body: 'https://docs.google.com/spreadsheets/d/e/example/pubhtml', receivedAt: '2026-10-05T00:00:00Z', rosters: [], directMatch: true };
    expect(resolveRoundVerdicts([original, { ...original, emailId: 'reply', subject: 'Re: Shortlist for game round', body: 'Reminder\n> Shortlist for game round', receivedAt: '2026-10-06T00:00:00Z' }], tokens)).toHaveLength(1);
  });

  it('deduplicates attachment copies by actual content, not filename or size', () => {
    const one = roster('one', 'Test 2 shortlist', '2026-10-06T00:00:00Z', true);
    expect(canonicalRosterKey(one)).toBe(canonicalRosterKey({ ...one, emailId: 'forward' }));
    expect(canonicalRosterKey(one)).not.toBe(canonicalRosterKey(roster('two', 'Test 2 shortlist', one.receivedAt, false)));
  });

  it('revised roster replaces an earlier positive, while a supplementary list can add a candidate', () => {
    const one = roster('one', 'Test 2 shortlist', '2026-10-01T00:00:00Z', true);
    const revised = roster('two', 'Revised Test 2 shortlist', '2026-10-02T00:00:00Z', false);
    expect(resolveRoundVerdicts([one, revised], tokens).at(-1)?.eligible).toBe(false);
    const supplementary = roster('three', 'Test 2 supplementary shortlist', '2026-10-03T00:00:00Z', true);
    expect(resolveRoundVerdicts([one, revised, supplementary], tokens).at(-1)?.eligible).toBe(true);
  });

  it('leaves failed and missing rosters pending and honors manual overrides', () => {
    const item = roster('one', 'Test 2 shortlist', '2026-10-06T00:00:00Z', false);
    item.rosters[0].parseStatus = 'error';
    const decision = resolveRoundVerdicts([item], tokens)[0];
    expect(decision).toMatchObject({ state: 'deferred', eligible: false, finalNegative: false });
    expect(statusForRoundVerdict(decision, 'selected', true)).toBe('selected');
  });
});

describe('safe roster identity and purpose', () => {
  it('matches any known account but refuses common-name and fuzzy-ID positives', () => {
    expect(matchesCandidateRow(['sample.23bce10001@vitbhopal.ac.in'], identity).matched).toBe(true);
    expect(matchesCandidateRow(['Sample', 'Singh'], identity).matched).toBe(false);
    expect(matchesCandidateText('Sample Singh', identity).matched).toBe(false);
    expect(matchesCandidateText('A7X9K3QI', identity).matched).toBe(false);
  });
  it('does not collapse distinct email punctuation', () => {
    const evaluation = evaluateCachedShortlistRosters({ shortlistContext: true, identityTokens: ['first.last@example.com'], rosters: [{ filename: 'shortlist.xlsx', parseStatus: 'complete', extractedRows: [{ sheetName: 'Sheet1', rows: [['firstlast@example.com']] }] }] });
    expect(evaluation.state).toBe('verified_absent');
  });
  it.each(['Applied', 'Eligible', 'Waitlist', 'Rejected'])('does not treat a %s tab as a shortlist', (sheetName) => {
    const item = roster('one', 'Test shortlist', '2026-10-06T00:00:00Z', true);
    item.rosters[0].extractedRows![0].sheetName = sheetName;
    expect(evaluateCachedShortlistRosters({ rosters: item.rosters, shortlistContext: true, identityTokens: tokens }).state).toBe('deferred');
  });
  it('requires allocation when the roster has allocation columns', () => {
    const item = roster('one', 'Test shortlist', '2026-10-06T00:00:00Z', true);
    item.rosters[0].extractedRows![0].rows = [['Neo ID','Lab'],[identity.neoId, 'N/A']];
    expect(evaluateCachedShortlistRosters({ rosters: item.rosters, shortlistContext: true, identityTokens: tokens }).state).toBe('verified_absent');
  });
});

describe('incident extraction regressions', () => {
  it('preserves an established date for a time-only revision of the same round', () => {
    expect(parseDateTimeWithConfidence('Test 2: 11 AM', new Date('2026-10-06T12:00:00Z'), new Date('2026-10-07T04:30:00Z')).date?.toISOString()).toBe('2026-10-07T05:30:00.000Z');
  });
  it('does not mistake a Time label for the end of a window', () => {
    expect(parseExplicitEndTime('Test 1: 7 PM. Time - 7:00 PM',new Date('2026-10-01T13:30:00Z'))).toBeNull();
    const invitation=email('Applied candidates', 'Test 1: 7:00 PM\n\nFresh link for test today\nLink: https://tests.mettl.com/example\nTime - 7:00 PM');
    const event=extractEvents(invitation).find(event=>event.eventType==='online_test')!;
    expect(event.endTime!.getTime()-event.startTime!.getTime()).toBe(2*60*60*1000);
  });
  it('anchors today to the Indian calendar date at UTC midnight boundaries', () => {
    expect(parseDateTimeWithConfidence('Test today at 9 AM',new Date('2026-10-05T20:00:00Z')).date?.toISOString()).toBe('2026-10-06T03:30:00.000Z');
  });
  it('does not turn elapsed invitations into confirmed attendance', async () => {
    const {getEffectiveStage}=await import('@/lib/stages');
    const event={event_type:'online_test',start_time:new Date(Date.now()-86400000),end_time:new Date(Date.now()-80000000)};
    expect(getEffectiveStage('test_scheduled',null,[event]).isTestCompleted).toBe(false);
  });
  it('recognizes an explicit personal selection or rejection after earlier rounds', () => {
    const positive={...roster('offer','Offer letter','2026-10-06T00:00:00Z',false),rosters:[],outcome:'selected' as const};
    const negative={...positive,emailId:'negative',outcome:'rejected' as const};
    expect(statusForRoundVerdict(resolveRoundVerdicts([positive],tokens)[0],'applied')).toBe('selected');
    expect(statusForRoundVerdict(resolveRoundVerdicts([negative],tokens)[0],'applied')).toBe('not_shortlisted');
  });
  it('does not treat an unrelated spreadsheet as a published shortlist', () => {
    const item=roster('compensation','Company compensation information','2026-10-06T00:00:00Z',false);
    item.rosters[0].filename='compensation.xlsx';
    expect(resolveRoundVerdicts([item],tokens)).toEqual([]);
  });
  it('honors the negated own-location instruction', () => {
    expect(extractVenue('Lseg students can skip axxela own location concept is not there')).toBe('Respective CDC Labs');
    expect(extractVenue('LC 102. Own location is not allowed')).toBe('LC 102');
  });
  it('assigns Schneider PPT only to Schneider in a mixed-company circular', () => {
    const message = email('Axxela next round and Schneider virtual students', 'Schneider virtual students can come at 8.30 am tomorrow for PPT\n\nAxxela gamified assessment round will be there tomorrow.');
    expect(extractScopedEvents(message, 'Axxela Research & Analytics', ['Schneider Electric']).some((event) => event.eventType === 'ppt')).toBe(false);
    expect(extractScopedEvents(message, 'Schneider Electric', ['Axxela Research & Analytics']).some((event) => event.eventType === 'ppt')).toBe(true);
  });
  it('never assigns the received-day date to a time-only revision', () => {
    expect(parseDateTimeWithConfidence('Test 1: 7 PM', new Date('2026-10-06T10:00:00Z')).date).toBeNull();
  });
  it('extracts a numeric registration deadline across table-like blank lines', () => {
    const message = email('Axxela internship', 'Last date for Registration\n\n29.09.2026 (6 pm)');
    expect(extractEvents(message).find((event) => event.eventType === 'registration_deadline')?.startTime?.toISOString()).toBe('2026-09-29T12:30:00.000Z');
  });
  it('does not classify reminder replies by a quoted shortlist', () => {
    expect(classifyEmail(email('Re: Axxela campus communication', 'Reminder\n\nOn Mon, 5 Oct, 2026, at 1:00 pm Office wrote:\n> Shortlist for game round')).classification).not.toBe('shortlist');
  });
});
