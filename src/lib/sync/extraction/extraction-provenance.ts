import { extractJobDetails } from './events';
import { getEvidenceMessageText } from './body';

interface Source { id: string; subject?: string | null; body_text?: string | null; body_snippet?: string | null; received_at?: string | null; college_email_id?: string | null; canonical_email_id?: string | null }
/** Keep monetary conditions and each field's source with the displayed extracted value. */
export function buildExtractionProvenance(sources: Source[], values: Record<string, unknown>): Record<string, unknown> {
  const records = sources.map((source) => {
    const body = getEvidenceMessageText({subject:source.subject || '',bodyPlain:source.body_text || source.body_snippet || '',bodyHtml:'',bodySnippet:''});
    const details=extractJobDetails(body);
    const qualifiers=body.split(/\n|(?<=[.!?])\s+/).filter(clause=>/\b(?:ppo|conversion|upon confirmation|one.time|relocation|performance.based|variable pay|joining bonus)\b/i.test(clause) && /ctc|salary|stipend|lpa|lakh|bonus|allowance|relocation/i.test(clause)).map(clause=>clause.trim().slice(0,500));
    return {source,details,qualifiers};
  }).sort((a,b)=>(b.source.received_at || '').localeCompare(a.source.received_at || ''));
  return Object.fromEntries(Object.entries(values).filter(([,value])=>value!==null && value!==undefined).map(([field,value])=>{
    const key=field==='cgpa_requirement'?'cgpaRequirement':field==='backlog_requirement'?'backlogRequirement':field;
    const evidence=records.find(record=>JSON.stringify((record.details as unknown as Record<string,unknown>)[key])===JSON.stringify(value));
    return [field,{value,sourceEmailId:evidence ? evidence.source.college_email_id || evidence.source.canonical_email_id || evidence.source.id : null,sourceReceivedAt:evidence?.source.received_at || null,parserVersion:3,confidence:evidence?'parsed':'derived',qualifiers:evidence?.qualifiers || []}];
  }));
}
