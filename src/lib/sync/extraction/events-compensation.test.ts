import { describe, expect, it } from 'vitest';
import { extractJobDetails } from './events';

describe('compact total compensation', () => {
  it('shows the UBS total without relocation prose or a component-based range', () => {
    const details = extractJobDetails(`CTC
An annual compensation of *INR 13 LPA* along with a one-time Relocation
Assistance, up to INR 3 Lakhs* with performance-based bonus (discretionary)
and additional employee benefits.

16 LPA

Stipend
*60000 per month*
Job location: Pune / Hyderabad`);
    expect(details.ctc).toBe('16 LPA');
    expect(details.stipend).toBe('₹60,000/month');
    expect(details.location).toBe('Pune / Hyderabad');
  });
  it.each(['Assistance', 'Allowance'])('handles a one-time relocation %s without a summary total', label => {
    expect(extractJobDetails(`CTC: An annual compensation of INR 12.5 LPA along with a one-time Relocation ${label}, up to INR 2.5 Lakhs. Stipend: 20,000/month`).ctc)
      .toBe('15 LPA');
  });
  it('preserves an explicitly annual relocation allowance', () => {
    expect(extractJobDetails('CTC: An annual compensation of INR 13 LPA with relocation allowance up to INR 3 LPA').ctc)
      .toBe('16 LPA');
  });
  it('handles annual compensation prose without a CTC heading or inventing a payment cap', () => {
    expect(extractJobDetails('An annual compensation of INR 13 LPA along with a one-time relocation assistance of INR 3 Lakhs.').ctc)
      .toBe('16 LPA');
  });
  it('does not mix a sibling UBS offer into this circular', () => {
    expect(extractJobDetails('CTC: 13 - 14 LPA\nStipend: 60000 per month\nJob Location: Mumbai / Pune / Hyderabad').ctc).toBe('13 - 14 LPA');
    expect(extractJobDetails('CTC: 13 LPA (If converted)\nStipend: 60000 per month').ctc).toBe('13 LPA');
  });
});
