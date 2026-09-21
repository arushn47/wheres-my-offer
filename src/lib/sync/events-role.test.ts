import { describe, expect, it } from 'vitest';
import { cleanEventTitle, cleanRoleTitle, extractJobDetails, extractEvents } from './events';

describe('cleanRoleTitle', () => {
  it('cleans role prefixes like "Designation : " or "Job Role : "', () => {
    expect(cleanRoleTitle('Designation : Intern')).toBe('Intern');
    expect(cleanRoleTitle('Job Role : Associate Software Engineer')).toBe('Associate Software Engineer');
    expect(cleanRoleTitle('Job Profile: Graduate Analyst')).toBe('Graduate Analyst');
    expect(cleanRoleTitle('Role - Data Scientist')).toBe('Data Scientist');
  });

  it('rejects attachment pointers and returns null', () => {
    expect(cleanRoleTitle('Below attachment')).toBeNull();
    expect(cleanRoleTitle('Job Description : Below attachment')).toBeNull();
    expect(cleanRoleTitle('Refer attachment')).toBeNull();
    expect(cleanRoleTitle('Check attachment')).toBeNull();
    expect(cleanRoleTitle('See attachment')).toBeNull();
    expect(cleanRoleTitle('JD attached')).toBeNull();
    expect(cleanRoleTitle('Attached JD')).toBeNull();
    expect(cleanRoleTitle('As per attachment')).toBeNull();
    expect(cleanRoleTitle('Please refer to the attached document')).toBeNull();
  });

  it('rejects prose and sentence fragments starting with prepositions, conjunctions, or action verbs', () => {
    expect(cleanRoleTitle('to complete applications on the American Express Career Portal and learn more about the teams hiring')).toBeNull();
    expect(cleanRoleTitle('of hiring')).toBeNull();
    expect(cleanRoleTitle('for the candi')).toBeNull();
    expect(cleanRoleTitle('and is not for AI, ML, or any other roles')).toBeNull();
    expect(cleanRoleTitle('with Unilever . However, If placed with Unilever, all students who have a curriculum mandated, will')).toBeNull();
    expect(cleanRoleTitle('will receive a new test link')).toBeNull();
    expect(cleanRoleTitle('shared at the earliest')).toBeNull();
    expect(cleanRoleTitle('Further details will be shared at the earliest')).toBeNull();
  });

  it('preserves valid roles including acronyms like IS&T or IT', () => {
    expect(cleanRoleTitle('IS&T SDET Intern')).toBe('IS&T SDET Intern');
    expect(cleanRoleTitle('IS&T SRE Intern')).toBe('IS&T SRE Intern');
    expect(cleanRoleTitle('IT Specialist')).toBe('IT Specialist');
    expect(cleanRoleTitle('Software Developer / Technical Product Analyst')).toBe('Software Developer / Technical Product Analyst');
    expect(cleanRoleTitle('ETS – Software Engineering')).toBe('ETS – Software Engineering');
    expect(cleanRoleTitle('Engineering Graduate Trainee-Risk Information Security')).toBe('Engineering Graduate Trainee-Risk Information Security');
  });

  it('cleans trailing suffixes like " - Full Time" or " / Full Time"', () => {
    expect(cleanRoleTitle('ETS – Software Engineering - Full Time')).toBe('ETS – Software Engineering');
    expect(cleanRoleTitle('ETS – Software Engineering / Full Time')).toBe('ETS – Software Engineering');
    expect(cleanRoleTitle('Intern +')).toBe('Intern');
  });

  it('rejects broken punctuation fragments and branch text like ") - All B"', () => {
    expect(cleanRoleTitle(')  - All B')).toBeNull();
    expect(cleanRoleTitle(') - All B')).toBeNull();
    expect(cleanRoleTitle('All B')).toBeNull();
    expect(cleanRoleTitle('All B.Tech')).toBeNull();
    expect(cleanRoleTitle('B.Tech CSE')).toBeNull();
  });

  it('rejects generic single-word headers like "Details" or "Skill"', () => {
    expect(cleanRoleTitle('Details')).toBeNull();
    expect(cleanRoleTitle('Skill')).toBeNull();
    expect(cleanRoleTitle('Skills')).toBeNull();
    expect(cleanRoleTitle('Note')).toBeNull();
    expect(cleanRoleTitle('Starting designation')).toBeNull();
    expect(cleanRoleTitle('Initial designation')).toBeNull();
  });

  it('strips prefixes and trailing role/position words', () => {
    expect(cleanRoleTitle('Service line - Position Title: Consulting – Technology')).toBe('Consulting – Technology');
    expect(cleanRoleTitle('Software Development Engineer role')).toBe('Software Development Engineer');
    expect(cleanRoleTitle('Forward Deployed Engineer position')).toBe('Forward Deployed Engineer');
  });

  it('rejects candidate shortlist snippets containing Neo IDs', () => {
    expect(cleanRoleTitle('Offered X6V7N5T4 BTSA')).toBeNull();
    expect(cleanRoleTitle('P1V4A1V9 AI X3L4M9Q3 AI')).toBeNull();
  });

  it('rejects administrative deadline instructions and verb fragments', () => {
    expect(cleanRoleTitle('focuses on long form content generation and localization, including')).toBeNull();
    expect(cleanRoleTitle('preference on NeoPAT on or before 29-07-2026')).toBeNull();
  });
});

