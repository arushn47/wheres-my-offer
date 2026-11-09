/**
 * Regression tests for classifier.ts — pipeline guards (Bug C)
 *
 * Bug C: "Tech Mahindra - Online test completed - Update" was classified as
 * 'test' (active test invitation) instead of a past/completed notice.
 * Fix: Added negative check for completion words (completed, concluded, etc.)
 * in the 'test' classification rule.
 *
 * Also guards:
 *  - Registration deadline → never 'test'
 *  - Shortlist email → never 'test_completed'
 *  - Test invitation ≠ test completion evidence
 *  - Forwarded duplicate → same classification, no escalation
 *  - Capgemini registration deadline → 'registration', never 'test'
 */
import { describe, it, expect } from 'vitest';
import { classifyEmail } from './sync/classification/classifier';
import type { ParsedEmail } from './gmail/client';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeEmail(subject: string, bodyText = ''): ParsedEmail {
  return {
    gmailMessageId: 'test-msg-1',
    threadId: 'test-thread-1',
    subject,
    sender: 'CDC <noreply.cdcinfo@vitstudent.ac.in>',
    senderEmail: 'noreply.cdcinfo@vitstudent.ac.in',
    receivedAt: new Date(),
    bodyPlain: bodyText,
    bodyHtml: `<p>${bodyText}</p>`,
    bodySnippet: bodyText.slice(0, 150),
    hasAttachments: false,
    attachments: [],
    labels: ['INBOX'],
  };
}

function classify(subject: string, body = '') {
  return classifyEmail(makeEmail(subject, body));
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('classifier pipeline guards (Bug C regression)', () => {

  describe('Completion/past-tense subjects must NOT be classified as active test', () => {
    it('REGRESSION: "Online test completed" → not "test" classification', () => {
      const result = classify('Tech Mahindra - Online test completed - Update');
      expect(result.classification).not.toBe('test');
    });

    it('"Online test concluded" → not "test"', () => {
      const result = classify('Company XYZ - Online test concluded');
      expect(result.classification).not.toBe('test');
    });

    it('"Assessment finished" → not "test"', () => {
      const result = classify('Assessment finished - Next steps');
      expect(result.classification).not.toBe('test');
    });

    it('"Online test ended" → not "test"', () => {
      const result = classify('Company ABC - Online test ended for 2027 batch');
      expect(result.classification).not.toBe('test');
    });
  });

  describe('Registration deadline must never be classified as test', () => {
    it('Capgemini Exceller registration deadline → "registration"', () => {
      const result = classify(
        'Capgemini Exceller: Registration Deadline: Superset portal 8th November 2026',
        'Students are requested to complete their registration on the Superset portal before 8th November 2026.',
      );
      expect(result.classification).toBe('registration');
      expect(result.classification).not.toBe('test');
      expect(result.classification).not.toBe('test_completed');
    });

    it('Generic registration deadline subject → "registration"', () => {
      const result = classify(
        'Company XYZ - Registration Deadline: 15 November 2026',
        'Last date to register on the NeoPAT portal is 15th November 2026.',
      );
      expect(result.classification).toBe('registration');
    });
  });

  describe('Shortlist emails must never be classified as test_completed', () => {
    it('Shortlist announcement → "shortlist", not "test_completed"', () => {
      const result = classify(
        'Company XYZ - Shortlisted Candidates for Online Test',
        'The following students have been shortlisted for the online assessment.',
      );
      expect(result.classification).toBe('shortlist');
      expect(result.classification).not.toBe('test_completed');
    });

    it('Shortlist email does not prove user completed a test', () => {
      const result = classify(
        'Goldman Sachs - Shortlist for Online Assessment',
        'Shortlisted students for the upcoming assessment are listed below.',
      );
      expect(result.classification).not.toBe('test_completed');
      expect(result.classification).not.toBe('test');
    });
  });

  describe('Test invitation ≠ test completion', () => {
    it('Active online test invite → "test"', () => {
      const result = classify(
        'Company XYZ - Online Test Scheduled',
        'Please complete the online assessment at mettl.com/authenticateKey/xyz by tomorrow.',
      );
      expect(result.classification).toBe('test');
    });

    it('"Thanks for taking the assessment" → not test_completed classification', () => {
      const result = classify('Thanks for taking the Assessment - Company XYZ');
      expect(['test', 'registration', 'unclassified_placement_notice'].includes(result.classification)).toBe(true);
    });
  });

  describe('Forwarded duplicates get same base classification', () => {
    it('Forwarded registration circular → not "test"', () => {
      const result = classify(
        'Fwd: Company XYZ - Registration Deadline - 2027 Batch',
        '---------- Forwarded message ---------\nCompany XYZ is visiting campus. Register on NeoPAT portal.',
      );
      expect(result.classification).not.toBe('test');
      expect(result.classification).not.toBe('interview');
    });
  });

  describe('Active test invitations (true positive guard after fix)', () => {
    it('Online assessment link in body → "test" (completion-word fix must not break this)', () => {
      const result = classify(
        'Company XYZ Applied Students - Online Assessment',
        'Dear students, please attend the online assessment at mettl.com/authenticateKey/xyz',
      );
      expect(result.classification).toBe('test');
    });

    it('Test schedule with time → "test"', () => {
      const result = classify(
        'Company XYZ - Online Test Schedule',
        'Test 1: 10:00 AM to 12:00 PM on 20th November 2026 at mettl.com',
      );
      expect(result.classification).toBe('test');
    });

    it('Applied students online assessment link → "test"', () => {
      const result = classify(
        'Company XYZ Applied Students - Online Test',
        'Please attempt the test at mettl.com/authenticateKey/abc before 11 PM today.',
      );
      expect(result.classification).toBe('test');
    });
  });
});
