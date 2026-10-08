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
  it('prioritizes required attendance over remote rounds and deduplicates one campus', () => {
    expect(display('Test will be conducted online from own location.\nInterviews will be held at Chargebee Chennai office.').label).toBe('Company Office · Chennai');
    expect(display('Test will be held at VIT Bhopal Lab 1.\nInterviews will be held at VIT Bhopal auditorium.').label).toBe('VIT Bhopal');
  });
  it('requires campus attendance even when the test platform is online', () => {
    expect(display('Online test will be conducted at Bhopal LC.', 'Test').label).toBe('VIT Bhopal');
  });
  it.each(['Online test is scheduled at PRP 717.', 'Online test is scheduled by 2.30 pm @ PRP 706.', 'Online test is scheduled at Pearl Research Park (PRP 713).'])('keeps physical attendance for %s', text => {
    const label = display(text, 'Test').label;
    expect(label).not.toBe('Online');
    expect(label).not.toBe('To be announced');
  });
  it('does not infer remote attendance just from the words online test', () => {
    expect(display('Online test is scheduled on 21st July.', 'Test').label).toBe('To be announced');
  });
  it('distinguishes attendance location while both tests use an online platform', () => {
    expect(display('Online test is scheduled at own location.', 'Test').label).toBe('Own location');
    expect(display('Online test is scheduled at PRP 717.', 'Test').label).toBe('PRP 717');
    expect(display('Online test is scheduled at respective campus labs.', 'Test', 'VIT Bhopal').label).toBe('VIT Bhopal');
  });
  it('reads dated venue cells in a registration circular', () => {
    expect(display('Online Test : 05-10-2026 @ Own location\nInterviews : 12-10-2026 @ VIT Vellore campus').label).toBe('VIT Vellore');
  });
  it('reads an online assessment headline that omits the word test', () => {
    expect(display('Assessment Details\nMode: Online', 'Larsen & Toubro Online is scheduled on 5th Oct - Virtual mode @ Own location').label).toBe('Own location');
  });
  it('keeps campus venue tables scoped and overrides a generic virtual headline', () => {
    const entries=projection(extractRecruitmentVenues('Chubb virtual interview is scheduled tomorrow', 'Vellore Campus – PRP 723\nAP CAMPUS: CDC Office (CB-312)\nBhopal Campus - L3103\nChennai Campus - AB2-603\nOther campus students are asked to report to their respective campus CDC office or campus labs.'));
    expect(resolveDriveVenue(entries,'VIT Bhopal').label).toBe('L3103');
    expect(resolveDriveVenue(entries,'VIT Vellore').label).toBe('PRP 723');
  });
  it('qualifies a headline lab with universal respective-campus attendance', () => {
    expect(display('All the students must attend the Test in the respective campus Venues only.', 'Sandisk Online Test is scheduled tomorrow @PRP 717','VIT Bhopal').label).toBe('VIT Bhopal');
  });
  it('does not treat the warning against own-location attendance as permission', () => {
    expect(display('Students must attend the Online test from the CDC Labs only.\nStudents who are attending the test from their own location will be suspended for further placement process.', 'Voxela online test is scheduled tomorrow at PRP715').label).toBe('PRP715');
  });
  it('accepts exact lab reporting without guessing which round it is', () => {
    expect(display('Please carry an original photo id and report to LC with your user id and password.', 'Infosys slot 2 2 pm').label).toBe('LC');
    expect(display('Students must attend virtual interviews from the campus.', 'Blackrock next round of selection process', 'VIT Bhopal').label).toBe('VIT Bhopal');
    expect(display('Placed students need to report to LC 101 to help with Infosys.', 'Infosys + Biometric').label).toBe('To be announced');
  });
  it('uses required campus attendance despite a virtual interview headline', () => {
    expect(display('Other campus students are asked to report to their respective campus CDC office or campus labs.', 'Fischer Jordan virtual interview scheduled tomorrow', 'VIT Bhopal').label).toBe('VIT Bhopal');
  });
  it('separates a PPT venue from the online test that follows it', () => {
    expect(display('Online Test is scheduled at PRP 717 by 3.30 pm.', 'Responsive Physical Pre Placement Talk followed by Online Test is scheduled tomorrow at Sarojini Naidu gallery').label).toBe('Multiple locations');
  });
  it('distinguishes a CDC office from a company office', () => {
    expect(display('Interviews will be held at CDC office.', 'Interviews').label).toBe('CDC office');
    expect(display('Interviews will be held at CDC office, SJT 7th floor - VIT Vellore campus.', 'Interviews').label).toBe('VIT Vellore');
    expect(display('Interviews will be held at respective CDC office.', 'Interviews', 'VIT Bhopal').label).toBe('VIT Bhopal');
  });
  it('includes generic later selection-round venues after a remote PPT', () => {
    expect(display('PPT will be conducted from own location.\nNext round of selection process will be held at VIT Vellore campus.')).toEqual({label:'VIT Vellore',detail:'PPT: Own location; Recruitment: VIT Vellore'});
  });
  it('keeps explicit Bhopal/AP virtual exceptions scoped to those campuses', () => {
    const entries=projection(extractRecruitmentVenues('Caterpillar Interviews', 'Interviews will be held at VIT Vellore campus.\nChennai Students need to attend physical at Vellore, Bhopal & AP Campus will have virtual interviews.'));
    expect(resolveDriveVenue(entries,'VIT Bhopal').label).toBe('Own location');
    expect(resolveDriveVenue(entries,'VIT AP').label).toBe('Own location');
    expect(resolveDriveVenue(entries,'VIT Vellore').label).toBe('VIT Vellore');
  });
  it('does not interpret conditional physical/virtual interview types as remote attendance', () => {
    expect(display('Students with interview type physical must report to VIT Vellore; interview type virtual must report to respective CDC venues.', 'Interviews').label).not.toBe('Online');
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
