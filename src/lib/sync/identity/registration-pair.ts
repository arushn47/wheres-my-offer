import { normalizeDriveNumber } from '@/lib/drive-number';

export interface RegistrationPersonal {
  id: string;
  placement_drive_id?: string | null;
  sender?: string | null;
  subject?: string | null;
  classification?: string | null;
  received_at?: string | null;
}
export interface RegistrationCircular {
  id: string;
  subject?: string | null;
  classification?: string | null;
  parsed_drive_numbers?: string[] | null;
  received_at?: string | null;
  processing_status?: string | null;
}
interface RegistrationDrive { id: string; drive_number?: string | null; normalized_drive_number?: string | null }
const PAIR_WINDOW_MS = 48 * 60 * 60 * 1000;

export function isRegistrationAnnouncement(email: { subject?: string | null; classification?: string | null }): boolean {
  if (/confirmed:|confirmation:|successfully registered|registration (?:update|confirmed|successful)/i.test(email.subject || '')) return false;
  // A follow-up may keep "Registration" in its reply subject. Its resolved
  // round classification takes precedence so existing test/interview flow stays intact.
  if (email.classification && !['registration', 'general', 'unclassified', 'unclassified_placement_notice'].includes(email.classification)) return false;
  return email.classification === 'registration' || /\b(?:re[ -]?)?registration\b|\byou(?:'re| are) eligible\b/i.test(email.subject || '');
}

export function isPersonalNeoPatAnnouncement(email: RegistrationPersonal): boolean {
  const address = email.sender?.match(/<([^>]+)>/)?.[1] || email.sender?.trim();
  return address?.toLowerCase() === 'noreply.cdcinfo@vitstudent.ac.in' && isRegistrationAnnouncement(email);
}

/** Company matching is the caller's responsibility. Receipt time separates repeated drives. */
export function isRegistrationPair(drive: RegistrationDrive, personal: RegistrationPersonal, circular: RegistrationCircular): boolean {
  if (personal.placement_drive_id !== drive.id || !isPersonalNeoPatAnnouncement(personal) || !isRegistrationAnnouncement(circular)) return false;
  if (circular.processing_status && circular.processing_status !== 'complete') return false;
  const personalTime = Date.parse(personal.received_at || '');
  const collegeTime = Date.parse(circular.received_at || '');
  if (!Number.isFinite(personalTime) || !Number.isFinite(collegeTime)) return false;
  const numbers = (circular.parsed_drive_numbers || []).map(normalizeDriveNumber).filter(Boolean);
  if (numbers.length) {
    const expected = new Set([drive.drive_number, drive.normalized_drive_number].map(normalizeDriveNumber).filter(Boolean));
    return numbers.every(number => expected.has(number));
  }
  // An unnumbered new registration circular must never reopen a July/September
  // drive merely because it has the same company name or an existing application.
  return Math.abs(personalTime - collegeTime) <= PAIR_WINDOW_MS;
}

export function selectRegistrationCircular<T extends RegistrationCircular>(drive: RegistrationDrive, personal: RegistrationPersonal[], circulars: T[]): T | undefined {
  const candidates = circulars.map(circular => ({ circular, gap: Math.min(...personal
    .filter(email => isRegistrationPair(drive, email, circular))
    .map(email => Math.abs(Date.parse(email.received_at!) - Date.parse(circular.received_at!)))) }))
    .filter(candidate => Number.isFinite(candidate.gap)).sort((a, b) => a.gap - b.gap);
  if (candidates.length > 1 && candidates[0].gap === candidates[1].gap) return;
  return candidates[0]?.circular;
}

export function selectRegistrationDrive<T extends RegistrationDrive>(drives: T[], personal: RegistrationPersonal[], circular: RegistrationCircular): T | undefined {
  const candidates = drives.map(drive => ({ drive, gap: Math.min(...personal
    .filter(email => isRegistrationPair(drive, email, circular))
    .map(email => Math.abs(Date.parse(email.received_at!) - Date.parse(circular.received_at!)))) }))
    .filter(candidate => Number.isFinite(candidate.gap)).sort((a, b) => a.gap - b.gap);
  if (candidates.length > 1 && candidates[0].gap === candidates[1].gap) return;
  return candidates[0]?.drive;
}