describe('extractJobDetails role extraction', () => {
  it('extracts American Express ETS - Software Engineering without capturing prose', () => {
    const text = `
Website: https://www.americanexpress.com/en-in/
Location - Hybrid (Gurgaon/Bangalore/Chennai - depending on business requirements)
Eligibility:
- Full Time + Add on 24-week Apprenticeship: 2027 Grads
- Minimum CGPA - 7
CTC:
Fixed Pay 14,86,120 Joining Bonus 3,00,000 TCTC@Target 21,27,320
• Full Time | 6 months Apprenticeship (90 minute test, 2 hour window)
• Role: ETS – Software Engineering
- Full Time | 6 months Apprenticeship (Jan 2027 to June 2027) to support academic curriculum
    `;
    const details = extractJobDetails(text);
    expect(details.role).toBe('ETS – Software Engineering');
  });

  it('does NOT capture prose containing the word "role" as a job role', () => {
    const text = `
Access the embedded Business Unit Job Links available under the role to complete applications on the American Express Career Portal and learn more about the teams hiring within American Express through Business Unit specific information, role details, Job Descriptions, and key requirements.
    `;
    const details = extractJobDetails(text);
    expect(details.role).toBeNull();
  });

  it('returns null for drives where circular says "Job Description : Below attachment"', () => {
    const text = `
Name of Company: MUFG
CTC: 20 LPA
Stipend: INR 65,000 +Travel
Job location: Bengaluru.
Job Description : Below attachment
Registration:
All the interested and eligible students should register in the Neo pat portal.
    `;
    const details = extractJobDetails(text);
    expect(details.role).toBeNull();
  });

  it('extracts multiline bullet roles (e.g. ION Group)', () => {
    const text = `
Name of the Company: ION Group
CTC: 17.3 LPA
*Role**:*
   - Software Developer
   - Technical Product Analyst
Kindly check your NEO PAT portal for the registration link.
    `;
    const details = extractJobDetails(text);
    expect(details.role).toBe('Software Developer / Technical Product Analyst');
  });

  it('extracts comma-separated roles from ExxonMobil narrative designation text', () => {
    const text = `
*Job location:* *Bangalore, Mumbai and Gurgaon*

*Designation : * Depends on the function that employee would join.
Starting designation
are as Discipline Engineer (eg Electrical Engineer in Electrical
Engineering function), Data Analyst, Sales Account Manager, Market
developer, etc.

*Service Agreement: Yes, every employee has to sign a general employment
    `;
    const details = extractJobDetails(text);
    expect(details.role).toBe('Discipline Engineer / Data Analyst / Sales Account Manager / Market developer');
  });
});

