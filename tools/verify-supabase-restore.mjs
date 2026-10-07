import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import pg from 'pg';

// Read-only destination preflight/verification. Never writes, restores or cuts over.
const args = process.argv.slice(2);
const index = args.indexOf('--backup');
if (index < 0 || !args[index + 1]) throw new Error('--backup is required');
const directory = resolve(args[index + 1]);
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const aliases = {DESTINATION_PROJECT_REF:'RESTORE_PROJECT_REF',DESTINATION_DB_HOST:'host',DESTINATION_DB_USER:'user',DESTINATION_DB_PASSWORD:'DB_PASS'};
const required = name => { const value = process.env[name] || process.env[aliases[name]]; if (!value) throw new Error(`${name} is required`); return value; };
const ref = required('DESTINATION_PROJECT_REF');
if (ref === manifest.projectRef || ref === 'xvxkkqdnatnqumnlshlg') throw new Error('Source and Aegis Watch are forbidden restore destinations');
const host = required('DESTINATION_DB_HOST');
const user = required('DESTINATION_DB_USER');
if (host !== `db.${ref}.supabase.co` && !(host.endsWith('.pooler.supabase.com') && user === `postgres.${ref}`)) throw new Error('Connection does not identify the expected destination project');
const client = new pg.Client({host,user,password:required('DESTINATION_DB_PASSWORD'),port:Number(process.env.DESTINATION_DB_PORT || process.env.port || 5432),database:'postgres',ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const verify = args.includes('--verify');
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout = '60s'");
  const expectedTables = manifest.tableCounts.filter(table => ['public','auth','storage'].includes(table.table_schema) && !['auth.schema_migrations','storage.migrations'].includes(`${table.table_schema}.${table.table_name}`));
  const mismatches = [];
  if (!verify) {
    const publicTables = (await client.query("SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")).rows[0].count;
    if (publicTables) mismatches.push('Destination public schema is not fresh; do not restore into existing tables');
  }
  for (const table of expectedTables) {
    const exists = (await client.query('SELECT to_regclass($1) IS NOT NULL AS exists',[`${table.table_schema}.${table.table_name}`])).rows[0].exists;
    if (!exists) {
      if (verify || table.table_schema !== 'public') mismatches.push(`Missing table ${table.table_schema}.${table.table_name}`);
      continue;
    }
    const count = (await client.query(`SELECT count(*)::text AS count FROM ${quote(table.table_schema)}.${quote(table.table_name)}`)).rows[0].count;
    if (verify ? count !== table.count : count !== '0') mismatches.push(`${table.table_schema}.${table.table_name}: unexpected row count ${count}`);
  }
  // Ensure managed COPY statements can run without replacing the managed schema.
  const data = await readFile(join(directory,'restore-preparation','managed-data.sql'),'utf8');
  for (const match of data.matchAll(/COPY (auth|storage)\.([a-z0-9_]+) \(([^)]+)\) FROM stdin;/g)) {
    const actual = (await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',[match[1],match[2]])).rows.map(row => row.column_name);
    const expected = match[3].split(',').map(column => column.trim().replaceAll('"',''));
    for (const column of expected) if (!actual.includes(column)) mismatches.push(`Managed column missing: ${match[1]}.${match[2]}.${column}`);
  }
  const extensions = (await client.query('SELECT extname FROM pg_extension')).rows.map(row => row.extname);
  for (const extension of manifest.extensions) if (!extensions.includes(extension.extname)) mismatches.push(`Extension missing: ${extension.extname}`);
  if (verify) {
    const functions = (await client.query("SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")).rows;
    for (const fn of manifest.functions) if (!functions.some(actual => actual.proname === fn.proname && actual.arguments === fn.arguments)) mismatches.push(`Missing public function: ${fn.proname}`);
    const policies = (await client.query("SELECT schemaname,tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname IN ('public','auth','storage')")).rows;
    for (const policy of manifest.policies) if (!policies.some(actual => actual.schemaname === policy.schemaname && actual.tablename === policy.tablename && actual.policyname === policy.policyname && actual.cmd === policy.cmd && actual.qual === policy.qual && actual.with_check === policy.with_check && JSON.stringify(actual.roles) === JSON.stringify(policy.roles))) mismatches.push(`Policy mismatch: ${policy.schemaname}.${policy.tablename}.${policy.policyname}`);
    const sourceSchema = await readFile(join(directory,'restore-preparation','application-schema.sql'),'utf8');
    const sourceRls = new Set([...sourceSchema.matchAll(/ALTER TABLE public\.([a-z0-9_]+) ENABLE ROW LEVEL SECURITY;/g)].map(match=>match[1]));
    const actualRls = (await client.query("SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")).rows;
    const sourcePublicTables=new Set(expectedTables.filter(table=>table.table_schema==='public').map(table=>table.table_name));
    for (const table of actualRls) if (sourcePublicTables.has(table.relname) && sourceRls.has(table.relname) !== table.relrowsecurity) mismatches.push(`RLS flag mismatch: ${table.relname}`);
    const invalidConstraints = (await client.query("SELECT count(*)::int AS count FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT c.convalidated")).rows[0].count;
    if (invalidConstraints) mismatches.push(`${invalidConstraints} unvalidated public constraints`);
    // Replica mode bypasses FK triggers during COPY; validate the actual rows too.
    const foreignKeys = (await client.query(`
      SELECT c.conname,ns.nspname AS source_schema,t.relname AS source_table,
        nt.nspname AS target_schema,rt.relname AS target_table,
        array_agg(a.attname::text ORDER BY keys.ordinality) AS source_columns,
        array_agg(ra.attname::text ORDER BY keys.ordinality) AS target_columns
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace ns ON ns.oid=t.relnamespace JOIN pg_class rt ON rt.oid=c.confrelid
      JOIN pg_namespace nt ON nt.oid=rt.relnamespace
      CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY AS keys(source_key,target_key,ordinality)
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=keys.source_key
      JOIN pg_attribute ra ON ra.attrelid=rt.oid AND ra.attnum=keys.target_key
      WHERE c.contype='f' AND ns.nspname='public'
      GROUP BY c.oid,c.conname,ns.nspname,t.relname,nt.nspname,rt.relname`)).rows;
    for (const fk of foreignKeys) {
      const nonNull = fk.source_columns.map(column => `r.${quote(column)} IS NOT NULL`).join(' AND ');
      const equality = fk.source_columns.map((column,i) => `r.${quote(column)} = target.${quote(fk.target_columns[i])}`).join(' AND ');
      const missing = (await client.query(`SELECT EXISTS(SELECT 1 FROM ${quote(fk.source_schema)}.${quote(fk.source_table)} r WHERE ${nonNull} AND NOT EXISTS(SELECT 1 FROM ${quote(fk.target_schema)}.${quote(fk.target_table)} target WHERE ${equality})) AS missing`)).rows[0].missing;
      if (missing) mismatches.push(`Orphaned rows for constraint: ${fk.conname}`);
    }
  }
  console.log(JSON.stringify({destinationProjectRef:ref,mode:verify?'restored verification':'empty destination preflight',passed:mismatches.length===0,mismatches,readOnly:true,productionCutover:false},null,2));
  if (mismatches.length) process.exitCode = 1;
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
}
