import { describe, expect, it } from 'vitest';
import { scoreCollegeMessageRelevance } from './college-relevance';

describe('college relevance gate', () => {
  it('drops meeting-start chatter ("we will start now")', () => {
    const result = scoreCollegeMessageRelevance({
      subject: 'God bless you meeting',
      body: 'we will start in 10 mins ma join if you can',
    });
    expect(result.isRelevant).toBe(false);
  });

  it('drops bare meet-link messages', () => {
    const result = scoreCollegeMessageRelevance({
      subject: 'Placement Office',
      body: 'We will start at 6 pm or so https://stream.meet.google.com/stream/abc123',
    });
    expect(result.isRelevant).toBe(false);
  });

  it('drops "let us start" pings even when the subject is empty', () => {
    const result = scoreCollegeMessageRelevance({
      subject: '',
      body: 'let us start ma',
    });
    expect(result.isRelevant).toBe(false);
  });

  it('admits a real drive circular with company + keywords + attachment', () => {
    const result = scoreCollegeMessageRelevance({
      subject: 'Infosys Registration - Systems Engineer - 2027 Batch',
      body: `Dear Students,
Greetings from Infosys!
Drive Name: pat-PL-2026-1401
Role: Systems Engineer
CTC: 4.5 LPA
Eligibility: 60% throughout with no standing arrears
Last date for Registration: 5th October 2026 (10.00 am)
Job Location: Pune / Bangalore`,
      hasAttachments: true,
      attachmentFilenames: ['Infosys_JD.pdf'],
    });
    expect(result.isRelevant).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
  });

  it('admits circulars with drive structure even without a known company', () => {
    const result = scoreCollegeMessageRelevance({
      subject: 'Registration Open: Dream Offer 2027 Batch',
      body: `Placement drive announced. Eligibility: CGPA 7+. CTC 12 LPA.
Registration deadline 10th October. Drive Number pat-PL-2026-1420.
Shortlisted students will be informed about the online test and interview rounds.`,
      hasAttachments: false,
    });
    expect(result.isRelevant).toBe(true);
  });

  it('keeps chatter dropped even with an attachment if body is trivial', () => {
    const result = scoreCollegeMessageRelevance({
      subject: 'meeting',
      body: 'we will start now',
      hasAttachments: true,
      attachmentFilenames: ['image001.png'],
    });
    expect(result.isRelevant).toBe(false);
  });

  it('admits the real Gullak office email: pasted shortlist with student IDs, no formal fields', () => {
    // Verbatim-style replica of the actual placement-office email (Sep 23). No
    // Drive Name field, no attachment, company only in the forwarded chain.
    const result = scoreCollegeMessageRelevance({
      subject: 'Fwd: Gullak next round',
      body: `the following is the shortlist

Be ready for the interviews anytime. Be in the sadhana stal or nearby. exempt from capgemini tomm

Meet me at 2 pm tomm

Rakshit  Pandey 23BCE11664
Tejas Tekade 23BCE10580
Soumyodip Bhattacharya 23BCE10416
Rishita Mehta 23BCE10235
Shri Ram Prince Mishra 23BCE11629
Manasvi Khare 23BCE10232
Krish Joshi 23BCE10305
Soumyak Pransuman Behera 23BCE10284
Milind Verma 23BCE11695
Aayush Sharma 23BCE10993

---------- Forwarded message ---------
From: 'No Reply CDC Info' via Students 2027 passout batch <vitlions2027@vitbhopal.ac.in>
Subject: Re: Gullak Money Super Dream Internship Registration - 2027 Batch.`,
      hasAttachments: false,
    });
    expect(result.isRelevant).toBe(true);
  });

  it('drops a short chatter ping even inside a forwarded chain', () => {
    const result = scoreCollegeMessageRelevance({
      subject: 'Fwd: meeting',
      body: 'we will start now\n\n---------- Forwarded message ---------\nFrom: vitlions2027@vitbhopal.ac.in',
    });
    expect(result.isRelevant).toBe(false);
  });
});
