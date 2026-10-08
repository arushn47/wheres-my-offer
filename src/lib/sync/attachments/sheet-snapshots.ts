import type { createAdminClient } from '@/lib/supabase/admin';
import type { GSheetMatchResult } from './gsheet-parser';
import { cacheStoredRoster } from './roster-lookup';

/** Record the exact mutable sheet version inspected, including successfully parsed absence. */
export async function persistSheetSnapshot(supabase: ReturnType<typeof createAdminClient>, emailId: string, sourceUrl: string, scan: GSheetMatchResult | null): Promise<void> {
  if (scan?.contentHash && scan.extractedRows) {
    const { error } = await supabase.from('college_sheet_snapshots').upsert({ content_hash: scan.contentHash, source_url: sourceUrl, fetched_at: scan.fetchedAt || new Date().toISOString(), extracted_rows: scan.extractedRows }, { onConflict: 'content_hash' });
    if (error) throw error;
    await cacheStoredRoster(supabase,{kind:'sheet',emailId,contentHash:scan.contentHash,filename:'Google Sheet shortlist.csv',rows:scan.extractedRows,parseStatus:'complete'});
  }
  const { error } = await supabase.from('college_sheet_sources').upsert({ college_email_id: emailId, source_url: sourceUrl, content_hash: scan?.contentHash || null, parse_status: scan ? 'complete' : 'deferred', fetched_at: new Date().toISOString() }, { onConflict: 'college_email_id,source_url' });
  if (error) throw error;
}
