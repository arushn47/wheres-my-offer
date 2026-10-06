import type { createAdminClient } from '@/lib/supabase/admin';
import { normalizeIdentityToken } from './roster-policy';

export interface UserCandidateIdentity {
  userId: string;
  name: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  nameParts: string[];
  neoId: string | null;
  regNo: string | null;
  emails: string[];
  collegeEmail: string | null;
  personalEmail: string | null;
  searchTokens: string[];
}

/**
 * Normalizes an identity string: strips accents, non-breaking spaces, punctuation,
 * collapses whitespace, and converts to uppercase.
 */
export function getStrongIdentityTokens(identity: UserCandidateIdentity): string[] {
  return Array.from(new Set([identity.neoId, identity.regNo, ...identity.emails].filter((token): token is string => Boolean(token))));
}

export function normalizeToken(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/[\u00a0\s\-_.]/g, '')
    .toUpperCase()
    .trim();
}

/**
 * Extracts a university registration number (e.g. "23BCE10472") from a string or email.
 */
export function extractRegistrationNumber(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/\b([0-9]{2}[a-z]{2,4}[0-9]{4,6})\b/i);
  return match ? match[1].toUpperCase().trim() : null;
}

/**
 * Builds a standardized UserCandidateIdentity from provided components.
 */
export function buildCandidateIdentity(params: {
  userId?: string;
  name?: string | null;
  neoId?: string | null;
  emails?: (string | null | undefined)[];
  collegeEmail?: string | null;
  personalEmail?: string | null;
  regNo?: string | null;
}): UserCandidateIdentity {
  const userId = params.userId || '';
  const name = (params.name || '').trim() || null;
  const neoId = (params.neoId || '').trim().toUpperCase() || null;

  // Clean emails
  const rawEmails = [
    ...(params.emails || []),
    params.collegeEmail,
    params.personalEmail,
  ].filter((e): e is string => Boolean(e && typeof e === 'string' && e.includes('@')));

  const distinctEmails = Array.from(new Set(rawEmails.map((e) => e.trim().toLowerCase())));

  // Identify college and personal emails if not already specified
  let collegeEmail = params.collegeEmail ? params.collegeEmail.trim().toLowerCase() : null;
  let personalEmail = params.personalEmail ? params.personalEmail.trim().toLowerCase() : null;

  for (const e of distinctEmails) {
    if (!collegeEmail && /@vit(?:student|bhopal|chennai|vellore)?\.[a-zA-Z0-9.-]+/i.test(e)) {
      collegeEmail = e;
    } else if (!personalEmail && !/@vit/i.test(e)) {
      personalEmail = e;
    }
  }

  // Extract reg number from params, college email, or any email
  let regNo = params.regNo ? params.regNo.trim().toUpperCase() : null;
  if (!regNo && collegeEmail) {
    regNo = extractRegistrationNumber(collegeEmail);
  }
  if (!regNo) {
    for (const e of distinctEmails) {
      const found = extractRegistrationNumber(e);
      if (found) {
        regNo = found;
        break;
      }
    }
  }

  // Parse name parts
  const nameParts = name ? name.split(/\s+/).filter(Boolean) : [];
  const firstName = nameParts.length > 0 ? nameParts[0] : null;
  const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : null;
  const fullName = name;

  // Build search tokens (unique, non-empty, normalized)
  const tokenSet = new Set<string>();

  if (neoId && neoId.length >= 4) {
    tokenSet.add(neoId);
    tokenSet.add(normalizeToken(neoId));
  }

  if (regNo && regNo.length >= 7) {
    tokenSet.add(regNo);
    tokenSet.add(normalizeToken(regNo));
  }

  for (const e of distinctEmails) {
    tokenSet.add(e);
    tokenSet.add(e.toUpperCase());
    tokenSet.add(normalizeToken(e));
  }

  if (fullName && fullName.length >= 3) {
    tokenSet.add(fullName.toUpperCase());
    tokenSet.add(normalizeToken(fullName));
  }

  if (firstName && lastName && firstName.length >= 3 && lastName.length >= 3) {
    const shortFullName = `${firstName} ${lastName}`.toUpperCase();
    tokenSet.add(shortFullName);
    tokenSet.add(normalizeToken(shortFullName));
  }

  const searchTokens = Array.from(tokenSet).filter(Boolean);

  return {
    userId,
    name,
    fullName,
    firstName,
    lastName,
    nameParts,
    neoId,
    regNo,
    emails: distinctEmails,
    collegeEmail,
    personalEmail,
    searchTokens,
  };
}

