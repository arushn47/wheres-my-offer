import { describe, expect, it } from 'vitest';
import { extractJobDetails } from './sync/extraction/events';
import { inferEducationLevel, selectEducationCompensation } from './education-compensation';
import { getJobDisplayOverrides } from './job-display-evidence';
import { getDriveDisplayName } from './drive-display';
import { cleanLocationString } from './sync/extraction/locations';

const philips = `CTC
PG -12 LPA + 3 lakh joining Bonus + 5 lakh Mediclaim
(if converted)
UG - 14.5 LPA if converted
Stipend
PG - 55000 UG - 45000
Last date for Registration: 15th October 2026 (10.00 am)`;

describe('source-based compensation display', () => {
  it('keeps Philips UG and PG amounts distinct without treating insurance as salary', () => {
    const details = extractJobDetails(philips);
    expect(details.ctc).toBe('PG: 12 LPA + 3 lakh joining bonus (if converted) · UG: 14.5 LPA (if converted)');
    expect(details.stipend).toBe('PG: ₹55,000/month · UG: ₹45,000/month');
    const level = inferEducationLevel('arush.23bce10472@vitbhopal.ac.in');
    expect(level).toBe('UG');
    expect(selectEducationCompensation(details.ctc, level)).toBe('UG: 14.5 LPA (if converted)');
    expect(selectEducationCompensation(details.stipend, level)).toBe('UG: ₹45,000/month');
    expect(selectEducationCompensation(details.ctc, 'PG')).toContain('PG: 12 LPA + 3 lakh joining bonus');
  });
  it('keeps both labelled amounts when the registration code is unknown', () => {
    const level = inferEducationLevel('student.23XYZ10472@vitbhopal.ac.in');
    expect(level).toBeNull();
    const details = extractJobDetails(philips);
    expect(selectEducationCompensation(details.ctc, level)).toBe(details.ctc);
    expect(inferEducationLevel('student@gmail.com')).toBeNull();
  });
  it('does not replace ordinary packages based on unrelated eligibility labels', () => {
    expect(getJobDisplayOverrides('Eligibility: UG 60%, PG 60%\nCTC: 8.8 LPA\nStipend: 12500 per month')).toEqual({});
  });
  it('honours document pointers rather than borrowing nearby benefit amounts', () => {
    const body = 'CTC: Check attached\nStipend: Nil\nJob location: Mentioned in JD\nBenefits: Insurance 5 LPA, cover 20 LPA';
    expect(extractJobDetails(body).ctc).toBe('Check documents');
    expect(getJobDisplayOverrides(body)).toMatchObject({ ctc: 'Check documents', location: 'Check documents' });
    expect(cleanLocationString('Mentioned in')).toBe('Check documents');
  });
  it('restores CBRE casing for new and previously title-cased drive names', () => {
    expect(getDriveDisplayName('CBRE Digital & Technology India')).toContain('CBRE');
    expect(getDriveDisplayName('Cbre Digital And Technology India')).toContain('CBRE');
  });
});
