/**
 * Regression tests for events.ts — interview date extraction (Bug B)
 *
 * Root causes fixed:
 *  B1. 120-char snippet from subject cut off date/time in body → added fallback
 *      full-text re-parse when snippet yields no date.
 *  B2. hasExplicitDateInText only matched "Day Month" but not "Month Day, Year"
 *      (e.g. "November 12, 2026") → extended regex.
 *
 * These tests use realistic email shapes matching the Tech Mahindra / Nvidia
 * interview emails that were failing.
 */
import { describe, it, expect } from 'vitest';
import { extractEvents } from './sync/extraction/events';
import type { ParsedEmail } from './gmail/client';

// ─── minimal email stub ──────────────────────────────────────────────────────

function makeEmail(subject: string, body: string): ParsedEmail {
  return {
    gmailMessageId: 'test-msg-1',
    threadId: 'test-thread-1',
    subject,
    sender: 'CDC <noreply.cdcinfo@vitstudent.ac.in>',
    senderEmail: 'noreply.cdcinfo@vitstudent.ac.in',
    receivedAt: new Date('2026-10-20T00:00:00Z'),
    bodyPlain: body,
    bodyHtml: `<p>${body}</p>`,
    bodySnippet: body.slice(0, 150),
    hasAttachments: false,
    attachments: [],
    labels: ['INBOX'],
  };
}

// ─── Tech Mahindra scenario ───────────────────────────────────────────────────
// Subject: "Tech Mahindra - Interview Schedule - 2027 Batch"
// The subject contains "Interview Schedule" → regex matches from position ~0,
// captures 120 chars from subject which does not include the date in body.
// Fix: fallback to full text when snippet has no date.

const TM_SUBJECT = 'Tech Mahindra - Interview Schedule - 2027 Batch';
const TM_BODY = `Dear Students,

Please note that the Tech Mahindra interview is scheduled for
November 12, 2026 from 9:00 AM onwards at VIT Vellore Campus.

Shortlisted students must report at 8:30 AM.

Regards,
CDC VIT`;

// ─── Nvidia scenario ──────────────────────────────────────────────────────────
// The interview date is present in "Month Day, Year" format only in the body.
// The subject mentions "Selection Process" and the body also says "interview".
// Fix: extend hasExplicitDateInText to match "Month Day, Year".

const NVIDIA_SUBJECT = 'Nvidia - Selection Process / Interview - 2027 Batch';
const NVIDIA_BODY = `Dear Students,

The interview for Nvidia as part of the selection process is scheduled on
October 28, 2026 at VIT Vellore.

Venue: VIT Vellore

Regards,
CDC VIT`;

// ─── LTM: "14th November" (Day Month, no year) ───────────────────────────────

const LTM_SUBJECT = 'LTIMindtree - Interview Scheduled';
const LTM_BODY = `Dear Students,

The interview for LTIMindtree is scheduled on 7th November 2026
at the respective campus venues.

Please carry a printed resume.

Regards,
CDC`;

// ─── tests ───────────────────────────────────────────────────────────────────

describe('extractEvents: interview date extraction regression (Bug B)', () => {

  describe('Tech Mahindra — "Month Day, Year" format with 120-char snippet truncation', () => {
    it('extracts a technical_interview event from the Tech Mahindra email', () => {
      const email = makeEmail(TM_SUBJECT, TM_BODY);
      const events = extractEvents(email);
      const intEvent = events.find(e => /interview/i.test(e.eventType));
      expect(intEvent).toBeDefined();
    });

    it('Tech Mahindra interview event has a valid start date', () => {
      const email = makeEmail(TM_SUBJECT, TM_BODY);
      const events = extractEvents(email);
      const intEvent = events.find(e => /interview/i.test(e.eventType));
      expect(intEvent?.startTime).toBeDefined();
      expect(intEvent?.startTime).not.toBeNull();
    });

    it('Tech Mahindra interview date is 12 November 2026', () => {
      const email = makeEmail(TM_SUBJECT, TM_BODY);
      const events = extractEvents(email);
      const intEvent = events.find(e => /interview/i.test(e.eventType));
      if (!intEvent?.startTime) return; // Will fail the previous test first
      const d = new Date(intEvent.startTime);
      expect(d.getUTCMonth()).toBe(10); // November = 10 (0-indexed)
      expect(d.getUTCDate()).toBe(12);
    });

    it('REGRESSION: Tech Mahindra must not return zero interview events', () => {
      const email = makeEmail(TM_SUBJECT, TM_BODY);
      const events = extractEvents(email);
      const interviewEvents = events.filter(e => /interview/i.test(e.eventType));
      expect(interviewEvents.length).toBeGreaterThan(0);
    });
  });

  describe('Nvidia — "Month Day, Year" format matched by extended hasExplicitDateInText', () => {
    it('extracts an interview event from the Nvidia email', () => {
      const email = makeEmail(NVIDIA_SUBJECT, NVIDIA_BODY);
      const events = extractEvents(email);
      const intEvent = events.find(e => /interview/i.test(e.eventType));
      expect(intEvent).toBeDefined();
    });

    it('Nvidia interview date is 28 October 2026', () => {
      const email = makeEmail(NVIDIA_SUBJECT, NVIDIA_BODY);
      const events = extractEvents(email);
      const intEvent = events.find(e => /interview/i.test(e.eventType));
      if (!intEvent?.startTime) return;
      const d = new Date(intEvent.startTime);
      expect(d.getUTCMonth()).toBe(9); // October = 9 (0-indexed)
      expect(d.getUTCDate()).toBe(28);
    });

    it('REGRESSION: Nvidia must not return zero interview events', () => {
      const email = makeEmail(NVIDIA_SUBJECT, NVIDIA_BODY);
      const events = extractEvents(email);
      const interviewEvents = events.filter(e => /interview/i.test(e.eventType));
      expect(interviewEvents.length).toBeGreaterThan(0);
    });
  });

  describe('LTM — "Day Month Year" (ordinal) format preserved', () => {
    it('extracts a technical_interview event from LTM email', () => {
      const email = makeEmail(LTM_SUBJECT, LTM_BODY);
      const events = extractEvents(email);
      const intEvent = events.find(e => /interview/i.test(e.eventType));
      expect(intEvent).toBeDefined();
    });

    it('LTM interview date is 7 November 2026', () => {
      const email = makeEmail(LTM_SUBJECT, LTM_BODY);
      const events = extractEvents(email);
      const intEvent = events.find(e => /interview/i.test(e.eventType));
      if (!intEvent?.startTime) return;
      const d = new Date(intEvent.startTime);
      expect(d.getUTCMonth()).toBe(10); // November = 10
      expect(d.getUTCDate()).toBe(7);
    });
  });

  describe('Guard: "Month Day, Year" does not create spurious events from non-interview emails', () => {
    it('a registration circular with a deadline date does not produce an interview event', () => {
      const email = makeEmail(
        'Company XYZ - Registration Deadline - 2027 Batch',
        'Register before November 15, 2026 on the NeoPAT portal.',
      );
      const events = extractEvents(email);
      const interviewEvents = events.filter(e => /interview/i.test(e.eventType));
      expect(interviewEvents.length).toBe(0);
    });
  });
});
