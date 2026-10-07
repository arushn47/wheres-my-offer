// Additive migrations only, on the pinned isolated Mumbai replacement.
// Default is a read-only readiness check; --apply installs reviewed local SQL.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ref = process.env.DESTINATION_PROJECT_REF || process.env.RESTORE_PROJECT_REF;
const host = process.env.DESTINATION_DB_HOST || process.env.host;
const user = process.env.DESTINATION_DB_USER || process.env.user;
const url = process.env.DESTINATION_SUPABASE_URL || process.env.RESTORE_SUPABASE_URL;
const port = Number(process.env.DESTINATION_DB_PORT || process.env.port || 5432);
if (ref !== 'nvkxyeugonjevmbvxirm' || new URL(url).hostname !== `${ref}.supabase.co` || port !== 5432 ||
    !(host === `db.${ref}.supabase.co` || host?.endsWith('.pooler.supabase.com') && user === `postgres.${ref}`)) {
  throw new Error('Only the pinned Mumbai replacement is allowed');
}
const db = new pg.Client({host,user,port,database:'postgres',password:process.env.DESTINATION_DB_PASSWORD || process.env.DB_PASS,
  ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const migrations = ['migration_v41_roster_lookup.sql','migration_v42_compact_sync_progress.sql','migration_v43_compact_dashboard_reads.sql'];
try {
  await db.connect();
  if (process.argv.includes('--apply')) {
    for (const name of migrations) await db.query(await readFile(resolve('supabase','migrations',name),'utf8'));
    await db.query("NOTIFY pgrst, 'reload schema'");
  }
  await db.query('BEGIN READ ONLY');
  const signatures = ['lookup_candidate_rosters(uuid[],text[],integer)', 'get_shared_college_progress()',
    'get_user_sync_page_progress(uuid,uuid[])', 'get_user_round_status_rows(uuid,uuid[],boolean)', 'get_user_drive_activity(uuid)', 'get_recent_college_search_rows()'];
  for (const signature of signatures) {
    const { rows } = await db.query(`SELECT to_regprocedure($1) IS NOT NULL AS exists,
      CASE WHEN to_regprocedure($1) IS NOT NULL THEN has_function_privilege('service_role',$1,'EXECUTE') END AS server_access,
      CASE WHEN to_regprocedure($1) IS NOT NULL THEN has_function_privilege('anon',$1,'EXECUTE') OR has_function_privilege('authenticated',$1,'EXECUTE') END AS client_access`,['public.'+signature]);
    if (!rows[0].exists || !rows[0].server_access || rows[0].client_access) throw new Error('Missing or incorrectly granted cost RPC: '+signature);
  }
  console.log(JSON.stringify({projectRef:ref,applied:process.argv.includes('--apply'),verifiedServiceOnlyRpcs:signatures.length,productionChanged:false}));
} finally { await db.query('ROLLBACK').catch(()=>{}); await db.end(); }