describe('cleanEventTitle', () => {
  it('strips leading company name with hyphens or dashes', () => {
    expect(cleanEventTitle('Chargebee - Pre-Placement Talk (PPT)', 'Chargebee')).toBe('Pre-Placement Talk (PPT)');
    expect(cleanEventTitle('Chargebee — Pre-Placement Talk (PPT)', 'Chargebee')).toBe('Pre-Placement Talk (PPT)');
    expect(cleanEventTitle('Goldman Sachs: Aptitude Test', 'Goldman Sachs')).toBe('Aptitude Test');
    expect(cleanEventTitle('TCS | Coding Round', 'TCS')).toBe('Coding Round');
  });

  it('handles repeated company name prefixes cleanly', () => {
    expect(cleanEventTitle('Chargebee — Chargebee - Pre-Placement Talk (PPT)', 'Chargebee')).toBe('Pre-Placement Talk (PPT)');
    expect(cleanEventTitle('Chargebee - Chargebee - PPT', 'Chargebee')).toBe('PPT');
  });

  it('strips company name when followed by event keywords without hyphens', () => {
    expect(cleanEventTitle('Chargebee Pre-Placement Talk (PPT)', 'Chargebee')).toBe('Pre-Placement Talk (PPT)');
    expect(cleanEventTitle('Microsoft Online Assessment', 'Microsoft')).toBe('Online Assessment');
  });

  it('returns fallback or empty when title is identical to company name', () => {
    expect(cleanEventTitle('Chargebee', 'Chargebee', 'Placement Round')).toBe('Placement Round');
    expect(cleanEventTitle('Chargebee -', 'Chargebee', 'PPT')).toBe('PPT');
  });

  it('preserves legitimate event titles without company name', () => {
    expect(cleanEventTitle('Technical Interview Round 1', 'Google')).toBe('Technical Interview Round 1');
    expect(cleanEventTitle('Aptitude & Coding Assessment', 'Amazon')).toBe('Aptitude & Coding Assessment');
  });

  it('returns fallback for empty or falsy titles', () => {
    expect(cleanEventTitle(null, 'Google', 'Online Test')).toBe('Online Test');
    expect(cleanEventTitle('', 'Google', 'Online Test')).toBe('Online Test');
    expect(cleanEventTitle('   ', 'Google', 'Online Test')).toBe('Online Test');
  });
});

describe('extractEvents registration_deadline', () => {
  it('extracts registration deadline from CDC circulars with flexible phrasing and explicit times (e.g. L&T)', () => {
    const email = {
      subject: 'Larsen & Toubro Limited : Registration : Dream Offer - 2027 Batch',
      receivedAt: new Date('2026-09-21T10:28:41Z'),
      bodySnippet: `*Registration:*
*All the interested and eligible students should register in the below company's link & Neo pat portal on before
*25-09-2026 (09:00 am)*
Company's Registration Link - https://campus.lntedutech.com/...`,
    } as any;

    const events = extractEvents(email);
    const regEvent = events.find((e) => e.eventType === 'registration_deadline');

    expect(regEvent).toBeDefined();
    expect(regEvent?.hasExplicitTime).toBe(true);
    expect(regEvent?.startTime).toEqual(new Date('2026-09-25T03:30:00.000Z'));
  });
});

describe('isTrustedPlacementSender', () => {
  it('strictly restricts allowed placement senders and rejects unauthorized senders', async () => {
    const { isTrustedPlacementSender } = await import('./engine');

    // Personal account: strictly noreply.cdcinfo@vitstudent.ac.in
    expect(isTrustedPlacementSender('noreply.cdcinfo@vitstudent.ac.in', true)).toBe(true);
    expect(isTrustedPlacementSender('CDC Info <noreply.cdcinfo@vitstudent.ac.in>', true)).toBe(true);
    expect(isTrustedPlacementSender('vitlions2027@vitbhopal.ac.in', true)).toBe(false);
    expect(isTrustedPlacementSender('professor@vitbhopal.ac.in', true)).toBe(false);
    expect(isTrustedPlacementSender('careers@google.com', true)).toBe(false);

    // College account: vitlions2027@vitbhopal.ac.in or noreply.cdcinfo@vitstudent.ac.in
    expect(isTrustedPlacementSender('vitlions2027@vitbhopal.ac.in', false)).toBe(true);
    expect(isTrustedPlacementSender('Placement Cell <vitlions2027@vitbhopal.ac.in>', false)).toBe(true);
    expect(isTrustedPlacementSender('noreply.cdcinfo@vitstudent.ac.in', false)).toBe(true);
    expect(isTrustedPlacementSender('Placement Office <placementoffice@vitbhopal.ac.in>', false)).toBe(false);
    expect(isTrustedPlacementSender('professor@vitbhopal.ac.in', false)).toBe(false);
    expect(isTrustedPlacementSender('notifications@github.com', false)).toBe(false);
  });
});

