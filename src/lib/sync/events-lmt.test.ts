import { describe, expect, it } from 'vitest';
import {
  extractCompanyName,
  classifyEmail,
  checkAcronymMatch,
  extractCompanyAliases,
  normalizeCompanyName,
  cleanCompanyName,
} from './classifier';
import { isFuzzyCompanyMatch } from './engine';
import { extractEvents, extractVenue, parseExplicitEndTime } from './events';
import { stripQuotedContent } from './body';

describe('typo-tolerant company matching', () => {
  it('matches CDC brand typos like "Goldamnsachs" vs "Goldman Sachs"', () => {
    expect(isFuzzyCompanyMatch('Goldman Sachs', 'Goldamnsachs')).toBe(true);
    expect(isFuzzyCompanyMatch('Goldman Sachs', 'goldmansachs')).toBe(true);
    expect(isFuzzyCompanyMatch('Deloitte', 'Deliotte')).toBe(true);
  });

  it('still rejects unrelated companies that share a short prefix', () => {
    expect(isFuzzyCompanyMatch('Goldman Sachs', 'Goldmedal')).toBe(false);
    expect(isFuzzyCompanyMatch('Deloitte', 'Delhivery')).toBe(false);
    expect(isFuzzyCompanyMatch('Infosys', 'Infomedia')).toBe(false);
  });

  it('keeps track-token and EY guards intact', () => {
    expect(isFuzzyCompanyMatch('EY GDS', 'EY')).toBe(false);
    expect(isFuzzyCompanyMatch('Deloitte SDET', 'Deloitte')).toBe(false);
  });
});

