import { createHash } from 'node:crypto';
import type { createAdminClient } from '@/lib/supabase/admin';
import { optimizedReadEnabled, allowLegacyReadFallback } from '@/lib/supabase/read-policy';
import type { CachedRosterInput } from './shortlist-verification';
import { isNonShortlistRoster, isPositiveRosterRow, normalizeIdentityToken } from './roster-policy';

export const ROSTER_LOOKUP_POLICY_VERSION = 1;
export interface RosterLocation { sheetIndex: number; sheetName: string | null; rowNumber: number }
export interface RosterLookupSummary { usable: boolean; match: RosterLocation | null }
export const identityTokenHash = (value: unknown) => createHash('sha256').update(normalizeIdentityToken(value)).digest('hex');

/** Uses the existing row policy verbatim; names and negative/eligible tabs grant no new eligibility. */
export function buildRosterLookup(rows: CachedRosterInput['extractedRows'], parseStatus: string | null, emailId: string, filename: string) {
  const locations: Record<string,RosterLocation> = Object.create(null);
  let usable = false;
  if (parseStatus === 'complete') for (const [sheetIndex,sheet] of (rows || []).entries()) {
    if (isNonShortlistRoster(sheet.sheetName) || !sheet.rows.length) continue;
    usable = true;
    for (const [rowIndex,row] of sheet.rows.entries()) {
      if (!Array.isArray(row) || !isPositiveRosterRow(row,sheet.rows[0])) continue;
      for (const cell of row) {
        if (!normalizeIdentityToken(cell)) continue;
        const hash = identityTokenHash(cell);
        if (!locations[hash]) locations[hash] = {sheetIndex,sheetName:sheet.sheetName || null,rowNumber:rowIndex+1};
      }
    }
  }
  return {usable,locations,legacyHash:createHash('sha256').update(JSON.stringify(rows || [emailId,filename])).digest('hex')};
}

type Admin = ReturnType<typeof createAdminClient>;
interface LookupRow {
  source_kind:'attachment'|'sheet'; source_key:string|null; source_revision:number|null;
  college_email_id:string; filename:string; size_bytes:number; content_hash:string|null;parse_status:string|null;
  index_ready:boolean;usable:boolean|null;legacy_roster_hash:string|null;match_location:RosterLocation|null;
}
export interface CandidateRoster extends CachedRosterInput {
  contentHash?:string|null; sourceKind:'attachment'|'sheet'; sourceKey:string|null; sizeBytes:number;
}
export async function publishRosterLookup(supabase:Admin, source:{kind:'attachment'|'sheet';key:string;revision:number;rows:CachedRosterInput['extractedRows'];parseStatus:string|null;emailId:string;filename:string}) {
  const lookup=buildRosterLookup(source.rows,source.parseStatus,source.emailId,source.filename);
  const {data,error}=await supabase.rpc('publish_roster_lookup',{p_kind:source.kind,p_key:source.key,p_revision:source.revision,p_policy:ROSTER_LOOKUP_POLICY_VERSION,p_usable:lookup.usable,p_hash:lookup.legacyHash,p_locations:lookup.locations});
  if(error)throw error;
  return {published:data===true,lookup};
}

/** Returns null only when rollout is disabled or the additive migration is absent. */
export async function loadCandidateRosters(supabase:Admin,emailIds:string[],tokens:string[]):Promise<CandidateRoster[]|null> {
  if(!optimizedReadEnabled('ROSTER_LOOKUP_ENABLED'))return null;
  const result:CandidateRoster[]=[];
  for(let offset=0;offset<emailIds.length;offset+=100){
    const {data,error}=await supabase.rpc('lookup_candidate_rosters',{p_email_ids:emailIds.slice(offset,offset+100),p_token_hashes:[...new Set(tokens.filter(token=>normalizeIdentityToken(token)).map(identityTokenHash))],p_policy:ROSTER_LOOKUP_POLICY_VERSION});
    if(error){if(allowLegacyReadFallback(error))return null;throw error;}
    for(const original of (data || []) as LookupRow[]){
      let row=original;
      let rawRows:CachedRosterInput['extractedRows'];
      let summary:RosterLookupSummary|undefined;
      if(row.index_ready)summary={usable:row.usable===true,match:row.match_location};
      else if(row.source_key && /\.(xlsx|xls|csv)$/i.test(row.filename)){
        const table=row.source_kind==='attachment'?'college_attachments':'college_sheet_snapshots';
        const selection=row.source_kind==='attachment'?'extracted_rows,roster_revision,parse_status,content_hash':'extracted_rows,roster_revision';
        const fetched=await supabase.from(table).select<string>(selection).eq(row.source_kind==='attachment'?'id':'content_hash',row.source_key).maybeSingle();
        if(fetched.error)throw fetched.error;
        if(fetched.data){
          const current=fetched.data as unknown as {extracted_rows:CachedRosterInput['extractedRows'];roster_revision:number;parse_status?:string;content_hash?:string|null};
          rawRows=current.extracted_rows;
          row={...row,source_revision:current.roster_revision,parse_status:current.parse_status ?? row.parse_status,content_hash:current.content_hash ?? row.content_hash};
          // Cache failure must not turn a successful canonical read into an outage.
          try { await publishRosterLookup(supabase,{kind:row.source_kind,key:row.source_key!,revision:current.roster_revision,rows:rawRows,parseStatus:row.source_kind==='sheet'?'complete':row.parse_status,emailId:row.college_email_id,filename:row.filename}); }
          catch { /* Use the canonical rows for this calculation; next sync retries the cache. */ }
        }
      }
      result.push({filename:row.filename,collegeEmailId:row.college_email_id,parseStatus:row.parse_status,contentHash:row.content_hash || (summary ? row.legacy_roster_hash : null),extractedRows:rawRows,indexedSummary:summary,sourceKind:row.source_kind,sourceKey:row.source_key,sizeBytes:row.size_bytes});
    }
  }
  return result;
}

/** Populate the optional cache while ingestion still has the canonical rows in memory. */
export async function cacheStoredRoster(supabase:Admin, source:{kind:'attachment'|'sheet';emailId:string;attachmentId?:string;contentHash?:string;filename:string;rows:CachedRosterInput['extractedRows'];parseStatus:string|null}) {
  if(!optimizedReadEnabled('ROSTER_LOOKUP_ENABLED'))return;
  try {
    const query=source.kind==='attachment'
      ? supabase.from('college_attachments').select('id,roster_revision').eq('college_email_id',source.emailId).eq('attachment_id',source.attachmentId!)
      : supabase.from('college_sheet_snapshots').select('content_hash,roster_revision').eq('content_hash',source.contentHash!);
    const {data,error}=await query.maybeSingle();
    if(error||!data)return;
    const stored=data as unknown as {id?:string;content_hash?:string;roster_revision:number};
    await publishRosterLookup(supabase,{...source,key:(stored.id||stored.content_hash)!,revision:stored.roster_revision});
  } catch { /* Optional cache failure leaves canonical ingestion successful. */ }
}
