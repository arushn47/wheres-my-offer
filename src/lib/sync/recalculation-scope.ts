import type { createAdminClient } from '@/lib/supabase/admin';
import { isInvalidCompanyName, isFuzzyCompanyMatch } from './classification/classifier';
import { reuseRunRead } from './run-reads';

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
const quoted = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
// A subsequence is a conservative DB prefilter for punctuation-insensitive
// subject matching. The existing resolver still makes the final decision.
const subjectPattern = (value: string) => `subject.ilike.${quoted(`*${cleanNumber(value).split('').join('*')}*`)}`;
const literalSubjectPattern = (value: string) => value.includes('*') ? subjectPattern(value)
  : `subject.ilike.${quoted(`%${value.trim().replace(/[\\%_]/g, '\\$&')}%`)}`;

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
  drives: ScopeDrive[], companies: ScopeCompany[], explicitSourceIds: string[], linkedPersonalIds: string[], siblings: ScopeDrive[] = drives,
) {
  const companyMap = new Map(companies.map(company => [company.id, company]));
  const driveIds = new Set(drives.map(drive => drive.id));
  const explicitIds = new Set([...explicitSourceIds, ...drives.flatMap(drive => drive.source_college_email_id ? [drive.source_college_email_id] : [])]);
  const personalIds = new Set(linkedPersonalIds);
  const matchesSubject = (subject: string) => drives.some(drive => {
    const company = companyMap.get(drive.company_id);
    return company && isCompanySubjectMatch(subject, company, drive);
  });
  const subjectFilters = [...new Set(drives.flatMap(drive => {
    const company = companyMap.get(drive.company_id);
    const terms = company ? [company.name, ...((company.aliases || []).filter(alias => alias.length >= 4 && !['ngi','pan','work','part','pls','data','asia','tech'].includes(alias.toLowerCase()) && !isInvalidCompanyName(alias))),
      company.name.replace(/\s+(?:research|analytics|technologies|technology|services|service|solutions|solution|consulting|group|capital|systems|system|labs|lab)\b/gi, '').replace(/\s*(?:&|and)\s*$/i, '').trim()] : [];
    return [...terms.filter(term => term.trim().length >= 3).map(literalSubjectPattern),
      ...(drive.drive_number && cleanNumber(drive.drive_number).length >= 4 ? [subjectPattern(drive.drive_number)] : [])];
  }))];
  // Preserve the personal-email JD fallback, including punctuation-collapsed
  // brand names and acronyms, without broadening the circular subject query.
  const personalBrandFilters = drives.flatMap(drive => {
    const company = companyMap.get(drive.company_id);
    if (!company) return [];
    const firstToken = company.name.split(/\s+/).find(token => token.length >= 3);
    const acronym = company.name.match(/\b([A-Z])/g)?.join('');
    return [...(firstToken ? [literalSubjectPattern(firstToken)] : []),
      ...(firstToken && cleanNumber(firstToken).length >= 4 ? [subjectPattern(firstToken)] : []),
      ...(cleanNumber(company.name).length >= 4 ? [subjectPattern(company.name)] : []),
      ...(acronym && acronym.length >= 3 ? [literalSubjectPattern(acronym)] : [])];
  });
  const idFilter = (column: string, ids: string[]) => ids.length ? `${column}.in.(${ids.map(quoted).join(',')})` : null;
  const idFilters = (column: string, ids: string[]) => ids.reduce<string[]>((filters, _id, index) => {
    if (index % 100 === 0) filters.push(idFilter(column, ids.slice(index, index + 100))!);
    return filters;
  }, []);
  const personalFilters = [...new Set([...idFilters('placement_drive_id', siblings.map(drive => drive.id)), ...idFilters('id', [...personalIds]), ...subjectFilters, ...personalBrandFilters])];
  return {
    hasDrives: drives.length > 0,
    subjectFilters, personalFilters,
    explicitCircularFilters: idFilters('id', [...explicitIds]),
    includesRouting(email: SourceMetadata) {
      return explicitIds.has(email.id) || Boolean(email.parsed_company_name && drives.some(drive => {
        const company = companyMap.get(drive.company_id);
        return company && isFuzzyCompanyMatch(company.name, email.parsed_company_name!);
      })) || siblings.some(drive => [drive.drive_number, drive.normalized_drive_number].some(number => number &&
        (email.parsed_drive_numbers || []).some(candidate => cleanNumber(candidate) === cleanNumber(number))));
    },
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
  const drives = await supabase.from('placement_drives').select('id,company_id,drive_number,normalized_drive_number,source_college_email_id').in('id', driveIds);
  if (drives.error) throw drives.error;
  const companyIds = [...new Set((drives.data || []).map(drive => drive.company_id))];
  const [companies, matches, links, siblings] = await Promise.all([
    companyIds.length ? supabase.from('companies').select('id,name,aliases').in('id', companyIds) : { data: [], error: null },
    supabase.from('candidate_matches').select('email_id,college_email_id').eq('user_id', userId).in('placement_drive_id', driveIds),
    // The resolver also consumes shared drive links created by other syncs.
    // Personal hydration still only operates on this user's private email catalog.
    supabase.from('email_drive_links').select('email_id').in('placement_drive_id', driveIds),
    companyIds.length ? supabase.from('placement_drives')
      .select('id,company_id,drive_number,normalized_drive_number,source_college_email_id').in('company_id', companyIds) : { data: [], error: null },
  ]);
  for (const result of [companies, matches, links, siblings]) if (result.error) throw result.error;
  return createRecalculationScope(drives.data || [], companies.data || [],
    [...(matches.data || []).flatMap(row => [row.email_id, row.college_email_id]), ...(links.data || []).map(row => row.email_id)].filter((id): id is string => Boolean(id)),
    (links.data || []).map(row => row.email_id), siblings.data || []);
}

type Admin = ReturnType<typeof createAdminClient>;
type Scope = ReturnType<typeof createRecalculationScope>;
export const PERSONAL_METADATA = 'id, subject, sender, body_snippet, gmail_account_id, gmail_message_id, canonical_email_id, college_email_id, rfc_message_id, classification, placement_drive_id, received_at, assignment_state, assignment_source';
export const CIRCULAR_METADATA = 'id, subject, sender_email, received_at, created_at, classification, parsed_company_name, parsed_drive_numbers';
export interface PersonalRecalculationMetadata {
  id: string; subject: string | null; sender: string | null; body_snippet: string | null;
  gmail_account_id: string | null; gmail_message_id: string | null; canonical_email_id: string | null;
  college_email_id: string | null; rfc_message_id: string | null; classification: string | null;
  placement_drive_id: string | null; received_at: string | null; assignment_state: string | null; assignment_source: string | null;
}

/** No body/subject/snippet catalogue: only the routing keys needed for exact
 * fuzzy and normalized-number compatibility, reused once per processing run.
 * Avoids new SQL functions or changing the historical company matcher. */
async function readCircularRouting(admin: Admin): Promise<SourceMetadata[]> {
  return reuseRunRead(null, 'circular-routing', async () => {
    const rows: SourceMetadata[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from('college_emails').select('id,parsed_company_name,parsed_drive_numbers')
        .or('parsed_company_name.not.is.null,parsed_drive_numbers.not.is.null').order('id').range(from, from + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < 1000) return rows;
    }
  });
}

/** Split large ORs instead of sending unbounded URLs; dedupe overlapping reads. */
export async function loadScopedMetadata<T extends { id: string; received_at?: string | null } = PersonalRecalculationMetadata>(admin: Admin, table: 'personal_emails' | 'college_emails', filters: string[], userId?: string): Promise<T[]> {
  if (table === 'personal_emails' && !userId) throw new Error('Private metadata requires a user scope');
  const rows = new Map<string, T>();
  const groups: string[][] = [];
  for (const filter of filters) {
    const group = groups.at(-1);
    if (!group || group.join(',').length + filter.length > 6000) groups.push([filter]);
    else group.push(filter);
  }
  for (const group of groups) {
    for (let from = 0; ; from += 1000) {
      let query = admin.from(table).select<string>(table === 'personal_emails' ? PERSONAL_METADATA : CIRCULAR_METADATA).or(group.join(','));
      if (userId) query = query.eq('user_id', userId);
      const { data, error } = await query.order('received_at', { ascending: true }).order('id').range(from, from + 999);
      if (error) throw error;
      for (const row of data || []) { const record = row as unknown as T; rows.set(record.id, record); }
      if (!data || data.length < 1000) break;
    }
  }
  return [...rows.values()].sort((a,b) => Number(!a.received_at) - Number(!b.received_at) || (a.received_at || '').localeCompare(b.received_at || '') || a.id.localeCompare(b.id));
}

export async function loadScopedCircularMetadata(admin: Admin, scope: Scope, canonicalIds: string[] = []) {
  if (!scope.hasDrives) return [];
  const routing = await readCircularRouting(admin);
  const ids = routing.filter(email => scope.includesRouting(email)).map(email => email.id);
  const filters = [...scope.subjectFilters];
  // Explicit links need fetching even when no parsed routing keys are stored.
  // includesRouting also recognizes these rows, so include their IDs separately.
  const candidateIds = [...new Set([...ids, ...canonicalIds])];
  for (let from = 0; from < candidateIds.length; from += 100) filters.push(`id.in.(${candidateIds.slice(from, from + 100).map(quoted).join(',')})`);
  return loadScopedMetadata<RecalculationCircularMetadata>(admin, 'college_emails', [...filters, ...scope.explicitCircularFilters]);
}

export async function loadSelectedCanonicalBodies(supabase: Admin, ids: string[], bodies = new Map<string, string>()) {
  const uniqueIds = [...new Set(ids)].filter(id => !bodies.has(id));
  for (let offset = 0; offset < uniqueIds.length; offset += 200) {
    const { data, error } = await supabase.from('college_emails').select('id,body_text').in('id', uniqueIds.slice(offset, offset + 200));
    if (error) throw error;
    for (const row of data || []) bodies.set(row.id, row.body_text || '');
  }
  return new Map([...new Set(ids)].filter(id => bodies.has(id)).map(id => [id, bodies.get(id)!]));
}
