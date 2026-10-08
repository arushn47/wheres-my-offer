import { describe, expect, it } from 'vitest';
import { extractJobDetails, extractEvents } from './events';

describe('plan extraction examples', () => {
  it('extracts OJ Commerce roles, CTC, and office work mode', () => {
    const details = extractJobDetails(`
      We are currently hiring for the following positions:
      - Software Engineering
      - Analytics
      - Business Process
      - Program Management Office(PMO)
      Selected candidates will receive:
      - ₹7.5 LPA for Software Engineering, Analytics, Business Process, Program Management Office,
      - Note, all the roles are Work From Office role
    `);
    expect(details.role).toBe('Software Engineering / Analytics / Business Process / Program Management Office');
    expect(details.ctc).toBe('7.5 LPA');
    expect(details.workMode).toBe('office');
  });

  it('extracts the Infosys sentence role and preserves its CTC', () => {
    const details = extractJobDetails(
      'join our organization as a Systems Engineer (Trainee), offering a compensation package of ₹3.6 LPA.'
    );
    expect(details.role).toBe('Systems Engineer');
    expect(details.ctc).toBe('3.6 LPA');
  });

  it('extracts EA office location and hybrid work mode', () => {
    const details = extractJobDetails(`
      Location- EA Hyderabad office in person(No remote)
      Mode of Work- Hybrid(3 days a week)
    `);
    expect(details.location).toBe('Hyderabad');
    expect(details.workMode).toBe('hybrid');
  });

  it('does not turn a JD pointer into a location', () => {
    expect(extractJobDetails('Job location: Refer JD’s').location).toBeNull();
  });

  it('extracts KPMG day process CTC values as a range', () => {
    const details = extractJobDetails(`
      CTC
      - Day 1 (Process): 6 LPA Fixed + Variable + Other benefits
      - Day 2 (Process): 5 LPA Fixed + Variable + Other benefits
      Stipend: 20,000/month
    `);
    expect(details.ctc).toBe('5 - 6 LPA');
  });

  it('extracts Conneqtion stipend wording from a non-circular company profile email', () => {
    const details = extractJobDetails(`
      Associate Consultant Internship Program
      Program Details
      Location: HSR Layout, Bengaluru (Work from Office)
      Internship Duration: 6 Months
      Stipend: ₹20,000 per month
      Post-Internship Compensation: ₹7 LPA (upon successful conversion)
    `);
    expect(details.stipend).toBe('₹20,000/month');
  });

  it('keeps a direct stipend when later company-profile prose follows it', () => {
    const details = extractJobDetails(`
      Location: HSR Layout, Bengaluru (Work from Office)
      Stipend: ₹20,000 per month
      Post-Internship Compensation: ₹7 LPA (upon successful conversion)
      Service Agreement: 2 years
      Why This Program Stands Out
      Selected students will have the opportunity to work on live projects.
      The deadline in the NEOPAT portal is on or before 2 pm tomorrow
      Warm regards.
      Disclaimer: This message was sent from Vellore Institute of Technology.
    `);
    expect(details.stipend).toBe('₹20,000/month');
  });

  it('extracts PPT with hyphenated date and 2-digit year from Date of Visit table in registration circular', () => {
    const events = extractEvents({
      gmailMessageId: 'msg-ubs',
      threadId: null,
      sender: 'CDC <vitlions2027@vitbhopal.ac.in>',
      senderEmail: 'vitlions2027@vitbhopal.ac.in',
      subject: 'UBS Super Dream Internship Offer - 2027 Batch Registration Link',
      receivedAt: new Date('2026-09-29T06:36:16.000Z'),
      bodySnippet: '',
      bodyPlain: `
        Name of the Company: UBS
        Category: Super Dream Internship
        Date of Visit:
        *Pre-placement talk:* 29-September-26; 4:00 PM to 5:00 PM
        *Interview:* 6-October-26; 10:00 AM onwards
        Eligible Branches: B.Tech & M.Tech (CS/IT Related)
        Last date for Registration: 30th September 2026 11.00 am
      `,
      bodyHtml: '',
      hasAttachments: false,
      attachments: [],
      labels: [],
    });

    const ppt = events.find((e) => e.eventType === 'ppt');
    expect(ppt).toBeDefined();
    expect(ppt?.startTime).toEqual(new Date('2026-09-29T10:30:00.000Z')); // 4:00 PM IST
    expect(ppt?.endTime).toEqual(new Date('2026-09-29T11:30:00.000Z'));   // 5:00 PM IST
  });
});
