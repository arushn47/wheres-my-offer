import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes with clsx */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a date string to a human-readable format */
export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Format a date string with time */
export function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/** Get relative time (e.g., "2 minutes ago") */
export function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return formatDate(dateStr);
}

/** Truncate a string to a max length */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + '…';
}

/** Cleanly format stipend string without duplicate /mo or /month suffixes */
export function formatStipend(stipendStr: string | null | undefined): string | null {
  if (!stipendStr) return null;
  let s = stipendStr.replace(/\*/g, '').trim();
  if (!s) return null;
  // Strip duplicate trailing suffixes like /month/mo or /mo/mo
  s = s.replace(/\/(?:month|mo)\/mo$/i, '/month').replace(/\/mo\/mo$/i, '/mo');
  if (/\/(?:month|mo)|pm|per month/i.test(s)) {
    return s;
  }
  if (/^\d+$/.test(s)) {
    return `₹${Number(s).toLocaleString('en-IN')}/month`;
  }
  return `${s}/mo`;
}

/**
 * Dynamically detect VIT campus from college email domain.
 * Strictly matches the 4 campus categories: 'VIT Bhopal', 'VIT Vellore', 'VIT Chennai', 'VIT AP'.
 */
export function detectCampus(email?: string | null): 'VIT Bhopal' | 'VIT Vellore' | 'VIT Chennai' | 'VIT AP' {
  if (!email) return 'VIT Bhopal';
  const lower = email.toLowerCase();
  if (lower.includes('vitbhopal') || lower.includes('bhopal')) return 'VIT Bhopal';
  if (lower.includes('vitap') || lower.includes('ap.vit') || lower.includes('vitapstudent')) return 'VIT AP';
  if (lower.includes('chennai')) return 'VIT Chennai';
  if (lower.includes('vellore') || lower.includes('vitstudent.ac.in') || lower.includes('vit.ac.in')) return 'VIT Vellore';
  return 'VIT Bhopal';
}

/**
 * Extract engineering branch / specialization from VIT student email or registration number.
 * e.g., 'arush.23bce10472@vitbhopal.ac.in' or '23BCE10472' -> 'CSE'
 */
export function detectBranch(emailOrReg?: string | null): string | null {
  if (!emailOrReg) return null;
  const match = emailOrReg.toLowerCase().match(/\d{2}([a-z]{3})\d+/i);
  if (!match) return null;
  const code = match[1].toUpperCase();
  const branches: Record<string, string> = {
    BCE: 'CSE',
    BCI: 'CSE (InfoSec)',
    BCG: 'CSE (Gaming)',
    BAI: 'CSE (AI & ML)',
    BDS: 'CSE (Data Science)',
    BSA: 'Aerospace',
    BEC: 'ECE',
    BEE: 'EEE',
    BME: 'Mechanical',
    BBI: 'Biotech',
    BCL: 'Civil',
    BCH: 'Chemical',
    BIT: 'IT',
  };
  return branches[code] || code;
}

/**
 * Extract VIT academic registration number from student email if formatted with reg no.
 * e.g., 'arush.23bce10472@vitbhopal.ac.in' -> '23BCE10472'
 */
export function detectRegNo(email?: string | null): string | null {
  if (!email) return null;
  const match = email.toLowerCase().match(/\b(\d{2}[a-z]{3}\d{4,5})\b/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Resolves the operational drive mode / travel mode for a campus placement drive.
 * Matches: 'Online', 'VIT Vellore', 'VIT Chennai', 'VIT AP', or home campus labs ('Vellore Labs', 'Bhopal Labs', etc.)
 */
export function getDriveMode(
  notes?: string | null,
  userCampus?: string | null
): string {
  const notesStr = (notes || '').toLowerCase();
  const campus = userCampus || 'VIT Bhopal';
  const homeLabs =
    campus === 'VIT Vellore'
      ? 'Vellore Labs'
      : campus === 'VIT Chennai'
        ? 'Chennai Labs'
        : campus === 'VIT AP'
          ? 'AP Labs'
          : 'Bhopal Labs';

  if (notesStr.includes('online') || notesStr.includes('virtual')) {
    return 'Online';
  }
  if (
    notesStr.includes('respective_campus') ||
    notesStr.includes('respective') ||
    notesStr.includes('tbd') ||
    notesStr.includes('tba')
  ) {
    return homeLabs;
  }
  if (notesStr.includes('vellore')) {
    if (notesStr.includes('respective') || notesStr.includes('others')) {
      return homeLabs;
    }
    return campus === 'VIT Vellore' ? 'Vellore Labs' : 'VIT Vellore';
  }
  if (notesStr.includes('chennai')) {
    if (notesStr.includes('respective') || notesStr.includes('others')) {
      return homeLabs;
    }
    return campus === 'VIT Chennai' ? 'Chennai Labs' : 'VIT Chennai';
  }
  if (notesStr.includes('ap') || notesStr.includes('amaravati')) {
    return campus === 'VIT AP' ? 'AP Labs' : 'VIT AP';
  }
  if (notesStr.includes('bhopal')) {
    return campus === 'VIT Bhopal' ? 'Bhopal Labs' : 'VIT Bhopal';
  }
  return homeLabs;
}

/** Update a recognized stored travel-mode note without discarding other manual notes. */
export function refreshTravelModeNote(notes: string | null | undefined, travelMode: string): string {
  const previousNotes = notes || '';
  const recognizedTravelNote = /^(?:bhopal|bhopal_lab|online|vellore|chennai|ap|respective_campus)$/i;
  const noteLines = previousNotes.split('\n');
  const travelLineIndex = noteLines.findIndex((line) => recognizedTravelNote.test(line.trim()));

  if (travelLineIndex >= 0) {
    noteLines[travelLineIndex] = travelMode;
    return noteLines.filter(Boolean).join('\n');
  }
  if (!previousNotes.trim()) return travelMode;
  return `${previousNotes}\n${travelMode}`;
}
