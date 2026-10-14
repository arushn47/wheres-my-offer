import { describe, expect, it } from 'vitest';
import { EY_COMPANY_NAME, getParentCompanyName, getEyDriveName, isEyCompany, matchesEyDriveName } from './company-identity';
import { getDriveDisplayName } from './drive-display';
import { extractCompanyName } from './sync/classification/classifier';

describe('EY parent company and drive identity', () => {
  it.each(['EY', 'EY SAP', 'EY GDS', 'EY INDIA', 'EY (Ernst & Young)', 'Ernst and Young'])('maps %s to the parent employer', (name) => {
    expect(getParentCompanyName(name)).toBe(EY_COMPANY_NAME);
  });

  it.each(['SAP', 'Keyence', 'Money India', 'EYeball Technologies'])('keeps unrelated employer %s', (name) => {
    expect(isEyCompany(name)).toBe(false);
    expect(getParentCompanyName(name)).toBe(name);
  });

  it.each(['SAP', 'GDS', 'India'])('extracts the parent company from an explicit %s drive', (track) => {
    const text = `Drive Name: EY ${track}\nDrive Number: pat-PL-2026-1445\nCompany: EY (Ernst & Young)`;
    expect(extractCompanyName(`Eligible for EY ${track}`, 'noreply.cdcinfo@vitstudent.ac.in', text)).toBe(EY_COMPANY_NAME);
    expect(getEyDriveName(text)).toBe(`EY ${track}`);
  });

  it('normalizes a cached historical track label into the parent company', () => {
    expect(extractCompanyName('Eligible for EY', 'noreply.cdcinfo@vitstudent.ac.in',
      'Drive Number: pat-PL-2026-1191', undefined, new Map([['pat-PL-2026-1191', 'EY SAP']]))).toBe(EY_COMPANY_NAME);
  });

  it('does not invent a SAP drive from a skill or a historical drive number', () => {
    expect(getEyDriveName('Company: EY (Ernst & Young)\nSkills: SAP\nDrive Number: pat-PL-2026-1191')).toBeNull();
  });

  it('keeps circulars for SAP, GDS and India on their own drives under one parent', () => {
    const drives = ['EY SAP', 'EY GDS', 'EY INDIA'];
    expect(drives.filter(name => matchesEyDriveName(name, 'EY India Super Dream Internship / Placement Registration'))).toEqual(['EY INDIA']);
    expect(drives.filter(name => matchesEyDriveName(name, 'EY SAP Online Test'))).toEqual(['EY SAP']);
    expect(drives.filter(name => matchesEyDriveName(name, 'EY GDS Interview Schedule'))).toEqual(['EY GDS']);
  });

  it('shows each drive name as the title even when it shares an employer or has a stale employer label', () => {
    expect(['EY SAP', 'EY GDS', 'EY INDIA'].map(name => getDriveDisplayName(name, EY_COMPANY_NAME)))
      .toEqual(['EY SAP', 'EY GDS', 'EY India']);
    expect(getDriveDisplayName('EY INDIA', 'EY SAP')).toBe('EY India');
    expect(getDriveDisplayName('  ', 'Myfacto')).toBe('Myfacto');
  });

  it('removes the category noise shown in the Philips and UST titles', () => {
    expect(getDriveDisplayName('Philips super dream internship', 'Philips')).toBe('Philips');
    expect(getDriveDisplayName('UST Intern', 'UST')).toBe('UST');
    expect(getDriveDisplayName('EY India Super Dream Internship / Placement Registration - 2027 Batch', EY_COMPANY_NAME)).toBe('EY India');
    expect(getDriveDisplayName('Apple IS&T SDET Intern', 'Apple')).toBe('Apple IS&T SDET');
    expect(getDriveDisplayName('Super Dream Internship', 'Philips')).toBe('Philips');
  });
});
