import { describe, expect, it } from 'vitest';
import { extractRecruitmentVenues, resolveDriveMode, resolveDriveVenue, type VenueEntry } from './drive-venues';

const projection = (entries: VenueEntry[]) => ({ version: 1, entries: entries.map(entry => ({ ...entry, sourceId: 'this-drive-source', receivedAt: '2026-10-09T07:00:00Z' })) });
const display = (body: string, subject = 'Registration', campus: string | undefined = 'VIT Bhopal') => resolveDriveMode(projection(extractRecruitmentVenues(subject, body)), campus);

describe('five fixed attendance modes', () => {
  it.each(['Test will be conducted in various labs in the college campus',
    '1. Test will be conducted in various labs in college campuses'])('reads the actual Infosys assessment guideline: %s', body => {
    expect(display(body, '')).toMatchObject({ label: 'Home Campus', shortVenue: 'LC', requiresTravel: false,
      rounds: [{ stage: 'Test', mode: 'Home Campus', venue: 'LC' }] });
    expect(display(body, '', 'VIT Chennai')).toMatchObject({ label: 'Home Campus', requiresTravel: false });
  });
  it('reads Infosys regular recruitment in person on the recipient campus', () => {
    expect(display('Our recruitment program will be conducted in person on your campus. The\nevaluation is designed to identify candidates.', 'Infosys Regular Offer Registration 2027 Batch.'))
      .toMatchObject({ label: 'Home Campus', shortVenue: 'LC', requiresTravel: false });
  });
  it('keeps a confirmed local Infosys interview round separate from earlier host-campus instructions', () => {
    const entries = extractRecruitmentVenues('Infosys next round', 'Please report to the campus at the earliest\nCompetency Evaluation: During the interview, candidates will be evaluated on technical and behavioral skills.');
    expect(entries).toEqual([expect.objectContaining({ stage: 'Interviews', kind: 'respective' })]);
    expect(resolveDriveMode(projection(entries), 'VIT Bhopal')).toMatchObject({ label: 'Home Campus', shortVenue: 'LC', requiresTravel: false });
  });
  it('ignores the Infosys mock-interview and biometric training notice', () => {
    expect(display('The training for Infosys students and mock interviews will start tomorrow.\nReport to LC 202 at 9.30 am if you want to attend the\nmock interviews and get guidance for the interviews.', 'Infosys + Biometric').label).toBe('TBA');
  });
  it('keeps the UBS physical process at Chennai separate from its virtual PPT and later virtual interview', () => {
    const entries = extractRecruitmentVenues('Update: UBS- Super Dream Internship / Placement - 2027 Batch',
      'Date of Visit:\n*17-08-2026 - PPT Virtual mode*\n*19-08-2026 - Physical process at Chennai campus (For all)*\nEligible Branches\nB.Tech CS & IT\nJob Location: Pune / Hyderabad');
    const mode = resolveDriveMode(projection([...entries,
      ...extractRecruitmentVenues('UBS next round of selection process is scheduled on 28th August 2026 - Virtual',
        'They will have a virtual interview on 28/08/2026, other details will be shared by the company directly.'),
    ]), 'VIT Bhopal');
    expect(mode).toMatchObject({ label: 'Other Campus', shortVenue: 'VIT Chennai', requiresTravel: true });
    expect(mode.rounds).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'PPT', mode: 'Own Location', venue: 'Virtual' }),
      expect.objectContaining({ stage: 'Physical Process', mode: 'Other Campus', venue: 'VIT Chennai' }),
      expect.objectContaining({ stage: 'Interviews', mode: 'Own Location', venue: 'Virtual' }),
    ]));
    expect(resolveDriveMode(projection(entries), 'VIT Chennai')).toMatchObject({ label: 'Home Campus', requiresTravel: false });
  });
  it('reads the original UBS dated physical interview without borrowing a work location', () => {
    expect(display('Date of Visit:\n17-08-2026 - PPT Virtual mode\n19-08-2026 - Interviews Physical at Vellore campus\nJob Location: Chennai'))
      .toMatchObject({ label: 'Other Campus', shortVenue: 'VIT Vellore', requiresTravel: true });
  });
  it.each(['Physical process may be at Chennai campus', 'Physical process not at Chennai campus', 'Physical process at Chennai', 'Physical process location will be informed later'])('requires confirmed campus attendance for %s', body => {
    expect(display(body).label).toBe('TBA');
  });
  it('reads Tata Technologies physical interview venue from the registration subject despite an unknown visit date', () => {
    const subject = 'Tata Technologies Dream core placement registration 2027 Batch - Physical interview at vellore campus';
    const mode = display('Date of Visit:\nwill be informed later\nJob location: Pune / Bangalore / Thane\nTest will be conducted from own location.', subject);
    expect(mode).toMatchObject({ label: 'Other Campus', shortVenue: 'VIT Vellore', requiresTravel: true });
    expect(mode.rounds).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'Interviews', mode: 'Other Campus', venue: 'VIT Vellore', requiresTravel: true }),
      expect.objectContaining({ stage: 'Test', mode: 'Own Location', requiresTravel: false }),
    ]));
    expect(display('Date of Visit:\nwill be informed later', subject, 'VIT Vellore')).toMatchObject({ label: 'Home Campus', requiresTravel: false });
  });
  it.each(['Interviews at VIT Vellore', 'Physical interviews in Vellore campus'])('reads a compact confirmed interview venue: %s', subject => {
    expect(display('', subject)).toMatchObject({ label: 'Other Campus', shortVenue: 'VIT Vellore', requiresTravel: true });
  });
  it('retains an explicit conflicting venue announcement rather than treating it like an unknown date', () => {
    expect(display('Interview venue: TBA', 'Physical interview at Vellore campus').label).toBe('TBA');
  });
  it.each(['Physical interview may be at Vellore campus', 'Physical interview not at Vellore campus', 'Interviews at VIT Vellore might be held there', 'Registration for Vellore campus students'])('does not turn uncertain or audience-only headlines into confirmed attendance: %s', subject => {
    expect(display('', subject).label).toBe('TBA');
  });
  it.each(['EXL Service', 'Ecolab'])('shows %s as Own Location from its virtual registration visit', name => {
    expect(display('Date of Visit:\n\n*Virtual*\n\nEligible Branches\nB. Tech', `${name} registration`)).toMatchObject({
      label: 'Own Location', requiresTravel: false, rounds: [{ stage: 'Recruitment', mode: 'Own Location', venue: 'Virtual' }],
    });
  });
  it('normalizes LTM remote attendance to Own Location while retaining the venue', () => {
    expect(display('', 'LTM Online test is scheduled on October 04, 2026 - Virtual Mode @ Own location')).toMatchObject({
      label: 'Own Location', rounds: [{ stage: 'Test', mode: 'Own Location', venue: 'Own location' }],
    });
  });
  it.each(['Test will be conducted from home.', 'Interviews will be held remotely.', 'Test will be conducted online from own location.'])('recognizes remote attendance: %s', body => {
    expect(display(body).label).toBe('Own Location');
  });
  it('shows Responsive at Other Campus for a Bhopal student and Home Campus for a Vellore student', () => {
    const body = 'Date of Visit:\n26 st Oct PPT 2 pm , TEST - 4 pm physical for vellore students\n29th Oct Physical process - at VIT Vellore';
    expect(display(body, 'Responsive registration')).toMatchObject({ label: 'Other Campus', shortVenue: 'VIT Vellore', requiresTravel: true,
      rounds: [{ stage: 'Physical Process', mode: 'Other Campus', venue: 'VIT Vellore' }] });
    expect(display(body, 'Responsive registration', 'VIT Vellore')).toMatchObject({ label: 'Home Campus', requiresTravel: false });
  });
  it('shows LeadSquared at Other Campus with each confirmed round and its actual venue', () => {
    const mode = display('Online Test: 15th October @ respective campus venues.\nPPT & Interviews: 27th October @ VIT Vellore campus.', 'LeadSquared registration');
    expect(mode).toMatchObject({ label: 'Other Campus', shortVenue: 'VIT Vellore', requiresTravel: true });
    expect(mode.rounds).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'Test', mode: 'Home Campus', venue: 'VIT Bhopal', requiresTravel: false }),
      expect.objectContaining({ stage: 'PPT', mode: 'Other Campus', venue: 'VIT Vellore', requiresTravel: true }),
      expect.objectContaining({ stage: 'Interviews', mode: 'Other Campus', venue: 'VIT Vellore', requiresTravel: true }),
    ]));
  });
  it('requires physical campus attendance even when the test platform is online', () => {
    expect(display('Online test is scheduled at PRP 717.', 'Test')).toMatchObject({ label: 'Other Campus', shortVenue: 'VIT Vellore', requiresTravel: true,
      rounds: [{ stage: 'Test', mode: 'Other Campus', venue: 'PRP 717' }] });
    expect(display('Test venue: LC 102', 'Test')).toMatchObject({ label: 'Home Campus', shortVenue: 'LC 102', requiresTravel: false,
      rounds: [{ stage: 'Test', mode: 'Home Campus', venue: 'VIT Bhopal · LC 102' }] });
  });
  it.each(['Test will be held at respective campus venues.', 'Test will be held at VIT Bhopal.'])('uses LC as the short home-campus destination without needing the word labs: %s', body => {
    const value = projection(extractRecruitmentVenues('Test', body));
    const before = JSON.stringify(value);
    expect(resolveDriveMode(value, 'VIT Bhopal')).toMatchObject({ label: 'Home Campus', shortVenue: 'LC', requiresTravel: false,
      rounds: [{ mode: 'Home Campus', venue: 'VIT Bhopal' }] });
    expect(JSON.stringify(value)).toBe(before);
    if (body.includes('VIT Bhopal')) {
      expect(resolveDriveMode(value, 'VIT Chennai')).toMatchObject({ label: 'Other Campus', shortVenue: 'VIT Bhopal', requiresTravel: true });
    }
  });
  it('classifies a campus-scoped room without adding the room name to the mode', () => {
    expect(display('Bhopal Campus - L3103', 'Interviews')).toMatchObject({ label: 'Home Campus', shortVenue: 'LC 103', requiresTravel: false,
      rounds: [{ stage: 'Interviews', mode: 'Home Campus', venue: 'LC 103' }] });
  });
  it('applies the Bhopal room correction only in display, without rewriting historical evidence', () => {
    const value = projection(extractRecruitmentVenues('Chubb interviews', 'Bhopal Campus - L3103'));
    const before = JSON.stringify(value);
    const originalVenue = resolveDriveVenue(value, 'VIT Bhopal');
    expect(resolveDriveMode(value, 'VIT Bhopal').rounds[0].venue).toBe('LC 103');
    expect(value.entries[0].name).toBe('L3103');
    expect(value.entries[0].quote).toContain('L3103');
    expect(JSON.stringify(value)).toBe(before);
    expect(resolveDriveVenue(value, 'VIT Bhopal')).toEqual(originalVenue);
  });
  it('does not generalize the Bhopal room correction to other campuses or room numbers', () => {
    expect(display('Chennai Campus - L3103', 'Interviews', 'VIT Chennai').rounds[0].venue).toBe('L3103');
    expect(display('Bhopal Campus - L3104', 'Interviews').rounds[0].venue).toBe('L3104');
  });
  it.each(['Interviews will be held at Chargebee Chennai office.', 'Interviews will be held at Grand Hotel.'])('uses External Venue for a confirmed external venue: %s', body => {
    expect(display(body)).toMatchObject({ label: 'External Venue', requiresTravel: true });
    expect(display(body).rounds[0].venue).toMatch(/Chargebee Chennai office|Grand Hotel/);
  });
  it('prioritizes physical attendance and lists both remote and physical rounds', () => {
    const mode = display('Test will be conducted from own location.\nInterviews will be held at Chargebee Chennai office.');
    expect(mode).toMatchObject({ label: 'External Venue', shortVenue: 'Chargebee Chennai office' });
    expect(mode.rounds).toEqual([
      expect.objectContaining({ stage: 'Test', mode: 'Own Location', venue: 'Own location', requiresTravel: false }),
      expect.objectContaining({ stage: 'Interviews', mode: 'External Venue', venue: 'Chargebee Chennai office', requiresTravel: true }),
    ]);
  });
  it('requires known student location before resolving respective-campus attendance', () => {
    const value = projection(extractRecruitmentVenues('Test', 'Test will be held at respective campus labs.'));
    expect(resolveDriveMode(value)).toMatchObject({ label: 'TBA', rounds: [{ mode: 'TBA', venue: 'TBA' }] });
    expect(resolveDriveMode(value, 'VIT Chennai')).toMatchObject({ label: 'Home Campus', shortVenue: 'VIT Chennai', requiresTravel: false,
      rounds: [{ mode: 'Home Campus', venue: 'VIT Chennai' }] });
  });
  it('shows unspecified respective Bhopal labs as LC without inventing a room or changing evidence', () => {
    const value = projection(extractRecruitmentVenues('Axxela test', 'Test will be held at respective campus labs.'));
    const before = JSON.stringify(value);
    const notificationVenue = resolveDriveVenue(value, 'VIT Bhopal');
    expect(resolveDriveMode(value, 'VIT Bhopal')).toMatchObject({ label: 'Home Campus', shortVenue: 'LC', requiresTravel: false,
      rounds: [{ stage: 'Test', mode: 'Home Campus', venue: 'LC' }] });
    expect(JSON.stringify(value)).toBe(before);
    expect(resolveDriveVenue(value, 'VIT Bhopal')).toEqual(notificationVenue);
  });
  it('does not guess home versus other campus when the student campus is unknown', () => {
    const value = projection(extractRecruitmentVenues('Interviews', 'Interviews will be held at VIT Vellore.'));
    expect(resolveDriveMode(value)).toMatchObject({ label: 'TBA', rounds: [{ mode: 'TBA', venue: 'VIT Vellore' }] });
    expect(resolveDriveMode(value).requiresTravel).toBeUndefined();
  });
  it('resolves home and other campuses for Chennai students without hard-coding Bhopal', () => {
    expect(display('Interviews will be held at VIT Chennai.', 'Interviews', 'VIT Chennai')).toMatchObject({ label: 'Home Campus', requiresTravel: false });
    expect(display('Interviews will be held at VIT Bhopal.', 'Interviews', 'VIT Chennai')).toMatchObject({ label: 'Other Campus', shortVenue: 'VIT Bhopal', requiresTravel: true });
  });
  it('keeps an unconfirmed round visible and avoids claiming the entire drive is remote', () => {
    const value = projection([
      { stage: 'Test', kind: 'online', name: 'Online', quote: 'Test from own location' },
      { stage: 'Interviews', kind: 'unknown', name: '', quote: 'Interview venue: TBA' },
    ]);
    expect(resolveDriveMode(value, 'VIT Bhopal')).toMatchObject({ label: 'TBA', rounds: [
      { stage: 'Test', mode: 'Own Location' }, { stage: 'Interviews', mode: 'TBA', venue: 'TBA' },
    ] });
  });
  it('applies only the current student audience and preserves campus exceptions', () => {
    const value = projection(extractRecruitmentVenues('Interviews at VIT Vellore', 'Interviews will be held at VIT Vellore.\nBhopal & AP campus will have virtual interviews.'));
    expect(resolveDriveMode(value, 'VIT Bhopal').label).toBe('Own Location');
    expect(resolveDriveMode(value, 'VIT Vellore')).toMatchObject({ label: 'Home Campus', requiresTravel: false });
  });
  it.each(['Job Location: Chennai', 'Online test is scheduled on October 10.', 'Register online on NeoPAT.', 'Interview venue: TBA', ''])('defaults to TBA without confirmed attendance evidence: %s', body => {
    expect(display(body, 'Hitachi registration').label).toBe('TBA');
  });
  it('keeps sibling drives isolated and does not modify historical data or notification formatting', () => {
    const oldDrive = projection(extractRecruitmentVenues('Test', 'Test will be held at VIT Bhopal.'));
    const freshDrive = projection(extractRecruitmentVenues('Hitachi registration', 'Job Location: Chennai'));
    const snapshot = JSON.stringify(oldDrive);
    const notificationVenue = resolveDriveVenue(oldDrive, 'VIT Bhopal');
    expect(resolveDriveMode(oldDrive, 'VIT Bhopal').label).toBe('Home Campus');
    expect(resolveDriveMode(freshDrive, 'VIT Bhopal').label).toBe('TBA');
    expect(JSON.stringify(oldDrive)).toBe(snapshot);
    expect(resolveDriveVenue(oldDrive, 'VIT Bhopal')).toEqual(notificationVenue);
  });
});
