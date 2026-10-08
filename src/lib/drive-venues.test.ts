import { describe, expect, it } from 'vitest';
import { extractRecruitmentVenues, knownCampus, resolveDriveVenue, type VenueEntry } from './drive-venues';
import { getEvidenceMessageText } from './sync/extraction/body';

const projection = (entries: VenueEntry[]) => ({ version: 1, entries: entries.map(e => ({ ...e, sourceId: 'canonical-1407', receivedAt: '2026-10-07T12:00:00Z' })) });
const display = (body: string, subject = 'Chargebee registration', campus?: string) => resolveDriveVenue(projection(extractRecruitmentVenues(subject, body)), campus);
describe('explicit drive venue display', () => {
  it('resolves Chargebee #1407 office instructions without borrowing a Bhopal test', () => {
    expect(display('Job Location: Chennai\nInterview Process & Location: All rounds of interviews will be held in person at the ChargeBee Chennai office, preferably targeted for next week.')).toEqual({ label: 'Company Office · Chennai', detail: 'Interviews: ChargeBee Chennai office' });
  });
  it('handles the actual Gmail soft wrapping of the Chargebee office sentence', () => {
    expect(display('*Interview Process & Location:* All rounds of interviews will be held in\nperson at the *Chargebee Chennai office*, preferably targeted for *next\nweek*.').label).toBe('Company Office · Chennai');
  });
  it('combines only the exact drive entries, not another same-company drive', () => {
    const oldDrive = projection(extractRecruitmentVenues('Test scheduled', 'Test will be held at Bhopal LC.'));
    const currentDrive = projection(extractRecruitmentVenues('Chargebee', 'Interviews will be held at Chargebee Chennai office.'));
    expect(resolveDriveVenue(oldDrive).label).toBe('VIT Bhopal');
    expect(resolveDriveVenue(currentDrive).label).toBe('Company Office · Chennai');
    expect(resolveDriveVenue({ version: 1, entries: [...oldDrive.entries, ...currentDrive.entries] }).label).toBe('Multiple locations');
  });
  it('combines remote and office rounds, but not two rooms on one campus', () => {
    expect(display('Test will be conducted online from own location.\nInterviews will be held at Chargebee Chennai office.').label).toBe('Multiple locations');
    expect(display('Test will be held at VIT Bhopal Lab 1.\nInterviews will be held at VIT Bhopal auditorium.').label).toBe('VIT Bhopal');
  });
  it('requires campus attendance even when the test platform is online', () => {
    expect(display('Online test will be conducted at Bhopal LC.', 'Test').label).toBe('VIT Bhopal');
  });
  it.each(['', 'Job Location: Chennai', 'Work Location: VIT Chennai', 'Chargebee Chennai office\nwww.chargebee.com', 'Test location: Chennai', 'Register on NeoPAT online before the deadline.', 'Interviews may be held at Chargebee Chennai office.', 'Interviews will not be held at Chargebee Chennai office.'])('never guesses from %s', text => {
    expect(display(text).label).toBe('To be announced');
  });
  it('requires a known campus for respective-campus instructions', () => {
    expect(display('Test will be conducted at respective campus labs.', 'Test').label).toBe('To be announced');
    expect(display('Test will be conducted at respective campus labs.', 'Test', 'VIT Chennai').label).toBe('VIT Chennai');
    expect(knownCampus('student@gmail.com')).toBeUndefined();
    expect(knownCampus('student@vitbhopal.ac.in')).toBe('VIT Bhopal');
  });
  it('does not use the audience campus as the attendance venue or apply another audience', () => {
    const entries = projection(extractRecruitmentVenues('Test', 'For VIT Vellore students, the test will be held at VIT Bhopal LC.'));
    expect(resolveDriveVenue(entries, 'VIT Vellore').label).toBe('VIT Bhopal');
    expect(resolveDriveVenue(entries, 'VIT Chennai').label).toBe('To be announced');
  });
  it('uses explicit labeled venue cells without needing a date', () => {
    expect(display('Interview venue:\nChargebee Chennai office', 'Interviews').label).toBe('Company Office · Chennai');
  });
  it('ignores prior quoted instructions in a correction', () => {
    const email = { subject: 'Re: Test venue update', bodyPlain: 'Test will be held at VIT Chennai.\nOn Tuesday, October 6 at 10:00 AM Someone wrote:\nTest will be held at VIT Bhopal.', bodyHtml: '', bodySnippet: '' };
    expect(display(getEvidenceMessageText(email), email.subject).label).toBe('VIT Chennai');
  });
  it('does not turn contradictory same-stage evidence into multiple locations', () => {
    expect(display('Test will be held at VIT Chennai.\nTest will be held at VIT Bhopal.', 'Test').label).toBe('To be announced');
  });
  it.each([null, {}, { version: 99 }, { version: 1, entries: null }])('handles absent/unknown projection safely', value => {
    expect(resolveDriveVenue(value).label).toBe('To be announced');
  });
});
