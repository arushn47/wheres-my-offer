import type { createAdminClient } from '@/lib/supabase/admin';
import type { RoundStatusDecision } from './round-status';

type Admin = ReturnType<typeof createAdminClient>;
export interface RoundStatusRow {
  placement_drive_id: string;
  is_current: boolean;
  verdict: RoundStatusDecision & { evaluations?: Array<{ emailId: string; state: string }> };
}
export interface DriveActivity { placement_drive_id: string | null; received_at: string | null }
const missingMigration = (error: { code?: string }) => ['PGRST202', '42883'].includes(error.code || '');

/** Search has always used a 500-code-unit snippet, never the full email body. */
export async function readRecentCollegeSearchRows(admin: Admin) {
  if (process.env.COMPACT_DASHBOARD_READS_ENABLED === 'true') {
    const { data, error } = await admin.rpc('get_recent_college_search_rows');
    if (!error) return data || [];
    if (!missingMigration(error)) throw error;
  }
  const { data, error } = await admin.from('college_emails')
    .select('id,subject,sender_email,received_at,created_at,body_text,parsed_company_name,parsed_drive_numbers')
    .order('received_at', { ascending: false }).limit(40);
  if (error) throw error;
  return data || [];
}

/** All historical rounds remain available to the existing participation resolver. */
export async function readRoundStatusRows(admin: Admin, userId: string, driveIds?: string[], includeEvaluations = false): Promise<RoundStatusRow[]> {
  if (driveIds?.length === 0) return [];
  const compact = process.env.COMPACT_DASHBOARD_READS_ENABLED === 'true';
  const rows: RoundStatusRow[] = [];
  for (let from = 0; ; from += 1000) {
    let result;
    if (compact) {
      result = await admin.rpc('get_user_round_status_rows', {
        p_user_id: userId, p_drive_ids: driveIds || null, p_include_evaluations: includeEvaluations,
      }).range(from, from + 999);
      if (result.error && missingMigration(result.error)) return readLegacyRoundRows(admin, userId, driveIds);
    } else return readLegacyRoundRows(admin, userId, driveIds);
    if (result.error) throw result.error;
    rows.push(...(result.data || []) as RoundStatusRow[]);
    if (!result.data || result.data.length < 1000) return rows;
  }
}

async function readLegacyRoundRows(admin: Admin, userId: string, driveIds?: string[]): Promise<RoundStatusRow[]> {
  const rows: RoundStatusRow[] = [];
  for (let from = 0; ; from += 1000) {
    let query = admin.from('round_verdicts').select('placement_drive_id,verdict,is_current').eq('user_id', userId);
    if (driveIds) query = query.in('placement_drive_id', driveIds);
    const { data, error } = await query.range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []) as RoundStatusRow[]);
    if (!data || data.length < 1000) return rows;
  }
}

/** No cross-user cache: every request is explicitly scoped to its authenticated user. */
export async function readDriveActivity(admin: Admin, userId: string): Promise<DriveActivity[]> {
  if (process.env.COMPACT_DASHBOARD_READS_ENABLED === 'true') {
    const rows: DriveActivity[] = [];
    let missing = false;
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.rpc('get_user_drive_activity', { p_user_id: userId }).range(from, from + 999);
      if (error && missingMigration(error)) { missing = true; break; }
      if (error) throw error;
      rows.push(...(data || []) as DriveActivity[]);
      if (!data || data.length < 1000) break;
    }
    if (!missing) return rows;
  }
  // email_drive_links.email_id references personal_emails, not college_emails.
  // Read IDs explicitly so this path does not depend on PostgREST join inference.
  const personal = new Map<string, DriveActivity & { college_email_id: string | null; canonical_email_id: string | null }>();
  const rows: DriveActivity[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('personal_emails')
      .select('id,placement_drive_id,received_at,college_email_id,canonical_email_id').eq('user_id', userId).range(from, from + 999);
    if (error) throw error;
    for (const row of data || []) {
      personal.set(row.id, row);
      if (row.placement_drive_id) rows.push({ placement_drive_id: row.placement_drive_id, received_at: row.received_at });
    }
    if (!data || data.length < 1000) break;
  }
  const links: Array<{ placement_drive_id: string; email_id: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('email_drive_links').select('placement_drive_id,email_id').eq('user_id', userId).range(from, from + 999);
    if (error) throw error;
    links.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const canonicalIds = [...new Set(links.flatMap(link => {
    const email = personal.get(link.email_id);
    const id = email?.college_email_id || email?.canonical_email_id;
    return id ? [id] : [];
  }))];
  const canonicalDates = new Map<string, string | null>();
  for (let offset = 0; offset < canonicalIds.length; offset += 200) {
    const { data, error } = await admin.from('college_emails').select('id,received_at').in('id', canonicalIds.slice(offset, offset + 200));
    if (error) throw error;
    for (const row of data || []) canonicalDates.set(row.id, row.received_at);
  }
  for (const link of links) {
    const email = personal.get(link.email_id);
    if (!email) continue; // Never resolve a different user's private receipt.
    rows.push({ placement_drive_id: link.placement_drive_id,
      received_at: canonicalDates.get(email.college_email_id || email.canonical_email_id || '') || email.received_at });
  }
  return rows;
}
