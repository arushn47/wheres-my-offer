import { createHash } from 'node:crypto';
import { extractRecruitmentVenues, resolveDriveVenue } from '../src/lib/drive-venues.ts';
import { getEvidenceMessageText } from '../src/lib/sync/extraction/body.ts';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function driveNumbers(drive) {
  return [...new Set([drive.drive_number, drive.normalized_drive_number,
    drive.normalized_drive_number?.match(/[0-9]+$/)?.[0]].filter(Boolean).map(n=>n.trim().toLowerCase()))];
}
export function sourceBelongsToDrive(drive, source) {
  if (source.classification === 'irrelevant' || (drive.excluded_email_ids || []).includes(source.id)) return false;
  // Historical number tags can themselves be wrong. A contradictory stored
  // company name vetoes a venue update; company-name matching never authorizes one.
  const norm=value=>String(value||'').toLowerCase().replace(/\b(?:pvt|private|ltd|limited)\b/g,'').replace(/[^a-z0-9]/g,'');
  if (drive.company_name && source.parsed_company_name) {
    const name=norm(source.parsed_company_name);
    const aliases=[drive.company_name,...(drive.company_aliases||[]),...(drive.aliases||[])].map(norm).filter(Boolean);
    if (!aliases.some(alias=>alias===name || alias.length>=4 && name.startsWith(alias) || name.length>=4 && alias.startsWith(name))) return false;
  }
  const numbers = Array.isArray(source.parsed_drive_numbers) ? source.parsed_drive_numbers : [];
  return numbers.length ? numbers.every(n=>driveNumbers(drive).includes(String(n).trim().toLowerCase()))
    : drive.source_college_email_id === source.id;
}
export function mergeProjection(previous, updates) {
  const stages = new Map();
  // Mirror v44: latest timestamp/source per stage and audience, then bound to 12.
  for (const entry of [...(previous?.entries || []), ...updates.flatMap(u=>u.entries.map(e=>({...e,sourceId:u.sourceId,receivedAt:u.receivedAt})))]) {
    const key = `${entry.stage}:${entry.audience || ''}`, old = stages.get(key);
    if (!old || Date.parse(entry.receivedAt) > Date.parse(old.receivedAt)
      || Date.parse(entry.receivedAt) === Date.parse(old.receivedAt) && entry.sourceId >= old.sourceId) stages.set(key,entry);
  }
  return {version:1,entries:[...stages.values()].sort((a,b)=>a.stage.localeCompare(b.stage)||(a.audience||'').localeCompare(b.audience||'')).slice(0,12)};
}
export function latestVenueUpdates(previous, updates) {
  const incoming=new Set(updates.map(u=>u.sourceId)),groups=new Map();
  for(const {sourceId,receivedAt,...entry} of mergeProjection(previous,updates).entries) {
    if(!incoming.has(sourceId)) continue;
    if(!groups.has(sourceId)) groups.set(sourceId,{sourceId,receivedAt,entries:[]});
    groups.get(sourceId).entries.push(entry);
  }
  return [...groups.values()];
}
export function buildBatchReview(drives, sources, rejectedSourceIds = new Set()) {
  return drives.map(drive=>{
    const exact = sources.filter(s=>sourceBelongsToDrive(drive,s));
    const updates = exact.flatMap(source=>{
      if (rejectedSourceIds.has(source.id)) return [];
      if (!source.received_at) return [];
      // Confirm the circular's own subject too: old canonical company/number
      // tags can both be contaminated by another company's forwarded message.
      // This is a veto only, never a substitute for exact drive association.
      if (drive.company_name) {
        const norm=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');
        const first=drive.company_name.match(/[A-Za-z0-9]+/)?.[0];
        const names=[drive.company_name,...(drive.company_aliases||[]),...(drive.aliases||[]),...(first?.length>=4?[first]:[])];
        if (!names.filter(Boolean).some(name=>norm(name).length>=4 ? norm(source.subject).includes(norm(name))
          : String(source.subject||'').toLowerCase().split(/[^a-z0-9]+/).includes(norm(name)))) return [];
      }
      const body = getEvidenceMessageText({subject:source.subject || '',bodyPlain:source.body_text || '',bodyHtml:'',bodySnippet:''});
      const entries = extractRecruitmentVenues(source.subject || '',body);
      // Invalidate this same source's superseded parser output without erasing
      // newer instructions or unrelated canonical evidence.
      for(const old of drive.recruitment_venues?.entries||[]) {
        if(old.sourceId===source.id && !entries.some(e=>e.stage===old.stage && (e.audience||'')===(old.audience||''))) {
          entries.push({stage:old.stage,kind:'unknown',name:'',quote:old.quote,...(old.audience?{audience:old.audience}:{})});
        }
      }
      return entries.length ? [{sourceId:source.id,receivedAt:new Date(source.received_at).toISOString(),entries}] : [];
    });
    const proposed = mergeProjection(drive.recruitment_venues,updates);
    return {driveId:drive.id,driveNumber:drive.drive_number,name:drive.company_name,sourceCount:exact.length,
      before:resolveDriveVenue(drive.recruitment_venues,'VIT Bhopal'),after:resolveDriveVenue(proposed,'VIT Bhopal'),
      updates,changed:updates.length>0 && digest(drive.recruitment_venues)!==digest(proposed)};
  });
}
