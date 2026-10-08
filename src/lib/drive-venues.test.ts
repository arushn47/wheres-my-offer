import { describe, expect, it } from 'vitest';
import { extractRecruitmentVenues, knownCampus, resolveDriveVenue, type VenueEntry } from './drive-venues';
import { getEvidenceMessageText } from './sync/extraction/body';

const projection = (entries: VenueEntry[]) => ({ version: 1, entries: entries.map(e => ({ ...e, sourceId: 'canonical-1407', receivedAt: '2026-10-07T12:00:00Z' })) });
const display = (body: string, subject = 'Chargebee registration', campus?: string) => resolveDriveVenue(projection(extractRecruitmentVenues(subject, body)), campus);
describe('explicit drive venue display', () => {
  it('keeps LeadSquared Vellore PPT/interviews separate from the respective-campus test', () => {
    const body='Online Test : 15th October 2026 (2 PM) @ respective campus venues.PPT &\nInterviews : 27th October 2026 from 9 AM onwards @ VIT Vellore campus';
    const entries=extractRecruitmentVenues('LeadSquared : Registration : Super Dream Internship - 2027 Batch',body);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({stage:'Test',kind:'respective'}),
      expect.objectContaining({stage:'PPT',kind:'campus',name:'VIT Vellore'}),
      expect.objectContaining({stage:'Interviews',kind:'campus',name:'VIT Vellore'}),
    ]));
    expect(entries.filter(e=>['PPT','Interviews'].includes(e.stage)).every(e=>!e.audience)).toBe(true);
    expect(resolveDriveVenue(projection(entries),'VIT Bhopal')).toMatchObject({label:'VIT Vellore',requiresTravel:true});
  });
  it('does not apply a home-campus test venue to a separate Vellore interview row', () => {
    expect(display('Test: 15 October @ respective campus labs.\nInterviews: 27 October @ VIT Vellore campus.', 'Registration', 'VIT Bhopal')).toMatchObject({label:'VIT Vellore',requiresTravel:true});
  });
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
    expect(resolveDriveVenue({ version: 1, entries: [...oldDrive.entries, ...currentDrive.entries] }).label).toBe('Company Office · Chennai');
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
    expect(display('Online test is scheduled at PRP 717.', 'Test').label).toBe('VIT Vellore');
    expect(display('Online test is scheduled at respective campus labs.', 'Test', 'VIT Bhopal').label).toBe('Bhopal LC');
  });
  it('reads dated venue cells in a registration circular', () => {
    expect(display('Online Test : 05-10-2026 @ Own location\nInterviews : 12-10-2026 @ VIT Vellore campus').label).toBe('VIT Vellore');
  });
  it('reads an online assessment headline that omits the word test', () => {
    expect(display('Assessment Details\nMode: Online', 'Larsen & Toubro Online is scheduled on 5th Oct - Virtual mode @ Own location').label).toBe('Own location');
  });
  it('keeps campus venue tables scoped and overrides a generic virtual headline', () => {
    const entries=projection(extractRecruitmentVenues('Chubb virtual interview is scheduled tomorrow', 'Vellore Campus – PRP 723\nAP CAMPUS: CDC Office (CB-312)\nBhopal Campus - L3103\nChennai Campus - AB2-603\nOther campus students are asked to report to their respective campus CDC office or campus labs.'));
    expect(resolveDriveVenue(entries,'VIT Bhopal').label).toBe('Bhopal LC');
    expect(resolveDriveVenue(entries,'VIT Vellore').label).toBe('VIT Vellore');
  });
  it('qualifies a headline lab with universal respective-campus attendance', () => {
    expect(display('All the students must attend the Test in the respective campus Venues only.', 'Sandisk Online Test is scheduled tomorrow @PRP 717','VIT Bhopal').label).toBe('Bhopal LC');
  });
  it('does not treat the warning against own-location attendance as permission', () => {
    expect(display('Students must attend the Online test from the CDC Labs only.\nStudents who are attending the test from their own location will be suspended for further placement process.', 'Voxela online test is scheduled tomorrow at PRP715').label).toBe('VIT Vellore');
  });
  it('accepts exact lab reporting without guessing which round it is', () => {
    expect(display('Please carry an original photo id and report to LC with your user id and password.', 'Infosys slot 2 2 pm', 'VIT Bhopal').label).toBe('Bhopal LC');
    expect(display('Students must attend virtual interviews from the campus.', 'Blackrock next round of selection process', 'VIT Bhopal').label).toBe('Bhopal LC');
    expect(display('Placed students need to report to LC 101 to help with Infosys.', 'Infosys + Biometric').label).toBe('To be announced');
  });
  it('uses required campus attendance despite a virtual interview headline', () => {
    expect(display('Other campus students are asked to report to their respective campus CDC office or campus labs.', 'Fischer Jordan virtual interview scheduled tomorrow', 'VIT Bhopal').label).toBe('Bhopal LC');
  });
  it('separates a PPT venue from the online test that follows it', () => {
    expect(display('Online Test is scheduled at PRP 717 by 3.30 pm.', 'Responsive Physical Pre Placement Talk followed by Online Test is scheduled tomorrow at Sarojini Naidu gallery').label).toBe('VIT Vellore');
  });
  it('distinguishes a CDC office from a company office', () => {
    expect(display('Interviews will be held at CDC office.', 'Interviews').label).toBe('VIT Vellore');
    expect(display('Interviews will be held at CDC office, SJT 7th floor - VIT Vellore campus.', 'Interviews').label).toBe('VIT Vellore');
    expect(display('Interviews will be held at respective CDC office.', 'Interviews', 'VIT Bhopal').label).toBe('Bhopal LC');
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
  it('honors the actual Celebal body exception instead of the physical SJT headline', () => {
    const body = 'Please find the attached students shortlisted list\nChennai campus students must physically attend the drive at VIT Vellore\nFor Bhopal and AP campus the drive will be virtual\nNote: Candidates failed to attend the interview will be blacklisted from further placements';
    const entries = projection(extractRecruitmentVenues('Celebal Technologies physical selection process is scheduled on 30th September 2026 by 10:00 am at SJT 717', body));
    expect(resolveDriveVenue(entries, 'VIT Bhopal')).toMatchObject({ label: 'Own location', requiresTravel: false });
    expect(resolveDriveVenue(entries, 'VIT AP')).toMatchObject({ label: 'Own location', requiresTravel: false });
    expect(resolveDriveVenue(entries, 'VIT Chennai')).toMatchObject({ label: 'VIT Vellore', requiresTravel: true });
    expect(resolveDriveVenue(entries, 'VIT Vellore')).toMatchObject({ label: 'VIT Vellore', requiresTravel: false });
  });
  it.each(['SJT 717', 'PRP717', 'PRP 717', 'Pearl Research Park'])('maps %s to Vellore and marks travel from Bhopal', room => {
    const venue = display(`Test will be held at ${room}.`, 'Online test', 'VIT Bhopal');
    expect(venue).toMatchObject({ label: 'VIT Vellore', requiresTravel: true });
    expect(venue.detail).toContain(room);
  });
  it('handles a campus-specific virtual instruction without the word campus', () => {
    expect(display('For Bhopal and AP, the drive will be virtual.', 'Test scheduled at PRP717', 'VIT Bhopal')).toMatchObject({ label: 'Own location', requiresTravel: false });
  });
  it('scopes Zanskar virtual campus attendance separately from its SJT headline', () => {
    const venue = display('For AP and Bhopal interviews will be conducted virtually from the\nrespective campus venues.\nVellore and Chennai campus should attend the interviews from VIT Vellore campus.', 'Zanskar next round of selection process is scheduled at SJT 717 CDC Office', 'VIT Bhopal');
    expect(venue).toMatchObject({ label: 'Bhopal LC', requiresTravel: false });
  });
  it('handles a changed venue headline and hyphenated Bhopal/AP virtual exceptions', () => {
    const venue = display('VIT - Bhopal & VIT - AP shortlist, interview will be in virtual mode.', 'Fwd: Updated venue : KPMG next round of selection process is scheduled by 9 AM at Smart Room 703, SJT 7th floor - VIT Vellore campus.', 'VIT Bhopal');
    expect(venue).toMatchObject({ label: 'Own location', requiresTravel: false });
  });
  it('does not assign the Vellore headline to other campuses with their own venue arrangements', () => {
    expect(display('For other campuses, the respective CDC Office will update the venue.', 'Schneider next round of selection process is scheduled at SJT 717', 'VIT Bhopal').label).toBe('Bhopal LC');
  });
  it('honors virtual exceptions for a gallery headline naming Vellore without the VIT prefix', () => {
    expect(display('Bhopal & AP campus will have virtual interviews.', 'Caterpillar selection process is scheduled at Sarojini Naidu Gallery Vellore', 'VIT Bhopal')).toMatchObject({ label: 'Own location', requiresTravel: false });
  });
  it('shows an actual away destination when separate physical rounds require travel', () => {
    const value = display('PPT will be held at VIT Bhopal.\nTest will be held at VIT Vellore.\nInterviews will be held at Chargebee Chennai office.', 'Drive', 'VIT Bhopal');
    expect(value).toMatchObject({ label: 'Company Office · Chennai', requiresTravel: true });
    expect(value.detail).toContain('VIT Vellore');
    expect(display('Test will be held at respective campus labs.', 'Test', 'VIT Bhopal')).toMatchObject({ label: 'Bhopal LC', requiresTravel: false });
  });
  it.each(['CDC office', 'Sarojini Naidu gallery', 'Dr.Channa Reddy Auditorium'])('recognizes %s as Vellore while respecting campus arrangements', room => {
    const subject = `Conneqtiongroup PPT & online test is scheduled tomorrow at ${room}`;
    expect(display('', subject, 'VIT Bhopal')).toMatchObject({label:'VIT Vellore',requiresTravel:true});
    expect(display('Note: Other campus Venue details will be informed by your campus team.', subject, 'VIT Bhopal')).toMatchObject({label:'Bhopal LC',requiresTravel:false});
  });
  it('handles bold and indented soft-wrapped campus exceptions', () => {
    const body = '- *Chennai & AP Campus Students:* Students are required to travel\n  to the *VIT\n Vellore Campus tomorrow*.\n- *Bhopal Campus Students:* The *entire selection process will be\n conducted virtually*.';
    expect(display(body, 'Deloitte Group Discussion is scheduled at SJT 717', 'VIT Bhopal')).toMatchObject({label:'Own location',requiresTravel:false});
    expect(display(body, 'Deloitte Group Discussion is scheduled at SJT 717', 'VIT Chennai')).toMatchObject({label:'VIT Vellore',requiresTravel:true});
  });
  it('keeps virtual GD attendance at the respective campus CDC lab', () => {
    const body = '*VIT AP & VIT Bhopal shortlisted candidates will have GD in virtual mode,\nlink and other details will be shared to their respective email IDs\nshortly. (Candidates are informed to take the GD only in respective campus\nCDC office)*';
    expect(display(body, 'KPMG Group Discussion at SJT 717', 'VIT Bhopal')).toMatchObject({label:'Bhopal LC',requiresTravel:false});
    expect(display('VIT Bhopal & VIT AP shortlist, interview will be in virtual mode (candidates are informed to take only in CDC office).', 'KPMG interview is scheduled at SJT 717', 'VIT Bhopal')).toMatchObject({label:'Bhopal LC',requiresTravel:false});
  });
  it('uses LC room numbers as home-campus labs rather than a travel destination', () => {
    expect(display('Test venue: LC 102', 'Conneqtiongroup online test', 'VIT Bhopal')).toMatchObject({label:'Bhopal LC',requiresTravel:false});
    expect(display('Test venue: LC 102', 'Conneqtiongroup online test', 'VIT Bhopal').detail).toContain('LC 102');
    expect(display('Test venue: VIT Vellore LC', 'Test', 'VIT Bhopal')).toMatchObject({label:'VIT Vellore',requiresTravel:true});
  });
  it('keeps a universal travel destination when another campus is also told to travel there', () => {
    expect(display('Chennai campus students should travel to Vellore campus for the interview.', 'ZS Associates next round of selection process is scheduled at Sarojini Naidu Gallery', 'VIT Bhopal')).toMatchObject({label:'VIT Vellore',requiresTravel:true});
  });
  it('applies local campus arrangements to both PPT and the test that follows', () => {
    expect(display('Online Test is scheduled at PRP 717 after the PPT.\nVenues for the other campus will be shared by the respective campuses.', 'Responsive PPT followed by Online Test is scheduled at Sarojini Naidu Gallery', 'VIT Bhopal')).toMatchObject({label:'Bhopal LC',requiresTravel:false});
  });
  it.each(['BHOPAL Campus virtual process.', 'Note : Bhopal campus students will be connected virtually.', ', Bhopal\n, AP can attend the interviews virtually.'])('recognizes the compact campus exception: %s', body => {
    expect(display(body, 'Selection process is scheduled at SJT 717', 'VIT Bhopal')).toMatchObject({label:'Own location',requiresTravel:false});
  });
  it('extracts a virtual exception inside a dated interview table cell', () => {
    expect(display('Interview Date: 15.10.2026 @ VIT Vellore campus (VIT AP & VIT Bhopal shortlist in virtual mode)', 'Malomatia registration', 'VIT Bhopal')).toMatchObject({label:'Own location',requiresTravel:false});
  });
  it('does not let a bare reminder revoke the earlier campus routing', () => {
    const original=extractRecruitmentVenues('Groww PPT is scheduled at Channa Reddy Auditorium', 'For other campuses, the respective CDC Office will update the venue.');
    const reminder=extractRecruitmentVenues('Re: Groww PPT is scheduled at Channa Reddy Auditorium', 'Report immediately.');
    expect(resolveDriveVenue(projection([...original,...reminder]),'VIT Bhopal')).toMatchObject({label:'Bhopal LC',requiresTravel:false});
  });
  it('retains a scoped virtual interview exception in a generic selection-round reminder', () => {
    const original=extractRecruitmentVenues('Fastenal interview is scheduled at SJT 717', 'Bhopal campus students will be connected virtually.');
    const reminder=extractRecruitmentVenues('Fastenal next round of selection process is scheduled at SJT 717', 'Report immediately.');
    expect(resolveDriveVenue(projection([...original,...reminder]),'VIT Bhopal')).toMatchObject({label:'Own location',requiresTravel:false});
    const changed=extractRecruitmentVenues('Fastenal next round', 'All shortlisted students must attend the selection process at VIT Vellore.');
    expect(resolveDriveVenue(projection([...original,...changed]),'VIT Bhopal')).toMatchObject({label:'VIT Vellore',requiresTravel:true});
  });
  it.each(["Note: Other campus students' venues & details will be informed by your\ncampus team.", 'Other campus students check with your campus for the venue.', 'Other campus students must report to their respective campus CDC offices.'])('keeps local attendance for %s', body => {
    expect(display(body, 'Test is scheduled at SJT 717', 'VIT Bhopal')).toMatchObject({label:'Bhopal LC',requiresTravel:false});
  });
  it('requires travel when other campuses are explicitly told to report to Chennai', () => {
    expect(display('Other campus shortlisted candidates are informed to report in VIT Chennai campus for the interview process.', 'Nuaav next round of selection process is scheduled at VIT Chennai campus', 'VIT Bhopal')).toMatchObject({label:'VIT Chennai',requiresTravel:true});
  });
  it('reads American Express compact campus lab lists and preserves them across generic CDC reminders', () => {
    const original=extractRecruitmentVenues('American Express next round of selection process is scheduled tomorrow - Vellore students PRP 717, CHENNAI, BHOPAL, AP respective CDC Labs', 'All candidates are informed to join the interview link.\nVellore students PRP 717, CHENNAI, BHOPAL, AP respective CDC Labs');
    const later=extractRecruitmentVenues('American Express next round of selection process', 'Report to the CDC Office for the interviews.');
    expect(resolveDriveVenue(projection([...original,...later]), 'VIT Bhopal')).toMatchObject({label:'Bhopal LC',requiresTravel:false});
    expect(resolveDriveVenue(projection(original), 'VIT Vellore')).toMatchObject({label:'VIT Vellore',requiresTravel:false});
  });
  it('does not treat a virtual platform plan as permission to ignore actual CDC attendance', () => {
    expect(display('Students are said to attend the interviews at CDC office only.', 'Apple next round (SRE)', 'VIT Bhopal')).toMatchObject({label:'VIT Vellore',requiresTravel:true});
    expect(display('Report to the CDC Office for the interviews.', 'Interviews', 'VIT Bhopal')).toMatchObject({label:'VIT Vellore',requiresTravel:true});
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
