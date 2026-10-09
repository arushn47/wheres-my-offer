import type { createAdminClient } from '@/lib/supabase/admin';
import type { ParsedEmail } from '@/lib/gmail/client';
import { extractRecruitmentVenues } from '@/lib/drive-venues';
import { persistDriveVenues } from '@/lib/drive-venue-data';
import { getEvidenceMessageText } from '../extraction/body';
import { getCachedPdfText } from '../extraction/pdf-parser';

interface VenueDrive {
  id: string;
  drive_number: string | null;
  normalized_drive_number: string | null;
  source_college_email_id: string | null;
}

/** A company-only shared match must never become attendance evidence. */
export async function persistSharedCircularVenues(
  admin: ReturnType<typeof createAdminClient>,
  drive: VenueDrive,
  source: { id: string; numbers: string[]; classification: string | null; companyName: string | null },
  company: { name: string; aliases: string[] | null } | null,
  email: ParsedEmail,
) {
  if (source.classification === 'irrelevant') return;
  const numbers = new Set([
    drive.drive_number, drive.normalized_drive_number,
    drive.normalized_drive_number?.match(/[0-9]+$/)?.[0],
  ].filter(Boolean).map(value => value!.trim().toLowerCase()));
  if (source.numbers.length
    ? !source.numbers.every(number => numbers.has(number.trim().toLowerCase()))
    : drive.source_college_email_id !== source.id) return;
  // Exact IDs/numbers authorize the match. A contradictory company vetoes it.
  if (company && source.companyName) {
    const normalize = (value: string) => value.toLowerCase()
      .replace(/\b(?:pvt|private|ltd|limited)\b/g, '').replace(/[^a-z0-9]/g, '');
    const name = normalize(source.companyName);
    if (![company.name, ...(company.aliases || [])].map(normalize).some(alias =>
      alias === name || alias.length >= 4 && name.startsWith(alias) || name.length >= 4 && alias.startsWith(name)
    )) return;
  }
  const entries = extractRecruitmentVenues(email.subject, getEvidenceMessageText(email));
  const bodyRounds = new Set(entries.map(entry => `${entry.stage}:${entry.audience || ''}`));
  // Completed PDFs are already hydrated by shared ingestion. No extra downloads
  // or reads; never use another drive's JD or replace an explicit body instruction.
  const pdfText = getCachedPdfText(email.attachments);
  if (pdfText) entries.push(...extractRecruitmentVenues('', pdfText).filter(entry => !bodyRounds.has(`${entry.stage}:${entry.audience || ''}`)));
  // The row-locked RPC rechecks current drive numbers, source exclusions and dates.
  await persistDriveVenues(admin, drive.id, source.id, email.receivedAt.toISOString(), entries.slice(0, 12));
}
