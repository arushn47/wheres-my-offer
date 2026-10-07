// Read-only production observation. No sync dispatch, database writes, billing
// configuration changes, cursor resets, or Vercel credentials.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const [since, until = new Date().toISOString(), label = 'observation'] = process.argv.slice(2);
const start = Date.parse(since), end = Date.parse(until);
if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 24 * 3600000) {
  throw Error('Supply a valid UTC observation range of at most 24 hours');
}
if (!/^[a-z0-9-]{1,60}$/.test(label)) throw Error('Use a short alphanumeric report label');
const env = parseEnv(await readFile('.env.restore.local', 'utf8'));
const ref = 'nvkxyeugonjevmbvxirm';
if ((env.DESTINATION_PROJECT_REF || env.RESTORE_PROJECT_REF) !== ref || !env.WMO_RESTORE_TOKEN) {
  throw Error('Expected the existing Mumbai project and read-authorized token');
}
const sql = `SELECT toStartOfHour(timestamp) AS hour,
  log_attributes['request.path'] AS path,
  log_attributes['request.method'] AS method,
  extract(decodeURLComponent(log_attributes['request.search']), 'select=([^&]+)') AS projection,
  multiIf(position(decodeURLComponent(log_attributes['request.search']), 'placement_drive_id=in.') > 0, 'drive_batch',
    position(decodeURLComponent(log_attributes['request.search']), 'placement_drive_id=eq.') > 0, 'single_drive',
    position(decodeURLComponent(log_attributes['request.search']), 'id=in.') > 0, 'id_batch',
    position(decodeURLComponent(log_attributes['request.search']), 'id=eq.') > 0, 'single_id', 'other') AS scope,
  log_attributes['response.status_code'] AS status,
  count() AS requests
FROM logs WHERE source = 'edge_logs'
GROUP BY hour,path,method,projection,scope,status ORDER BY hour,path,method,projection,scope,status LIMIT 2000`;
const url = new URL(`https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs`);
url.search = new URLSearchParams({sql,iso_timestamp_start:since,iso_timestamp_end:until}).toString();
const response = await fetch(url, {headers:{Authorization:`Bearer ${env.WMO_RESTORE_TOKEN}`},signal:AbortSignal.timeout(45000)});
if (!response.ok) throw Error(`Read-only analytics request failed: HTTP ${response.status}`);
const data = await response.json();
if (data.error || !Array.isArray(data.result)) throw Error('Analytics did not return a valid aggregate result');
const rows = data.result;
const sum = predicate => rows.filter(predicate).reduce((n,row) => n + Number(row.requests), 0);
const report = {
  checkedAt:new Date().toISOString(),projectRef:ref,since,until,readOnly:true,
  // API log ranges are rounded to minute boundaries by the provider. Counters
  // reflect retained logs; do not equate request counts with billed byte savings.
  providerCaveats:['Ranges rounded to minute boundaries; subject to log retention/reporting lag.','No authoritative billed bytes in API logs. Record selected-project Supabase Usage readings separately.'],
  totalRequests:sum(() => true),
  failedRequests:sum(row => Number(row.status) >= 400),
  legacyCatchUpRecencyReads:sum(row => row.method==='GET' && ['/rest/v1/personal_emails','/rest/v1/college_emails'].includes(row.path) && row.projection.replace(/\s/g,'')==='id,received_at' && ['single_drive','single_id'].includes(row.scope)),
  legacyCatchUpEventReads:sum(row => row.method==='GET' && row.path==='/rest/v1/events' && row.projection.replace(/\s/g,'')==='id,event_type,title,start_time,venue,mode'),
  batchedCatchUpEventReads:sum(row => row.method==='GET' && row.path==='/rest/v1/events' && row.projection.replace(/\s/g,'')==='id,placement_drive_id,event_type,title,start_time,venue,mode'),
  truncated:rows.length===2000,rows,
};
await mkdir('scratch/notification-catchup-observation',{recursive:true});
const path=`scratch/notification-catchup-observation/${label}.json`;
await writeFile(path,JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,rows:undefined,path},null,2));