/**
 * Loads a user's full candidate identity from Supabase (users table + gmail_accounts table).
 */
export async function loadUserCandidateIdentity(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string
): Promise<UserCandidateIdentity> {
  const [{ data: userRow }, { data: accounts }] = await Promise.all([
    supabase
      .from('users')
      .select('id, name, email, neo_id')
      .eq('id', userId)
      .maybeSingle(),
    supabase
      .from('gmail_accounts')
      .select('email, account_type')
      .eq('user_id', userId),
  ]);

  const emails: string[] = [];
  let collegeEmail: string | null = null;
  let personalEmail: string | null = null;

  if (userRow?.email) {
    emails.push(userRow.email);
  }

  if (accounts && Array.isArray(accounts)) {
    for (const acc of accounts) {
      if (!acc.email) continue;
      emails.push(acc.email);
      if (acc.account_type === 'college') {
        collegeEmail = acc.email;
      } else if (acc.account_type === 'personal') {
        personalEmail = acc.email;
      }
    }
  }

  return buildCandidateIdentity({
    userId,
    name: userRow?.name || null,
    neoId: userRow?.neo_id || null,
    emails,
    collegeEmail,
    personalEmail,
  });
}

/**
 * Checks if a table/spreadsheet row (array of string cell values) matches the candidate identity.
 */
export function matchesCandidateRow(
  cells: (string | null | undefined)[],
  identity: UserCandidateIdentity,
  allowNameOnly = false
): { matched: boolean; matchedValue: string } {
  const cleanCells = cells.map((c) => (c ? String(c).trim() : ''));
  const fullRowText = cleanCells.filter(Boolean).join(' ');
  const fullRowUpper = fullRowText.toUpperCase();
  const fullRowLower = fullRowText.toLowerCase();

  // 1. Neo ID exact cell or word match
  if (identity.neoId && identity.neoId.length >= 4) {
    for (const cell of cleanCells) {
      if (normalizeIdentityToken(cell) === normalizeIdentityToken(identity.neoId)) {
        return { matched: true, matchedValue: identity.neoId };
      }
    }
  }

  // 2. Registration Number exact cell or word match
  if (identity.regNo && identity.regNo.length >= 7) {
    for (const cell of cleanCells) {
      if (cell.toUpperCase() === identity.regNo) {
        return { matched: true, matchedValue: identity.regNo };
      }
    }
    // Also check word boundary in cells
    const regRegex = new RegExp(`\\b${identity.regNo}\\b`, 'i');
    for (const cell of cleanCells) {
      if (regRegex.test(cell)) {
        return { matched: true, matchedValue: identity.regNo };
      }
    }
  }

  // 3. Email exact cell match
  for (const email of identity.emails) {
    if (!email) continue;
    for (const cell of cleanCells) {
      if (cell.toLowerCase() === email) {
        return { matched: true, matchedValue: email };
      }
    }
  }

  if (!allowNameOnly) return { matched: false, matchedValue: '' };

  // 4. Name-only matches are for review, never automatic shortlist evidence.
  if (identity.fullName && identity.fullName.length >= 4) {
    const fullNameUpper = identity.fullName.toUpperCase();
    const normalizedTarget = normalizeToken(fullNameUpper);
    for (const cell of cleanCells) {
      if (!cell || cell.length < 3) continue;
      const cellUpper = cell.toUpperCase();
      if (cellUpper === fullNameUpper || normalizeToken(cellUpper) === normalizedTarget) {
        return { matched: true, matchedValue: identity.fullName };
      }
      // If cell contains full name with word boundaries
      if (cellUpper.includes(fullNameUpper)) {
        return { matched: true, matchedValue: identity.fullName };
      }
    }
  }

  // 5. First Name + Last Name distributed across cells in the row
  // e.g. Col 2: "Arush Nandakumar", Col 3: "Menon"
  if (
    identity.firstName &&
    identity.lastName &&
    identity.firstName.length >= 3 &&
    identity.lastName.length >= 3
  ) {
    const fnUpper = identity.firstName.toUpperCase();
    const lnUpper = identity.lastName.toUpperCase();

    const hasFirstNameCell = cleanCells.some((c) => {
      const u = c.toUpperCase();
      return u === fnUpper || u.startsWith(fnUpper + ' ') || u.endsWith(' ' + fnUpper) || u.includes(' ' + fnUpper + ' ');
    });

    const hasLastNameCell = cleanCells.some((c) => {
      const u = c.toUpperCase();
      return u === lnUpper || u.startsWith(lnUpper + ' ') || u.endsWith(' ' + lnUpper) || u.includes(' ' + lnUpper + ' ');
    });

    if (hasFirstNameCell && hasLastNameCell) {
      return { matched: true, matchedValue: `${identity.firstName} ${identity.lastName}` };
    }
  }

  return { matched: false, matchedValue: '' };
}

