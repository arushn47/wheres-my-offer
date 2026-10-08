// Bounded venue-only review/apply. Never calls sync, status, notification or calendar code.
// Node 24+ supports the pure TypeScript extractor used by application ingestion.
import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readDestinationConnection } from './cutover-connections.mjs';
import { extractRecruitmentVenues, resolveDriveVenue } from '../src/lib/drive-venues.ts';
import { getEvidenceMessageText } from '../src/lib/sync/extraction/body.ts';
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const args = process.argv.slice(2);
const applying = args[0] === '--apply-reviewed';
if (!(applying && args.length === 2 || args[0] === '--drive' && uuid.test(args[1] || '') && args.length === 2)) {
  throw Error('Use --drive UUID for a read-only review, or --apply-reviewed PATH only after explicit authorization.');
}
const reviewed = applying ? JSON.parse(await readFile(args[1], 'utf8')) : null;
const driveId = reviewed?.driveId || args[1];
if (!uuid.test(driveId)) throw Error('Exact drive UUID required');
const destination = await readDestinationConnection();
const db = new Client({ ...destination, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  await db.connect();
  await db.query(applying ? 'BEGIN' : 'BEGIN READ ONLY');
  await db.query("SET LOCAL lock_timeout='2s'");
  await db.query("SET LOCAL statement_timeout='15s'");
  const { rows: drives } = await db.query(`SELECT d.id,d.drive_number,d.normalized_drive_number,d.source_college_email_id,d.excluded_email_ids,
    to_jsonb(d)->'recruitment_venues' AS recruitment_venues FROM public.placement_drives d WHERE id=$1`, [driveId]);
  const drive = drives[0];
  if (!drive) throw Error('Drive not found');
  if (applying && (reviewed.projectRef !== 'nvkxyeugonjevmbvxirm' || reviewed.readOnly !== true)) throw Error('Expected a reviewed Mumbai dry-run report');
  const numbers = [...new Set([drive.drive_number, drive.normalized_drive_number].filter(Boolean).flatMap(n => [n.toLowerCase(),n.match(/\d+$/)?.[0]].filter(Boolean)))];
  // The primary canonical anchor is an existing exact-row reference. Other sources must carry this drive number.
  const { rows: sources } = await db.query(`SELECT c.id,c.subject,c.body_text,c.received_at,c.parsed_drive_numbers FROM public.college_emails c
    WHERE (c.id=$1 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.parsed_drive_numbers)='array' THEN c.parsed_drive_numbers ELSE '[]'::jsonb END) n
      WHERE lower(n)=ANY($2::text[]))) AND c.classification IS DISTINCT FROM 'irrelevant'
    ORDER BY c.received_at,c.id LIMIT 201`, [drive.source_college_email_id,numbers]);
  if (sources.length > 200) throw Error('More than 200 sources: narrow review manually rather than scan broadly');
  const excluded = new Set(drive.excluded_email_ids || []);
  const updates = sources.filter(s => !excluded.has(s.id)).filter(s => {
    // Conflicting explicit drive numbers also disqualify a stale primary anchor.
    const nums = Array.isArray(s.parsed_drive_numbers) ? s.parsed_drive_numbers : [];
    return !nums.length || nums.every(n => numbers.includes(String(n).trim().toLowerCase()));
  }).flatMap(source => {
    if (!source.received_at) return [];
    const body = getEvidenceMessageText({ subject: source.subject, bodyPlain: source.body_text || '', bodyHtml: '', bodySnippet: '' });
    const entries = extractRecruitmentVenues(source.subject || '', body);
    return entries.length ? [{ sourceId: source.id, receivedAt: new Date(source.received_at).toISOString(), entries }] : [];
  });
  const evidenceHash = digest(updates);
  if (applying) {
    if (reviewed.version !== 1 || reviewed.evidenceHash !== evidenceHash || digest(reviewed.updates) !== evidenceHash) throw Error('Reviewed sources changed; prepare and review a fresh report');
    for (const update of updates) await db.query('SELECT public.merge_drive_recruitment_venues($1,$2,$3,$4::jsonb)', [driveId,update.sourceId,update.receivedAt,JSON.stringify(update.entries)]);
    await db.query('COMMIT');
    console.log(JSON.stringify({ driveId, venueOnly: true, sourceCount: updates.length, applied: true }));
  } else {
    const current = new Map((drive.recruitment_venues?.entries || []).map(e => [`${e.stage}:${e.audience || ''}`,e]));
    for (const update of updates) for (const e of update.entries) {
      const key = `${e.stage}:${e.audience || ''}`, previous = current.get(key);
      if (!previous || Date.parse(update.receivedAt) > Date.parse(previous.receivedAt)
        || Date.parse(update.receivedAt) === Date.parse(previous.receivedAt) && update.sourceId >= previous.sourceId) current.set(key,{ ...e,sourceId:update.sourceId,receivedAt:update.receivedAt });
    }
    const report = { version: 1, projectRef: 'nvkxyeugonjevmbvxirm', checkedAt: new Date().toISOString(), driveId, driveNumber: drive.drive_number,
      evidenceHash, updates, before: resolveDriveVenue(drive.recruitment_venues), after: resolveDriveVenue({ version: 1,entries:[...current.values()].slice(0,12) }),
      readOnly: true, instruction: 'Review exact source/drive association and quotes before authorizing venue-only apply. This file never authorizes application status or calendar/notification changes.' };
    await db.query('ROLLBACK');
    await mkdir('scratch/drive-venue-reviews',{ recursive: true });
    const path = `scratch/drive-venue-reviews/${driveId}.json`;
    await writeFile(path,JSON.stringify(report,null,2));
    console.log(JSON.stringify({ driveId,driveNumber: report.driveNumber, before:report.before,after:report.after,sourceCount:updates.length,path,readOnly:true },null,2));
  }
} finally { await db.query('ROLLBACK').catch(()=>{}); await db.end(); }
