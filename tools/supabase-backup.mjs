import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { checkLiveWriters, requireNoLiveWriters, verifyProductionPause } from './cutover-connections.mjs';
import { resolve, join } from 'node:path';
import pg from 'pg';

// Run with node --env-file=.env.local tools/supabase-backup.mjs --bin <Postgres bin>.
// This exports a recovery archive only. It never restores or truncates a database.
const args = process.argv.slice(2);
const binIndex = args.indexOf('--bin');
const bin = binIndex >= 0 ? resolve(args[binIndex + 1]) : process.env.PG_BIN;
if (binIndex >= 0 && !args[binIndex + 1]) throw new Error('--bin requires a directory');
const replacement = args.includes('--destination');
const env = parseEnv(await readFile(resolve(replacement ? '.env.restore.local' : '.env.local'),'utf8'));
const ref = replacement ? env.DESTINATION_PROJECT_REF || env.RESTORE_PROJECT_REF
  : new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
const connection = replacement ? {
  host: env.DESTINATION_DB_HOST || env.host,
  port: Number(env.DESTINATION_DB_PORT || env.port || 5432),
  user: env.DESTINATION_DB_USER || env.user,
  password: env.DESTINATION_DB_PASSWORD || env.DB_PASS, database: 'postgres',
} : {
  host: env.DB_POOLER_HOST || 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: Number(env.DB_POOLER_PORT || 5432), user: env.DB_USER || `postgres.${ref}`,
  password: env.DB_PASSWORD || env.db_pass, database: env.DB_NAME || 'postgres',
};
if (replacement && (ref !== 'nvkxyeugonjevmbvxirm' || connection.port !== 5432 ||
    !(connection.host === `db.${ref}.supabase.co` || connection.host?.endsWith('.pooler.supabase.com') && connection.user === `postgres.${ref}`))) {
  throw new Error('Only the pinned Mumbai destination can be backed up with --destination');
}
if (!connection.password) throw new Error('Database password is missing');
const cutover = args.includes('--cutover');
if (cutover && !args.includes('--writers-drained')) throw new Error('--cutover requires explicit --writers-drained attestation for old deployments/direct writers');
let cutoverPauseVerifiedAt = null;
if (cutover) { await verifyProductionPause(); cutoverPauseVerifiedAt = new Date().toISOString(); }
const destination = resolve('backups', `supabase-${ref}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const tool = name => bin ? join(bin, process.platform === 'win32' ? `${name}.exe` : name) : name;
function run(name, flags) {
  return new Promise((yes, no) => {
    const child = spawn(tool(name), flags, { env: { ...process.env, PGHOST: connection.host, PGPORT: String(connection.port), PGUSER: connection.user, PGPASSWORD: connection.password, PGDATABASE: connection.database, PGSSLMODE: 'require' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.stdout.resume();
    child.on('error', no);
    child.on('close', code => code === 0 ? yes() : no(new Error(`${name} failed (${code}): ${error.replaceAll(connection.password, '[redacted]')}`)));
  });
}
const quote = name => '"' + name.replaceAll('"', '""') + '"';
async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const client = new pg.Client({ ...connection, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
let completed = false;
try {
  await mkdir(destination, { recursive: true });
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout = '60s'");
  if (cutover) requireNoLiveWriters(await checkLiveWriters(client));
  const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
  const serverVersion = (await client.query('SHOW server_version')).rows[0].server_version;
  const tables = (await client.query("SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema IN ('public','auth','storage','supabase_migrations','vault') ORDER BY table_schema,table_name")).rows;
  const tableCounts = [];
  for (const table of tables) {
    const count = (await client.query(`SELECT count(*)::text AS count FROM ${quote(table.table_schema)}.${quote(table.table_name)}`)).rows[0].count;
    tableCounts.push({ ...table, count });
  }
  const extensions = (await client.query('SELECT extname,extversion,n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY extname')).rows;
  const functions = (await client.query("SELECT n.nspname AS schema,p.proname,pg_get_function_identity_arguments(p.oid) AS arguments FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname")).rows;
  const policies = (await client.query("SELECT schemaname,tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname IN ('public','auth','storage') ORDER BY schemaname,tablename,policyname")).rows;
  const archive = join(destination, 'database.dump');
  await run('pg_dump', ['--format=custom', '--snapshot', snapshot, '--file', archive, '--lock-wait-timeout=15000', '--verbose']);
  await run('pg_dumpall', ['--roles-only', '--no-role-passwords', '--file', join(destination, 'roles.sql')]);
  await run('pg_restore', ['--list', archive]);
  const files = [];
  for (const name of ['database.dump', 'roles.sql']) files.push({ name, bytes: (await stat(join(destination, name))).size, sha256: await checksum(join(destination, name)) });
  await writeFile(join(destination, 'manifest.json'), JSON.stringify({ projectRef: ref, createdAt: new Date().toISOString(), serverVersion, snapshotConsistent: true, cutoverPauseVerifiedAt, writersDrainedAttested:cutover, tableCounts, extensions, functions, policies, files, restoreRehearsed: false, notes: ['No role passwords exported; retain app environment secrets separately.', 'Database archive does not include Storage object bytes or provider configuration.', 'Managed-schema restore must follow the Supabase restore procedure.'] }, null, 2));
  completed = true;
  console.log(JSON.stringify({ backupDirectory: destination, tableCount: tableCounts.length, files, restoreRehearsed: false }));
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
  if (!completed) await writeFile(join(destination, 'INCOMPLETE.txt'), 'Backup failed. Do not use this directory for a cutover.\n').catch(() => {});
}
