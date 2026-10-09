import { describe, expect, it } from 'vitest';
import { extractRecruitmentVenues, resolveDriveMode, resolveDriveVenue, type VenueEntry } from './drive-venues';

const projection = (entries: VenueEntry[]) => ({ version: 1, entries: entries.map(entry => ({ ...entry, sourceId: 'this-drive-source', receivedAt: '2026-10-09T07:00:00Z' })) });
const display = (body: string, subject = 'Registration', campus: string | undefined = 'VIT Bhopal') => resolveDriveMode(projection(extractRecruitmentVenues(subject, body)), campus);

describe('five fixed attendance modes', () => {
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
      rounds: [{ stage: 'Recruitment', mode: 'Other Campus', venue: 'VIT Vellore' }] });
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
