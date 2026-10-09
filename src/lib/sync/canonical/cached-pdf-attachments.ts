import type { createAdminClient } from '@/lib/supabase/admin';
import type { CachedPdfAttachment } from '../extraction/pdf-parser';

/** Reuse stored JD text for selected source emails; never fetch Gmail or reparse PDF bytes. */
export async function loadCachedPdfAttachments(supabase: ReturnType<typeof createAdminClient>, sourceIds: string[]) {
  const byEmail = new Map<string, CachedPdfAttachment[]>();
  const ids = [...new Set(sourceIds)];
  for (let offset = 0; offset < ids.length; offset += 200) {
    for (let page = 0; ; page++) {
      const { data, error } = await supabase.from('college_attachments')
        .select('college_email_id,filename,parse_status,extracted_rows')
        .in('college_email_id', ids.slice(offset, offset + 200))
        .ilike('filename', '%.pdf').eq('parse_status', 'complete')
        .order('id').range(page * 1000, (page + 1) * 1000 - 1);
      if (error) throw error;
      for (const row of data || []) {
        const attachments = byEmail.get(row.college_email_id) || [];
        attachments.push({ filename: row.filename, parseStatus: row.parse_status, extractedRows: row.extracted_rows });
        byEmail.set(row.college_email_id, attachments);
      }
      if (!data || data.length < 1000) break;
    }
  }
  return byEmail;
}
