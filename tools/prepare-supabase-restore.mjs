import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// OFFLINE ONLY: verifies an archive and prepares files. Never connects to a database.
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`${name} is required`);
  return args[index + 1];
};
const directory = resolve(option('--backup'));
const bin = resolve(option('--bin'));
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
if (!manifest.snapshotConsistent) throw new Error('A consistent completed backup is required');
for (const file of manifest.files) {
  if (!['database.dump', 'roles.sql'].includes(file.name)) throw new Error('Unexpected archive filename');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(directory, file.name))) hash.update(chunk);
  if (hash.digest('hex') !== file.sha256) throw new Error(`Checksum mismatch: ${file.name}`);
}
const output = join(directory, 'restore-preparation');
await mkdir(output, { recursive: true });
async function restore(flags) {
  return new Promise((yes, no) => {
    const child = spawn(join(bin, process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore'), [...flags, join(directory, 'database.dump')], {windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', no);
    child.on('close', code => code === 0 ? yes(stdout) : no(new Error(`Archive extraction failed (${code}): ${stderr}`)));
  });
}
const toc = await restore(['--list']);
await writeFile(join(output, 'archive.list'), toc);
const entries = toc.split(/\r?\n/).filter(line => /^\d+;/.test(line));
// Keep app definitions/data/grants. Managed platform definitions and their migration
// history are supplied by the destination Supabase project, not overwritten by us.
const platformDefaultAcls = entries.filter(line => / DEFAULT ACL public .* supabase_admin$/.test(line));
const publicEntries = entries.filter(line => /^\d+; \d+ \d+ \S+(?: \S+)*? public /.test(line) && !platformDefaultAcls.includes(line));
const sourceCounts = new Map(manifest.tableCounts.map(table=>[`${table.table_schema}.${table.table_name}`,table.count]));
if (sourceCounts.get('storage.objects') && sourceCounts.get('storage.objects') !== '0') {
  throw new Error('Storage contains object metadata; export and verify object bytes using a separate supported migration before restoring');
}
const managedDataEntries = entries.filter(line => {
  if (/ SEQUENCE SET (auth|storage) /.test(line)) return true;
  const match = line.match(/ TABLE DATA (auth|storage) ([a-z0-9_]+) /);
  // Empty destination-managed tables need no COPY. Protected vector tables cannot
  // be loaded by postgres; refuse nonempty data rather than silently omitting it.
  if (!match || ['auth.schema_migrations','storage.migrations'].includes(`${match[1]}.${match[2]}`)) return false;
  if (sourceCounts.get(`${match[1]}.${match[2]}`) === '0') return false;
  if (['storage.buckets_vectors','storage.vector_indexes'].includes(`${match[1]}.${match[2]}`)) throw new Error('Nonempty vector storage requires a separate supported migration');
  return true;
});
const historyEntries = entries.filter(line => / supabase_migrations /.test(line));
const managedSchema = await restore(['--schema-only','--schema=auth','--schema=storage','--no-owner','--file=-']);
await writeFile(join(output, 'managed-schema-reference.sql'), managedSchema);
await writeFile(join(output,'platform-default-acls.list'), platformDefaultAcls.join('\n')+'\n');
await restore(['--schema-only','--no-owner','--use-list',join(output,'platform-default-acls.list'),'--file',join(output,'platform-default-acls-reference.sql')]);
const customTriggerDefinitions = [...managedSchema.matchAll(/CREATE TRIGGER [^;]+;/g)]
  .map(match => match[0]).filter(sql => !/EXECUTE (?:FUNCTION|PROCEDURE) (?:auth|storage)\./.test(sql));
const managedCustomizations = [...entries.filter(line => / POLICY (?:auth|storage) /.test(line)), ...customTriggerDefinitions];
if (managedCustomizations.length) throw new Error('Managed-schema customizations require review before generating a restore package');
if (manifest.tableCounts.some(table => table.table_schema === 'vault' && table.count !== '0')) throw new Error('Vault data requires the provider encryption root-key migration procedure');
const expectedTables = manifest.tableCounts.filter(table => table.table_schema === 'public');
for (const table of expectedTables) {
  if (!publicEntries.some(line => line.includes(` TABLE DATA public ${table.table_name} `))) throw new Error(`Missing table data in archive: ${table.table_name}`);
}
for (const [name, list] of [['application.list', publicEntries], ['managed-data.list', managedDataEntries], ['migration-history.list', historyEntries]]) {
  await writeFile(join(output, name), list.join('\n') + '\n');
}
await restore(['--schema-only','--no-owner','--use-list',join(output,'application.list'),'--file',join(output,'application-schema.sql')]);
await restore(['--data-only','--no-owner','--use-list',join(output,'application.list'),'--file',join(output,'application-data.sql')]);
await restore(['--data-only','--no-owner','--use-list',join(output,'managed-data.list'),'--file',join(output,'managed-data.sql')]);
const extractedCounts = new Map();
for (const name of ['application-data.sql','managed-data.sql']) {
  let table = null, count = 0;
  for (const line of (await readFile(join(output,name),'utf8')).split(/\r?\n/)) {
    if (table) {
      if (line === '\\.') { extractedCounts.set(table,String(count)); table=null; }
      else count++;
    } else {
      const match = line.match(/^COPY (public|auth|storage)\.([a-z0-9_]+) \([^)]*\) FROM stdin;$/);
      if (match) { table=`${match[1]}.${match[2]}`; count=0; }
    }
  }
  if (table) throw new Error('Extracted COPY data is truncated');
}
for (const table of manifest.tableCounts.filter(table => ['public','auth','storage'].includes(table.table_schema) && !['auth.schema_migrations','storage.migrations'].includes(`${table.table_schema}.${table.table_name}`))) {
  const emptyManagedTable = table.table_schema !== 'public' && table.count === '0';
  if ((extractedCounts.get(`${table.table_schema}.${table.table_name}`) ?? (emptyManagedTable ? '0' : undefined)) !== table.count) throw new Error(`Extracted row count mismatch: ${table.table_schema}.${table.table_name}`);
}
if (historyEntries.length) await restore(['--no-owner','--use-list',join(output,'migration-history.list'),'--file',join(output,'migration-history.sql')]);
// Keep the full Auth DDL for destination compatibility review, never execute it.
await restore(['--schema-only','--schema=auth','--no-owner','--file',join(output,'auth-schema-reference.sql')]);
await writeFile(join(output, 'restore.sql'), [
  '\\set ON_ERROR_STOP on',
  '-- Run ONLY on the verified fresh destination, with psql --single-transaction.',
  '-- Execute from this directory. Provider extensions/roles must already exist.',
  "SET statement_timeout = '0';",
  "SET lock_timeout = '15s';",
  'SET session_replication_role = replica;',
  // Supabase's fresh-project defaults are broader than this application's source
  // defaults. Reset the writable role's grants before replaying archived defaults.
  ...['TABLES','SEQUENCES','FUNCTIONS'].map(kind => `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON ${kind} FROM anon, authenticated, service_role;`),
  '\\i application-schema.sql',
  '\\i managed-data.sql',
  '\\i application-data.sql',
  ...(historyEntries.length ? ['\\i migration-history.sql'] : []),
  'SET session_replication_role = origin;',
  "NOTIFY pgrst, 'reload schema';",
].join('\n') + '\n');
const report = {
  sourceProjectRef: manifest.projectRef, archiveChecksumsVerified: true,
  extractedTableCountsVerified: manifest.tableCounts.filter(table => ['public','auth','storage'].includes(table.table_schema) && !['auth.schema_migrations','storage.migrations'].includes(`${table.table_schema}.${table.table_name}`)).length,
  publicTableCount: expectedTables.length, managedDataEntries: managedDataEntries.length,
  managedCustomizations: managedCustomizations.length, historyEntries: historyEntries.length,
  platformDefaultAclsRetainedFromDestination: platformDefaultAcls.length,
  sourceVaultEmpty: true, restoreRehearsed: false,
  destinationPreflightRequired: ['Fresh project; must not be the source or Aegis Watch', 'Matching Auth/storage columns and extensions', 'App roles, grants, RLS, constraints, functions and publications', 'Provider configuration and retained TOKEN_ENCRYPTION_KEY', 'No cron, Pub/Sub, notification or calendar dispatch against rehearsal'],
};
await writeFile(join(output,'preparation-report.json'), JSON.stringify(report,null,2));
console.log(JSON.stringify({output,...report}));
