import { describe, expect, it } from 'vitest';
import { scoreCollegeMessageRelevance, isPlacementOfficeMessageAllowed } from './college-relevance';

describe('college relevance gate', () => {
  const PLACEMENT_OFFICE = 'placementoffice@vitbhopal.ac.in';

  describe('placement office strict filter', () => {
    it('strictly rejects "God bless you" hiring email', () => {
      const input = {
        subject: 'God bless you',
        body: `We're hiring SDE Interns at EVE Healthcare.
Dear Students, please check out the opportunity and apply at the link below.
CTC: 10 LPA`,
        hasAttachments: false,
      };
      const check = isPlacementOfficeMessageAllowed(input);
      expect(check.isAllowed).toBe(false);

      const result = scoreCollegeMessageRelevance(input, PLACEMENT_OFFICE);
      expect(result.isRelevant).toBe(false);
    });

    it('strictly rejects "Inbox restricted offer 10 LPA+" email', () => {
      const input = {
        subject: 'Inbox restricted offer 10 LPA+',
        body: 'Dear Lions and Lionesses Inboxkit restricted offer details for 2027 batch...',
        hasAttachments: false,
      };
      const check = isPlacementOfficeMessageAllowed(input);
      expect(check.isAllowed).toBe(false);

      const result = scoreCollegeMessageRelevance(input, PLACEMENT_OFFICE);
      expect(result.isRelevant).toBe(false);
    });

    it('rejects general job advertisements from placement office without shortlist or schedule', () => {
      const input = {
        subject: 'New Opening: Software Developer at TechCorp',
        body: 'TechCorp is looking for passionate engineers. Eligibility: 70%. Please apply on company career portal.',
        hasAttachments: false,
      };
      const result = scoreCollegeMessageRelevance(input, PLACEMENT_OFFICE);
      expect(result.isRelevant).toBe(false);
    });

    it('admits test schedule from placement office', () => {
      const input = {
        subject: 'Online Test Schedule: Infosys Assessment',
        body: 'Dear Students, the online test for Infosys is scheduled on 5th October at 10:00 am on Superset platform.',
        hasAttachments: false,
      };
      const result = scoreCollegeMessageRelevance(input, PLACEMENT_OFFICE);
      expect(result.isRelevant).toBe(true);
      expect(result.category).toBe('test_schedule');
    });

    it('admits interview schedule from placement office', () => {
      const input = {
        subject: 'Deloitte Technical Interview Schedule - 2027 Batch',
        body: 'Kind attention: Technical interview slots for Deloitte are scheduled on 2nd October starting at 9:00 am.',
        hasAttachments: false,
      };
      const result = scoreCollegeMessageRelevance(input, PLACEMENT_OFFICE);
      expect(result.isRelevant).toBe(true);
      expect(result.category).toBe('interview_schedule');
    });

    it('admits shortlist with student IDs from placement office (e.g. Gullak)', () => {
      const input = {
        subject: 'Fwd: Gullak next round',
        body: `the following is the shortlist:
Be ready for the interviews anytime.
Rakshit Pandey 23BCE11664
Tejas Tekade 23BCE10580
Soumyodip Bhattacharya 23BCE10416
Rishita Mehta 23BCE10235`,
        hasAttachments: false,
      };
      const result = scoreCollegeMessageRelevance(input, PLACEMENT_OFFICE);
      expect(result.isRelevant).toBe(true);
      expect(result.category).toBe('shortlist');
    });

    it('admits shortlist attachment from placement office', () => {
      const input = {
        subject: 'Axxela Shortlisted Candidates',
        body: 'Please find attached the shortlisted candidates for next round.',
        hasAttachments: true,
        attachmentFilenames: ['Axxela_Shortlist_Round1.xlsx'],
      };
      const result = scoreCollegeMessageRelevance(input, PLACEMENT_OFFICE);
      expect(result.isRelevant).toBe(true);
      expect(result.category).toBe('shortlist');
    });
  });

  describe('general chatter and circulars', () => {
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

    it('admits a real drive circular from vitlions with company + keywords + attachment', () => {
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

    it('drops a short chatter ping even inside a forwarded chain', () => {
      const result = scoreCollegeMessageRelevance({
        subject: 'Fwd: meeting',
        body: 'we will start now\n\n---------- Forwarded message ---------\nFrom: vitlions2027@vitbhopal.ac.in',
      });
      expect(result.isRelevant).toBe(false);
    });
  });
});
