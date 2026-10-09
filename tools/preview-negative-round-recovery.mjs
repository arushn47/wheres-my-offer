// Read-only review manifest. This tool has no write or sync mode.
import pg from 'pg';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { readDestinationConnection } from './cutover-connections.mjs';

export function negativeRecoveryPreview(since, until) {
  const start=Date.parse(since),end=Date.parse(until);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>24*3600000) throw Error('Supply an explicit valid window of at most 24 hours');
  return { params:[new Date(start).toISOString(),new Date(end).toISOString()], sql:`
    SELECT v.id AS decision_id,v.user_id,v.placement_drive_id,d.drive_number,c.name,
      v.round_key,v.source_received_at,v.verdict->>'sourceEmailId' source_email_id,v.verdict->>'rosterKey' roster_key,a.status,
      EXISTS(SELECT 1 FROM public.decision_notification_outbox o WHERE o.dedupe_key='shortlist_absent:'||v.user_id::text||':'||v.placement_drive_id::text) already_queued
    FROM public.round_verdicts v JOIN public.applications a ON a.user_id=v.user_id AND a.placement_drive_id=v.placement_drive_id
    JOIN public.placement_drives d ON d.id=v.placement_drive_id JOIN public.companies c ON c.id=d.company_id
    WHERE v.is_current AND v.source_received_at >= $1 AND v.source_received_at < $2
      AND v.source_received_at >= NOW()-INTERVAL '48 hours' AND v.source_received_at <= NOW()
      AND NOT a.manual_override AND a.status NOT IN ('withdrawn','declined','not_applied','registration_open','unknown')
      AND v.verdict->>'eligible'='false' AND v.verdict->>'state'='verified_absent'
      AND v.verdict->>'finalNegative'='true' AND v.verdict->>'reason'='complete_list_absence'
      AND (v.verdict->>'outcome'='rejected' OR (EXISTS(
        SELECT 1 FROM jsonb_array_elements(v.verdict->'evaluations') scan WHERE scan->>'state'='verified_absent'
      ) AND NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(v.verdict->'evaluations') scan
        LEFT JOIN public.college_emails e ON e.id::text=scan->>'emailId'
        WHERE scan->>'state'='verified_absent' AND (e.id IS NULL OR e.processing_status<>'complete'
          OR concat_ws(' ',e.subject,e.body_text) ~* '\\mlist\\s*[-:#]?\\s*[0-9]{1,2}\\M|\\mbatch\\s*[-:#]?\\s*[0-9]{1,2}\\M|\\mset\\s*[-:#]\\s*[0-9]{1,2}\\M|partial\\s+list|supplementary|additional\\s+((selection|shortlist)\\s+)?list|\\(\\s*additional\\s*\\)|more\\s+(lists?|candidates?)|first\\s+list|remaining\\s+shortlisted|remaining\\s+(students|candidates)|other\\s+shortlisted')
      )))
      AND NOT EXISTS(SELECT 1 FROM public.notifications n WHERE n.user_id=v.user_id AND n.placement_drive_id=v.placement_drive_id
        AND n.dedupe_key IN ('shortlist_absent:'||v.user_id::text||':'||v.placement_drive_id::text,
          'status:'||v.user_id::text||':'||v.placement_drive_id::text||':not_shortlisted',
          'status:'||v.user_id::text||':'||v.placement_drive_id::text||':rejected',
          'status:'||v.user_id::text||':'||v.placement_drive_id::text||':rejected_test',
          'status:'||v.user_id::text||':'||v.placement_drive_id::text||':rejected_interview'))
    ORDER BY v.source_received_at,v.user_id LIMIT 21` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const preview=negativeRecoveryPreview(...process.argv.slice(2));
  const db=new pg.Client({...await readDestinationConnection(),ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
  try {
    await db.connect();await db.query('BEGIN READ ONLY');await db.query("SET LOCAL statement_timeout='15s'");
    const {rows}=await db.query(preview.sql,preview.params);await db.query('ROLLBACK');
    if(rows.length>20)throw Error('More than 20 candidates; narrow the review window before recovery');
    const report={checkedAt:new Date().toISOString(),readOnly:true,since:preview.params[0],until:preview.params[1],candidates:rows};
    await mkdir('scratch',{recursive:true});await writeFile('scratch/negative-round-recovery-preview.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify({readOnly:true,candidateCount:rows.length,drives:[...new Set(rows.map(row=>row.name))],manifest:'scratch/negative-round-recovery-preview.json'},null,2));
  } catch(error) { console.error(JSON.stringify({error:'Negative notification preview failed',code:error.code}));process.exitCode=1; }
  finally {await db.query('ROLLBACK').catch(()=>{});await db.end();}
}
