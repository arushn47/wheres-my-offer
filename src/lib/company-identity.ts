export const EY_COMPANY_NAME = 'EY (Ernst & Young)';

/** EY's recruitment tracks identify opportunities, not separate employers. */
export function isEyCompany(name: string | null | undefined): boolean {
  const value = (name || '').trim().replace(/\s+/g, ' ');
  return /^(?:ey(?:\s*\(ernst\s*(?:&|and)\s*young\))?|ernst\s*(?:&|and)\s*young)(?:[\s-]+(?:india|sap|gds|global delivery services))?$/i.test(value);
}

export function getParentCompanyName(name: string): string {
  return isEyCompany(name) ? EY_COMPANY_NAME : name;
}

/** Read explicit EY drive names without inferring a track from skills or old IDs. */
export function getEyDriveName(text: string): string | null {
  const match = text.match(/\bEY[\s-]+(SAP|GDS|India)\b/i);
  if (!match) return null;
  return `EY ${match[1].toLowerCase() === 'india' ? 'India' : match[1].toUpperCase()}`;
}

export function matchesEyDriveName(driveName: string | null | undefined, subject: string): boolean {
  const requestedDrive = getEyDriveName(subject);
  return !requestedDrive || getEyDriveName(driveName || '') === requestedDrive;
}
