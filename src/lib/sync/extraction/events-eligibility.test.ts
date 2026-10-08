import { describe, expect, it } from 'vitest';
import { extractEligibilityDetails, extractJobDetails } from './events';

describe('extractEligibilityDetails', () => {
  it('extracts combined 10th & 12th, UG, PG, arrears, and branches properly without bleeding (e.g. Chargebee)', () => {
    const text = `
Eligible Branches
Ø  B. Tech ( CSE / IT ) related branches only

Eligibility Criteria
*% in X and XII – 60% or 6.0 CGPA*
*in Pursuing Degree – 60% or 6.0 CGPA*
*in UG (for PGs) – 60% or 6.0 CGPA   *
*No Standing Arrears*

CTC
*CTC : 16 LPA (If Converted)*
`;

    const res = extractEligibilityDetails(text);

    expect(res.badges).toEqual([
      '10th & 12th: 60% or 6.0 CGPA',
      'UG: 60% or 6.0 CGPA',
      'PG: 60% or 6.0 CGPA',
      'No standing arrears',
      'Branches: B. Tech ( CSE / IT ) related branches only',
    ]);
    expect(res.tenthTwelfth).toBe('60% or 6.0 CGPA');
    expect(res.ug).toBe('60% or 6.0 CGPA');
    expect(res.pg).toBe('60% or 6.0 CGPA');
    expect(res.backlogs).toBe('No standing arrears');
  });

  it('extracts separate 10th and 12th badges when separate in circular', () => {
    const text = `
Eligibility Criteria
*in 10th – 78% or 7.8 CGPA*
*in 12th – 78% or 7.8 CGPA*
*in Pursuing Degree – 78% or 7.8 CGPA*
*No standing arrears*
`;

    const res = extractEligibilityDetails(text);

    expect(res.badges).toEqual([
      '10th: 78% or 7.8 CGPA',
      '12th: 78% or 7.8 CGPA',
      'UG: 78% or 7.8 CGPA',
      'No standing arrears',
    ]);
    expect(res.tenth).toBe('78% or 7.8 CGPA');
    expect(res.twelfth).toBe('78% or 7.8 CGPA');
    expect(res.ug).toBe('78% or 7.8 CGPA');
    expect(res.pg).toBeNull();
  });

  it('omits PG badge if PG is not mentioned', () => {
    const text = `
Eligibility Criteria
*10th & 12th: 70% or 7.0 CGPA*
*UG: 70% or 7.0 CGPA*
*No standing arrears & no academic gap*
`;

    const res = extractEligibilityDetails(text);

    expect(res.badges).toEqual([
      '10th & 12th: 70% or 7.0 CGPA',
      'UG: 70% or 7.0 CGPA',
      'No standing arrears & no academic gap',
    ]);
    expect(res.pg).toBeNull();
  });

  it('extractJobDetails also returns clean summary and structured requirements', () => {
    const text = `
Designation: Intern - Software Engineer
Location: Chennai
Eligibility Criteria
*% in X and XII – 60% or 6.0 CGPA*
*in Pursuing Degree – 60% or 6.0 CGPA*
*in UG (for PGs) – 60% or 6.0 CGPA*
*No Standing Arrears*
CTC: 16 LPA
`;

    const details = extractJobDetails(text);
    expect(details.eligibility).toBe(
      '10th & 12th: 60% or 6.0 CGPA | UG: 60% or 6.0 CGPA | PG: 60% or 6.0 CGPA | No standing arrears'
    );
    expect(details.tenthRequirement).toBe('60% or 6.0 CGPA');
    expect(details.twelfthRequirement).toBe('60% or 6.0 CGPA');
    expect(details.ugRequirement).toBe('60% or 6.0 CGPA');
    expect(details.pgRequirement).toBe('60% or 6.0 CGPA');
    expect(details.backlogRequirement).toBe('No standing arrears');
  });

  it('does not extract narrative degree text without numbers as criteria (e.g. Capgemini stipulated duration)', () => {
    const text = `
Eligibility Criteria:
1. Candidates from CS/IT and Allied Branches
2. Candidates should not have any active backlog at the time of recruitment process
3. A cumulative academic gap of up to 2 years is permitted
4. Candidates must complete their degree within the stipulated duration of the academic program
`;
    const details = extractEligibilityDetails(text);
    expect(details.ug).toBeNull();
    expect(details.badges).not.toContain(expect.stringMatching(/stipulated duration/i));
  });
});
