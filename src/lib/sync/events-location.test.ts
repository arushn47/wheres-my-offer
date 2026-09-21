import { describe, expect, it } from 'vitest';
import { extractJobDetails } from './events';
import { cleanLocationString } from './locations';

describe('drive work-location extraction', () => {
  it.each([
    ['Work Location: Bangalore', 'Bangalore'],
    ['Location: Bangalore', 'Bangalore'],
    ['Job Location: Bangalore', 'Bangalore'],
    ['Work Location - Bengaluru / Noida', 'Bengaluru / Noida'],
  ])('extracts %s', (body, expected) => {
    expect(extractJobDetails(body).location).toBe(expected);
  });

  it('preserves explicitly stated multiple locations', () => {
    expect(extractJobDetails('Work Location: Bangalore / Hyderabad / Noida').location)
      .toBe('Bangalore / Hyderabad / Noida');
  });

  it('extracts Natwest job location from circular email', () => {
    const email = `
CTC: 15 LPA
Stipend: nil
Last date for Registration: 19th September 2026 (3.00 pm)
Website: www.natwestgroup.com
Job location: Gurgaon & Bangalore
**Students clearing the interview process will be allocated any of the two. Kindly inform this to all the eligible students so they can apply wisely and only interested ones come forward.
Job Description : Below attachment
Registration:
*All the interested and eligible students should register in the NEO PAT on or before 19th September 2026 (3.00 pm)
No Manual Registration & extension will be entertained.
    `;
    const details = extractJobDetails(email);
    expect(details.location).toBe('Gurgaon & Bangalore');
  });

  it('extracts Natwest job location even when on a single flattened line with footnote notes', () => {
    const singleLine = 'Job location: Gurgaon & Bangalore **Students clearing the interview process will be allocated any of the two. Kindly inform this to all the eligible students so they can apply wisely and only interested ones come forward.';
    expect(extractJobDetails(singleLine).location).toBe('Gurgaon & Bangalore');
  });

  it('does not infer a location from a company name or headquarters', () => {
    expect(extractJobDetails('Acme placement drive. CTC: 10 LPA.').location).toBeNull();
  });
});

describe('cleanLocationString normalization', () => {
  it('converts |, /, &, and "and" into clean commas', () => {
    expect(cleanLocationString('Bangalore | Hyderabad')).toBe('Bangalore, Hyderabad');
    expect(cleanLocationString('Bangalore / Hyderabad / Noida')).toBe('Bangalore, Hyderabad, Noida');
    expect(cleanLocationString('Noida & Gurgaon')).toBe('Noida, Gurgaon');
    expect(cleanLocationString('Hybrid (Gurgaon/Bangalore)')).toBe('Hybrid (Gurgaon, Bangalore)');
    expect(cleanLocationString('Remote')).toBe('Remote');
  });

  it('strips narrative phrases like "whether", "academic gap", "allowed" from location', () => {
    expect(cleanLocationString('Bangalore Whether Academic gap (after HSc.) allowed: No')).toBe('Bangalore');
    expect(extractJobDetails('Work Location: Bangalore Whether Academic gap (after HSc.) allowed: No').location).toBe('Bangalore');
  });
});

describe('drive mode and travel requirement extraction', () => {
  it('extracts chennai for physical process at chennai campus (for all)', async () => {
    const { extractTravelRequirement } = await import('./events');
    const emailText = `
      Name of the Company: UBS
      Category: Super Dream Internship / Placement
      Date of Visit:
      17-08-2026 - PPT Virtual mode
      19-08-2026 - Physical process at Chennai campus (For all)
      Eligible Branches: B.Tech CS & IT
      Warm regards,
      Dr.V.Samuel Rajkumar,PhD
      Director(Career Development Centre)
      VIT, Vellore
      Disclaimer: This message was sent from Vellore Institute of Technology.
    `;
    expect(extractTravelRequirement(emailText)).toBe('chennai');
  });

  it('extracts chennai for selection process scheduled at VIT Chennai', async () => {
    const { extractTravelRequirement } = await import('./events');
    const emailText = `UBS next round of selection process is scheduled on 19th August 2026 8.30 am at VIT Chennai`;
    expect(extractTravelRequirement(emailText)).toBe('chennai');
  });

  it('extracts vellore for physical process at vellore campus', async () => {
    const { extractTravelRequirement } = await import('./events');
    const emailText = `Date of Visit: 19-08-2026 - Interviews Physical at Vellore campus`;
    expect(extractTravelRequirement(emailText)).toBe('vellore');
  });

  it('resolves drive mode display correctly for user campus', async () => {
    const { getDriveMode } = await import('../utils');
    expect(getDriveMode('chennai', 'VIT Bhopal')).toBe('VIT Chennai');
    expect(getDriveMode('chennai', 'VIT Chennai')).toBe('Chennai Labs');
    expect(getDriveMode('vellore', 'VIT Bhopal')).toBe('VIT Vellore');
    expect(getDriveMode('online', 'VIT Bhopal')).toBe('Online');
  });
});

