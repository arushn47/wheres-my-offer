import { describe, expect, it } from 'vitest';
import { isRegistrationAnnouncement, isRegistrationPair, selectRegistrationCircular, selectRegistrationDrive } from './registration-pair';
const current = { id: 'new', drive_number: 'pat-PL-2026-1423' };
const old = { id: 'old', drive_number: 'pat-PL-2026-1284' };
const announcement = { id: 'personal', placement_drive_id: 'new', sender: 'NeoPAT <noreply.cdcinfo@vitstudent.ac.in>', subject: "Congratulations! You're Eligible for Responsive Placement Drive", classification: 'registration', received_at: '2026-10-09T07:48:46Z' };
const circular = { id: 'college', subject: 'Re Registration: Responsive Super Dream', classification: 'registration', received_at: '2026-10-09T07:46:46Z', parsed_drive_numbers: [], processing_status: 'complete' };
describe('personal NeoPAT and college registration pairing', () => {
  it('preserves follow-up rounds that retain registration in the reply subject', () => {
    expect(isRegistrationAnnouncement({ subject: 'Re: Company Registration — Test scheduled', classification: 'test' })).toBe(false);
    expect(isRegistrationAnnouncement({ subject: 'Re: Company Registration', classification: 'interview' })).toBe(false);
  });
  it('matches either arrival order using receipt times rather than database insertion times', () => {
    expect(isRegistrationPair(current, announcement, circular)).toBe(true);
    expect(isRegistrationPair(current, announcement, { ...circular, received_at: '2026-10-09T07:50:00Z' })).toBe(true);
  });
  it('does not qualify the new ION circular using July personal eligibility', () => {
    expect(isRegistrationPair(old, { ...announcement, placement_drive_id: 'old', received_at: '2026-07-17T10:34:57Z' }, circular)).toBe(false);
  });
  it('routes Responsive to #1423 and never #1284', () => {
    const personal = [announcement, { ...announcement, id: 'old-personal', placement_drive_id: 'old', received_at: '2026-09-04T06:45:41Z' }];
    expect(selectRegistrationDrive([old, current], personal, circular)?.id).toBe('new');
    expect(selectRegistrationDrive([old], personal, circular)).toBeUndefined();
  });
  it('requires the official personal sender, exact drive and completed registration circular', () => {
    for (const personal of [{ ...announcement, sender: 'vitlions2027@vitbhopal.ac.in' }, { ...announcement, placement_drive_id: 'old' }, { ...announcement, classification: 'registration_confirmation', subject: 'Confirmed: Your Registration' }]) {
      expect(isRegistrationPair(current, personal, circular)).toBe(false);
    }
    expect(isRegistrationPair(current, announcement, { ...circular, processing_status: 'processing' })).toBe(false);
    expect(isRegistrationPair(current, announcement, { ...circular, classification: 'test', subject: 'Test scheduled' })).toBe(false);
  });
  it('rejects conflicting and pooled drive numbers despite a close receipt time', () => {
    expect(isRegistrationPair(current, announcement, { ...circular, parsed_drive_numbers: ['pat-PL-2026-1284'] })).toBe(false);
    expect(isRegistrationPair(current, announcement, { ...circular, parsed_drive_numbers: ['pat-PL-2026-1423', 'pat-PL-2026-1284'] })).toBe(false);
    expect(isRegistrationPair(current, announcement, { ...circular, parsed_drive_numbers: ['pat-pl-2026-1423'] })).toBe(true);
  });
  it('does not invent a match from an application, company name or ambiguous timestamps', () => {
    expect(selectRegistrationDrive([current], [], circular)).toBeUndefined();
    expect(selectRegistrationCircular(current, [announcement], [circular, { ...circular, id: 'ambiguous' }])).toBeUndefined();
    expect(isRegistrationPair(current, { ...announcement, received_at: null }, circular)).toBe(false);
  });
});
