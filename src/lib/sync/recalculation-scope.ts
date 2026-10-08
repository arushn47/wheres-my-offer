import type { createAdminClient } from '@/lib/supabase/admin';
import { isInvalidCompanyName } from './classification/classifier';
import { isFuzzyCompanyMatch } from './engine';

interface ScopeCompany { id: string; name: string; aliases?: string[] | null }
interface ScopeDrive {
  id: string; company_id: string; drive_number?: string | null;
  normalized_drive_number?: string | null; source_college_email_id?: string | null;
}
interface SourceMetadata {
  id: string; subject?: string | null; parsed_company_name?: string | null;
  parsed_drive_numbers?: string[] | null;
}
export interface RecalculationCircularMetadata extends SourceMetadata {
  sender_email: string | null; received_at: string | null; created_at: string | null;
  classification: string | null; body_text?: string | null;
}
const cleanNumber = (number: string) => number.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The same subject fallback used by the status resolver, before downloading bodies. */
export function isCompanySubjectMatch(subject: string, company: ScopeCompany, drive: ScopeDrive): boolean {
  const sub = subject.toLowerCase();
  const name = company.name.toLowerCase().trim();
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (name.length >= 3 && new RegExp(`\\b${escaped(name)}\\b`, 'i').test(sub)) return true;
  if (drive.drive_number) {
    const number = cleanNumber(drive.drive_number);
    if (number.length >= 4 && cleanNumber(sub).includes(number)) return true;
  }
  for (const raw of company.aliases || []) {
    const alias = raw.toLowerCase().trim();
    if (alias.length < 4 || ['ngi', 'pan', 'work', 'part', 'pls', 'data', 'asia', 'tech'].includes(alias) || isInvalidCompanyName(alias)) continue;
    if (new RegExp(`\\b${escaped(alias)}\\b`, 'i').test(sub)) return true;
  }
  const root = company.name.replace(/\s+(?:research|analytics|technologies|technology|services|service|solutions|solution|consulting|group|capital|systems|system|labs|lab)\b/gi, '').replace(/\s*(?:&|and)\s*$/i, '').trim().toLowerCase();
  return Boolean(root.length >= 4 && new RegExp(`(?:^|[^a-z0-9])${escaped(root)}(?:[^a-z0-9]|$)`, 'i').test(sub));
}

export function createRecalculationScope(
  drives: ScopeDrive[], companies: ScopeCompany[], explicitSourceIds: string[], linkedPersonalIds: string[],
) {
  const companyMap = new Map(companies.map(company => [company.id, company]));
  const driveIds = new Set(drives.map(drive => drive.id));
  const explicitIds = new Set([...explicitSourceIds, ...drives.flatMap(drive => drive.source_college_email_id ? [drive.source_college_email_id] : [])]);
  const personalIds = new Set(linkedPersonalIds);
  const matchesSubject = (subject: string) => drives.some(drive => {
    const company = companyMap.get(drive.company_id);
    return company && isCompanySubjectMatch(subject, company, drive);
  });
  return {
    includesPersonal(email: { id: string; placement_drive_id?: string | null; subject?: string | null }) {
      return Boolean(personalIds.has(email.id) || email.placement_drive_id && driveIds.has(email.placement_drive_id) || !email.placement_drive_id && email.subject && matchesSubject(email.subject));
    },
    includesCircular(email: SourceMetadata) {
      if (explicitIds.has(email.id) || email.subject && matchesSubject(email.subject)) return true;
      return drives.some(drive => {
        const number = drive.normalized_drive_number || drive.drive_number;
        const company = companyMap.get(drive.company_id);
        return Boolean(number && (email.parsed_drive_numbers || []).some(candidate => cleanNumber(candidate) === cleanNumber(number)) ||
          company && email.parsed_company_name && isFuzzyCompanyMatch(company.name, email.parsed_company_name));
      });
    },
  };
}

export async function loadRecalculationScope(supabase: ReturnType<typeof createAdminClient>, userId: string, driveIds: string[]) {
  const [drives, companies, matches, links] = await Promise.all([
    supabase.from('placement_drives').select('id,company_id,drive_number,normalized_drive_number,source_college_email_id').in('id', driveIds),
    supabase.from('companies').select('id,name,aliases'),
    supabase.from('candidate_matches').select('email_id,college_email_id').eq('user_id', userId).in('placement_drive_id', driveIds),
    // The resolver also consumes shared drive links created by other syncs.
    // Personal hydration still only operates on this user's private email catalog.
    supabase.from('email_drive_links').select('email_id').in('placement_drive_id', driveIds),
  ]);
  for (const result of [drives, companies, matches, links]) if (result.error) throw result.error;
  return createRecalculationScope(drives.data || [], companies.data || [],
    [...(matches.data || []).flatMap(row => [row.email_id, row.college_email_id]), ...(links.data || []).map(row => row.email_id)].filter((id): id is string => Boolean(id)),
    (links.data || []).map(row => row.email_id));
}

export async function loadSelectedCanonicalBodies(supabase: ReturnType<typeof createAdminClient>, ids: string[]) {
  const bodies = new Map<string, string>();
  const uniqueIds = [...new Set(ids)];
  for (let offset = 0; offset < uniqueIds.length; offset += 200) {
    const { data, error } = await supabase.from('college_emails').select('id,body_text').in('id', uniqueIds.slice(offset, offset + 200));
    if (error) throw error;
    for (const row of data || []) bodies.set(row.id, row.body_text || '');
  }
  return bodies;
}