/**
 * Checks if email body text / plain text mentions the candidate identity.
 * Strips recipient headers (to/from/cc) to avoid false positives on broadcast emails.
 */
export function matchesCandidateText(
  text: string,
  identity: UserCandidateIdentity,
  allowNameOnly = false
): { matched: boolean; matchedValue: string | null } {
  if (!text) return { matched: false, matchedValue: null };

  // Strip recipient email addresses, mailto links, and headers to prevent matching user's own email from headers
  const sanitizedText = text
    .replace(/[a-zA-Z0-9._%+-]+@vit(?:student|bhopal|chennai|vellore)?\.[a-zA-Z0-9.-]+/gi, ' ')
    .replace(/[a-zA-Z0-9._%+-]+@gmail\.com/gi, ' ')
    .replace(/mailto:[^\s>]+/gi, ' ')
    .replace(/to:\s*[^\n]+/gi, ' ')
    .replace(/from:\s*[^\n]+/gi, ' ')
    .replace(/cc:\s*[^\n]+/gi, ' ');

  const upperText = sanitizedText.toUpperCase();

  // 1. Neo ID check (with OCR fuzzy matching 0/O and 1/I)
  if (identity.neoId && identity.neoId.length >= 4) {
    const cleanNeoId = identity.neoId;
    const directRegex = new RegExp(`\\b${cleanNeoId}\\b`);
    if (directRegex.test(upperText)) {
      return { matched: true, matchedValue: cleanNeoId };
    }
  }

  // 2. Registration Number check
  if (identity.regNo && identity.regNo.length >= 7) {
    const regRegex = new RegExp(`(?:^|[^A-Z0-9])${identity.regNo}(?:[^A-Z0-9]|$)`, 'i');
    if (regRegex.test(upperText)) {
      return { matched: true, matchedValue: identity.regNo };
    }
  }

  if (!allowNameOnly) return { matched: false, matchedValue: null };

  // 3. Full name check for review only
  // Requires at least 2 words (e.g. "Arush Nandakumar Menon" or "Arush Menon") with word boundaries
  if (
    identity.firstName &&
    identity.lastName &&
    identity.firstName.length >= 3 &&
    identity.lastName.length >= 3
  ) {
    const fn = identity.firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ln = identity.lastName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Matches "Arush Nandakumar Menon", "Arush Menon", "Menon Arush"
    const nameRegex1 = new RegExp(`\\b${fn}\\s+(?:[A-Za-z]+\\s+)?${ln}\\b`, 'i');
    const nameRegex2 = new RegExp(`\\b${ln}\\s+${fn}\\b`, 'i');

    if (nameRegex1.test(sanitizedText) || nameRegex2.test(sanitizedText)) {
      return { matched: true, matchedValue: identity.fullName || `${identity.firstName} ${identity.lastName}` };
    }
  }

  return { matched: false, matchedValue: null };
}
