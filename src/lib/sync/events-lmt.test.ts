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
});
