import type { createAdminClient } from '@/lib/supabase/admin';
import { getJobDisplayOverrides, getParsedJobDisplayOverrides } from './job-display-evidence';
import { CANONICAL_PARSER_VERSION } from './sync/canonical/canonical-email';

/** Only hydrate source circulars for drives belonging to this student's applications. */
export async function readJobDisplayOverrides(supabase: ReturnType<typeof createAdminClient>, drives: Array<{ source_college_email_id?: string | null; excluded_email_ids?: unknown }>) {
  const result = new Map<string, ReturnType<typeof getJobDisplayOverrides>>();
  const ids = [...new Set(drives.filter(drive => !Array.isArray(drive.excluded_email_ids) || !drive.excluded_email_ids.includes(drive.source_college_email_id))
    .map(drive => drive.source_college_email_id).filter((id): id is string => Boolean(id)))];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const { data, error } = await supabase.from('college_emails')
      .select('id,parser_version,ctc:parsed_job_details->>ctc,stipend:parsed_job_details->>stipend,location:parsed_job_details->>location')
      .in('id', ids.slice(offset, offset + 100));
    if (error) { console.warn('[JobDisplay] Could not load source circulars:', error.message); continue; }
    const legacyIds: string[] = [];
    for (const row of data || []) {
      if ((row.parser_version || 0) < CANONICAL_PARSER_VERSION) legacyIds.push(row.id);
      else result.set(row.id, getParsedJobDisplayOverrides(row));
    }
    // Once the canonical parser refreshes a circular, only its compact metadata is read.
    if (legacyIds.length) {
      const legacy = await supabase.from('college_emails').select('id,body_text').in('id', legacyIds);
      if (legacy.error) console.warn('[JobDisplay] Could not read legacy source evidence:', legacy.error.message);
      for (const row of legacy.data || []) result.set(row.id, getJobDisplayOverrides(row.body_text || ''));
    }
  }
  return result;
}
