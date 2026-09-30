import { describe, it, expect } from 'vitest';
import { classifyEmail } from './classifier';
import type { ParsedEmail } from '@/lib/gmail/client';

function makeEmail(subject: string, bodyText: string): ParsedEmail {
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

describe('classifier: registration circulars vs shortlists', () => {
  it('classifies Larsen & Toubro registration circular with future assessment notes as registration', () => {
    const email = makeEmail(
      'Larsen & Toubro Limited : Registration : Dream Offer - 2027 Batch',
      'Greetings from Larsen & Toubro Limited!\nPlease find enclosed the Notice Inviting Application (NIA) document.\n- The assessments for shortlisted candidates are scheduled between 27th September – 30th September 2026.\nAll the interested and eligible students should register in the below company link & Neo pat portal on before 25-09-2026'
    );
    const result = classifyEmail(email);
    expect(result.classification).toBe('registration');
    expect(result.companyName).toBe('Larsen & Toubro');
  });

  it('classifies other college registration emails as registration even if body mentions shortlisted candidates', () => {
    const email1 = makeEmail(
      'Zluri - Super Dream Internship / Placement Registration : 2027 Batch',
      'Shortlisted candidates will be invited for technical interviews on campus. Please register before tomorrow.'
    );
    expect(classifyEmail(email1).classification).toBe('registration');

    const email2 = makeEmail(
      'Nielsen : Registration : Super Dream Internship - 2027 Batch',
      'Assessments for shortlisted candidates will be announced shortly. Fill the registration link below.'
    );
    expect(classifyEmail(email2).classification).toBe('registration');

    const email3 = makeEmail(
      'Veeva Systems Super Dream Offer Registration- 2027 Batch',
      'Registration form is open. Shortlisted candidates list will follow after resume screening.'
    );
    expect(classifyEmail(email3).classification).toBe('registration');
  });

  it('still correctly classifies genuine shortlist emails', () => {
    const email1 = makeEmail(
      'Zluri Super Dream Internship Selection List - 2027 Batch',
      'Congratulations to all selected candidates. Find the list below.'
    );
    expect(['shortlist', 'result']).toContain(classifyEmail(email1).classification);

    const email2 = makeEmail(
      'Shortlisted candidates for Amazon Online Test',
      'Find the below shortlist for the next round.'
    );
    expect(classifyEmail(email2).classification).toBe('shortlist');

    const email3 = makeEmail(
      'Larsen & Toubro Campus Drive',
      'Please find attached the shortlist for next round.'
    );
    expect(classifyEmail(email3).classification).toBe('shortlist');
  });

  it('classifies applied list emails with shortlist notes as shortlist', () => {
    const malomatia = makeEmail(
      'Kind Attention!! Malomatia applied list!!',
      'Find the below attached applied list.\nAll the applied candidates are informed to fill the details in the below link on or before 1st Oct 2026 (9 AM)\nLink: https://forms.gle/cqAobDBDtdfqA5ot6\n**Only the attached candidates are strictly informed to fill in the details.\nNote: Shortlisted candidates will have Pre-placement talk by tomorrow (4 PM) @ virtual mode'
    );
    const result = classifyEmail(malomatia);
    expect(result.classification).toBe('shortlist');
    expect(result.companyName).toBe('Malomatia');
  });

  it('classifies general applied list emails with forms or rosters as registration', () => {
    const ubs = makeEmail(
      'Kind Attn: UBS Applied Students - 2027 Batch',
      'Please find the attached applied students list who have not submitted the additional data (form) in the Neopat'
    );
    expect(classifyEmail(ubs).classification).toBe('registration');
  });

  it('classifies campus drive/internship offers without literal registration keyword as registration', () => {
    const jiostar = makeEmail(
      'JIOSTAR Super Dream Internship Offer - 2027 Batch',
      'JIOSTAR is hiring 2027 batch students for internship roles. Last date to register is 5th Oct.'
    );
    expect(classifyEmail(jiostar).classification).toBe('registration');

    const xtep = makeEmail(
      'Xtep India - Dream Internship - MBA 2026 Batch',
      'Xtep India Dream Internship details and requirements.'
    );
    expect(classifyEmail(xtep).classification).toBe('registration');

    const groww = makeEmail(
      'GROWW - Super Dream Placement / Internship - 2027 Batch',
      'Groww campus hiring for 2027 batch.'
    );
    expect(classifyEmail(groww).classification).toBe('registration');
  });

  it('classifies PPO announcements as result', () => {
    const citi = makeEmail(
      'Congratulations Congratulations Citi Bank - PPO',
      'Congratulations to the following candidates on receiving PPO from Citi Bank.'
    );
    expect(classifyEmail(citi).classification).toBe('result');
  });

  it('classifies applied student circulars with OA/test notices as test', () => {
    const amz = makeEmail(
      'Amazon Internship - Amazon Internship Applied Students - NON - CS!!',
      'Candidates will have to appear for Online Assessment (OA). OA links are active.'
    );
    expect(classifyEmail(amz).classification).toBe('test');
  });
});