describe('LMT / LTIMindtree tests', () => {
  it('extracts LTIMindtree from placement subjects with Registration and Regular Offer', () => {
    expect(
      extractCompanyName(
        'LTIMindtree Registration - Regular Offer - 2027 Batch',
        'vitlions2027@vitbhopal.ac.in'
      )
    ).toBe('LTIMindtree');

    expect(
      extractCompanyName(
        'LTI Mindtree Registration - Regular Offer - 2027 Batch',
        'vitlions2027@vitbhopal.ac.in'
      )
    ).toBe('LTI Mindtree');

    expect(
      extractCompanyName(
        'LMT Registration - Regular Offer - 2027 Batch',
        'vitlions2027@vitbhopal.ac.in'
      )
    ).toBe('LMT');

    expect(
      extractCompanyName(
        'LTIMindtree Registration',
        'vitlions2027@vitbhopal.ac.in'
      )
    ).toBe('LTIMindtree');

    expect(
      extractCompanyName(
        'LTIMindtree - Regular Offer - 2027 Batch',
        'vitlions2027@vitbhopal.ac.in'
      )
    ).toBe('LTIMindtree');
  });

  it('extracts LMT from NeoPAT body with Drive Name: LMT', () => {
    const body = 'Dear Student, Placement Drive Date Update ... Drive Name: LMT Drive Number: pat-PL-2026-1108';
    expect(
      extractCompanyName(
        'Placement Drive Date Update',
        'noreply.cdcinfo@vitstudent.ac.in',
        body
      )
    ).toBe('LMT');
  });

  it('checks acronym and fuzzy match between LMT and LTIMindtree in both directions', () => {
    expect(checkAcronymMatch('lmt', 'ltimindtree')).toBe(true);
    expect(checkAcronymMatch('lmt', 'lti mindtree')).toBe(true);
    expect(checkAcronymMatch('lmt', 'lti mind tree')).toBe(true);

    expect(isFuzzyCompanyMatch('LMT', 'LTIMindtree')).toBe(true);
    expect(isFuzzyCompanyMatch('LTIMindtree', 'LMT')).toBe(true);
    expect(isFuzzyCompanyMatch('LMT', 'LTI Mindtree')).toBe(true);
    expect(isFuzzyCompanyMatch('LTI Mindtree', 'LMT')).toBe(true);
    expect(isFuzzyCompanyMatch('LMT', 'LTI MIND TREE')).toBe(true);
  });

  it('generates bidirectional aliases for LMT and LTIMindtree', () => {
    const lmtAliases = extractCompanyAliases('LMT', 'LMT');
    expect(lmtAliases).toContain('lmt');
    expect(lmtAliases).toContain('ltimindtree');
    expect(lmtAliases).toContain('lti mindtree');
    expect(lmtAliases).toContain('lti mind tree');

    const ltiMindtreeAliases = extractCompanyAliases('LTIMindtree', 'LTIMindtree');
    expect(ltiMindtreeAliases).toContain('lmt');
    expect(ltiMindtreeAliases).toContain('ltimindtree');
    expect(ltiMindtreeAliases).toContain('lti mindtree');
  });

  it('normalizes brand casing correctly', () => {
    expect(normalizeCompanyName('LTIMindtree')).toBe('LTIMindtree');
    expect(normalizeCompanyName('ltimindtree')).toBe('LTIMindtree');
    expect(normalizeCompanyName('LMT')).toBe('LMT');
    expect(normalizeCompanyName('lmt')).toBe('LMT');
    expect(normalizeCompanyName('LTI')).toBe('LTI');
    expect(normalizeCompanyName('Mindtree')).toBe('Mindtree');
    expect(normalizeCompanyName('PharmaAce')).toBe('PharmaAce');
    expect(normalizeCompanyName('pharmaace')).toBe('PharmaAce');
    expect(normalizeCompanyName('MyGate')).toBe('MyGate');
    expect(normalizeCompanyName('mygate')).toBe('MyGate');
    expect(normalizeCompanyName('McKinsey')).toBe('McKinsey');
    expect(normalizeCompanyName('MakeMyTrip')).toBe('MakeMyTrip');
  });

  it('cleans company name noise properly', () => {
    expect(cleanCompanyName('LTIMindtree Registration - Regular Offer - 2027 Batch')).toBe('LTIMindtree');
    expect(cleanCompanyName('LTIMindtree Registration')).toBe('LTIMindtree');
  });

  it('classifies the email accurately', () => {
    const classified = classifyEmail({
      gmailMessageId: 'msg-123',
      threadId: 'th-123',
      sender: 'CDC Office <vitlions2027@vitbhopal.ac.in>',
      senderEmail: 'vitlions2027@vitbhopal.ac.in',
      subject: 'LTIMindtree Registration - Regular Offer - 2027 Batch',
      bodyPlain: 'Please register for LTIMindtree placement drive.',
      bodyHtml: '<p>Please register for LTIMindtree placement drive.</p>',
      bodySnippet: 'Please register for LTIMindtree placement drive.',
      receivedAt: new Date(),
      hasAttachments: false,
      attachments: [],
      labels: [],
    });

    expect(classified.classification).toBe('registration');
    expect(classified.companyName).toBe('LTIMindtree');
  });

  it('strips multiline and wrapped Gmail reply attributions in stripQuotedContent', () => {
    const replyBody = `Dear Lions and Lionesses

I will be in LC till the last person completes the test.

On Sun, Oct 4, 2026 at 12:45 PM Placement Office <
placementoffice@vitbhopal.ac.in> wrote:

> Dear Lions and Lionesses
> The difficulty level increases as the day progresses.`;

    const stripped = stripQuotedContent(replyBody);
    expect(stripped).toContain('I will be in LC till the last person completes the test.');
    expect(stripped).not.toContain('12:45');
    expect(stripped).not.toContain('placementoffice@vitbhopal.ac.in');
  });

  it('ensures extractVenue rejects email domains and extracts Own Location', () => {
    const textWithEmailOnly = 'From: Placement Office <placementoffice@vitbhopal.ac.in>';
    expect(extractVenue(textWithEmailOnly)).toBeNull();

    const officialText = 'LTM Online test is scheduled on October 04, 2026 - Virtual Mode @ Own location\nSender: vitlions2027@vitbhopal.ac.in';
    expect(extractVenue(officialText)).toBe('Own Location');
  });

  it('parses 24-hour open window end time with embedded date in parseExplicitEndTime', () => {
    const windowText = 'Link will be active from October 04, 2026, from 00:01 Hours to October 4, 2026, 23:59 Hours (Test link will remain open for continuous 24 hours)';
    const startDate = new Date('2026-10-03T18:31:00.000Z'); // 00:01 IST on Oct 4
    const endTime = parseExplicitEndTime(windowText, startDate);

    expect(endTime).not.toBeNull();
    // 23:59 IST on Oct 4 is 18:29 UTC on Oct 4
    expect(endTime?.toISOString()).toBe('2026-10-04T18:29:00.000Z');
  });

  it('extracts full 24-hour window and Own Location venue from official LTM test email', () => {
    const officialEmail = {
      gmailMessageId: 'ltm-official-1',
      threadId: 'th-ltm-1',
      sender: "'No Reply CDC Info' via Students 2027 passout batch <vitlions2027@vitbhopal.ac.in>",
      senderEmail: 'vitlions2027@vitbhopal.ac.in',
      subject: 'LTM Online test is scheduled on October 04, 2026, from 00:01 Hours to October 4, 2026, 23:59 Hours (Test link will remain open for continuous 24 hours) - Virtual Mode @ Own location',
      bodyPlain: `LTM Online test is scheduled on October 04, 2026, from 00:01 Hours to October 4, 2026, 23:59 Hours (Test link will remain open for continuous 24 hours) - Virtual Mode @ Own location

Find the below attached shortlist.

All the shortlisted candidates are informed to take the Open Window assessment on (October 04, 2026, from 00:01 Hours to October 4, 2026, 23:59 Hour) without fail.

Schedule of Assessment:

1. Date: October 4, 2026 (Sunday)
2. Test Window: Link will be active from October 04, 2026, from 00:01 Hours to October 4, 2026, 23:59 Hours (Test link will remain open for continuous 24 hours)
3. Test Composition: Logical, Quantitative & Analytical Ability; Computer Science; English Comprehension; Spoken English
4. Test Duration: 110 Minutes`,
      bodyHtml: '',
      bodySnippet: 'LTM Online test is scheduled on October 04, 2026...',
      receivedAt: new Date('2026-10-03T06:00:00.000Z'),
      hasAttachments: true,
      attachments: [],
      labels: [],
    };

    const events = extractEvents(officialEmail as any);
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe('online_test');
    expect(events[0].title).toBe('Online Assessment');
    expect(events[0].startTime?.toISOString()).toBe('2026-10-03T18:31:00.000Z'); // 00:01 IST
    expect(events[0].endTime?.toISOString()).toBe('2026-10-04T18:29:00.000Z');   // 23:59 IST
    expect(events[0].venue).toBe('Own Location');
    expect(events[0].mode).toBe('online');
  });

  it('does not extract bogus assessment events from informal follow-up reply email', () => {
    const replyEmail = {
      gmailMessageId: 'ltm-reply-1',
      threadId: 'th-ltm-1',
      sender: 'Placement Office <placementoffice@vitbhopal.ac.in>',
      senderEmail: 'placementoffice@vitbhopal.ac.in',
      subject: 'Re: LTM - round 1 - Sunday 4 Oct after 7 pm students',
      bodyPlain: `Dear Lions and Lionesses

I am ready and waiting. Hostelers can come till 11 pm Please fill the form
and show this mail to the Guards or Supervisors and come to LC. PAT
formals. Meet me when you come here. You can occupy any cabin in LC 101 or
LC 102 or LC 103 or LC 104 to ensure a peaceful environment.

I will be in LC till the last person completes the test.

Let us make wonderful memories together ma

On Sun, Oct 4, 2026 at 12:45 PM Placement Office <
placementoffice@vitbhopal.ac.in> wrote:

> Dear Lions and Lionesses
> The difficulty level increases as the day progresses.`,
      bodyHtml: '',
      bodySnippet: 'Dear Lions and Lionesses I am ready and waiting...',
      receivedAt: new Date('2026-10-04T14:05:37.000Z'),
      hasAttachments: false,
      attachments: [],
      labels: [],
    };

    const events = extractEvents(replyEmail as any);
    // Should NOT extract a bogus test event from "completes the test" or quoted 12:45 PM
    expect(events.filter((e) => ['online_test', 'coding_test'].includes(e.eventType)).length).toBe(0);
  });
});
