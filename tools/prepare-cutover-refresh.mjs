// Prepares a populated-destination data refresh. Default: offline SQL generation.
// --rehearse runs it ONLY on the pinned replacement, ending in ROLLBACK. There is
// deliberately no commit/apply mode. A final SQL artifact is generated for review
// only; production cutover needs separate approval and a fresh, paused snapshot.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
if (args.includes('--apply') || args.includes('--commit')) throw new Error('This tool cannot commit a refresh');
const exerciseGuard = args.includes('--exercise-content-guard');
if (exerciseGuard && !args.includes('--rehearse')) throw new Error('Content guard exercise requires --rehearse');
const option = name => { const i=args.indexOf(name); if(i<0 || !args[i+1])throw new Error(`${name} is required`);return args[i+1]; };
const backup = resolve(option('--backup')), bin = resolve(option('--bin'));
const ref = 'nvkxyeugonjevmbvxirm';
const directory = join(backup,'restore-preparation');
async function run(executable, flags, options={}) {
  return new Promise((yes,no)=>{
    const child=spawn(executable,flags,{...options,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;}); child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',no); child.once('close',code=>yes({code,stdout,stderr}));
  });
}
// Validate checksums and regenerate every input instead of trusting editable SQL.
const prepared = await run(process.execPath,[resolve('tools/prepare-supabase-restore.mjs'),'--backup',backup,'--bin',bin]);
if(prepared.code!==0)throw new Error('Archive preparation failed; no database contacted');
const manifest = JSON.parse(await readFile(join(backup,'manifest.json'),'utf8'));
if(manifest.projectRef!=='mltfzskewmpifnyleevb')throw new Error('Expected production source archive');
const tables = manifest.tableCounts.filter(table=>['public','auth','storage'].includes(table.table_schema) &&
  !['auth.schema_migrations','storage.migrations'].includes(`${table.table_schema}.${table.table_name}`));
const q = name => { if(!/^[a-z0-9_]+$/.test(name))throw new Error('Unexpected identifier');return `"${name}"`; };
const full = table => `${q(table.table_schema)}.${q(table.table_name)}`;
// Empty platform-managed tables are checked, not deleted. All original public
// tables are replaced; all nonempty managed tables are replaced. New app tables
// require explicit review, so only the derived v41 cache is allowed here.
const replaced = tables.filter(table=>table.table_schema==='public'||table.count!=='0');
const assertCounts = tables.map(table=>`IF (SELECT count(*) FROM ${full(table)}) <> ${BigInt(table.count)} THEN RAISE EXCEPTION 'Count mismatch: ${table.table_schema}.${table.table_name}'; END IF;`).join('\n');
const schemaGuard = `DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename NOT IN (${[...tables.filter(t=>t.table_schema==='public').map(t=>t.table_name),'roster_lookup_indexes'].map(name=>`'${name}'`).join(',')})) THEN
  RAISE EXCEPTION 'Unexpected public table; review schema drift before refreshing';
 END IF;
END $$;`;
let copySql = '';
const sequenceSql = [];
const copyColumns=[];
const inserts=[];
const contentChecks=[];
for(const name of ['managed-data.sql','application-data.sql']) {
  const lines=(await readFile(join(directory,name),'utf8')).split(/\r?\n/);
  let inCopy=false;
  for(const line of lines) {
    if(inCopy){copySql+=line+'\n'; if(line==='\\.')inCopy=false; continue;}
    const match=line.match(/^COPY (public|auth|storage)\.([a-z0-9_]+) \(([^)]+)\) FROM stdin;$/);
    if(match){
      const entry={schema:match[1],table:match[2],columns:match[3].split(',').map(value=>value.trim().replaceAll('"',''))};
      const staging=`archive_rows_${copyColumns.length}`;
      copyColumns.push(entry);
      const target=`${q(entry.schema)}.${q(entry.table)}`,columns=entry.columns.map(q).join(',');
      copySql+=`CREATE TEMP TABLE ${q(staging)} ON COMMIT DROP AS SELECT ${columns} FROM ${target} WITH NO DATA;\n`;
      copySql+=`COPY pg_temp.${q(staging)} (${columns}) FROM stdin;\n`;
      inserts.push(`INSERT INTO ${target} (${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM pg_temp.${q(staging)};`);
      // Compare full original row values inside the same transaction, including
      // duplicate multiplicity. New additive columns are intentionally excluded.
      // This avoids exporting roster contents over the network for validation.
      const actual=`SELECT row_to_json(r)::text FROM (SELECT ${columns} FROM ${target}) r`;
      const expected=`SELECT row_to_json(r)::text FROM (SELECT ${columns} FROM pg_temp.${q(staging)}) r`;
      contentChecks.push(`IF EXISTS ((${actual}) EXCEPT ALL (${expected})) OR EXISTS ((${expected}) EXCEPT ALL (${actual})) THEN RAISE EXCEPTION 'Full row-content mismatch: ${entry.schema}.${entry.table}'; END IF;`);
      inCopy=true;continue;
    }
    const sequence=line.match(/^SELECT pg_catalog\.setval\('([a-z0-9_]+)\.([a-z0-9_]+)', (\d+), (true|false)\);$/);
    if(sequence){
      // Supabase owns managed sequences; postgres cannot ALTER RESTART them.
      // setval is allowed but does not roll back. Never execute it in a dry run.
      if(`${sequence[1]}.${sequence[2]}`!=='auth.refresh_tokens_id_seq')throw new Error('New sequence requires finalization review');
      // Never rewind a sequence on a failure: setval is nontransactional. Preserve
      // the current high-water mark and include the imported maximum ID. Skipped
      // IDs after a failed final commit are harmless; duplicated IDs are not.
      sequenceSql.push(`SELECT pg_catalog.setval('auth.refresh_tokens_id_seq',
 GREATEST(last_value, ${sequence[3]}::bigint, COALESCE((SELECT max(id) FROM auth.refresh_tokens), ${sequence[3]}::bigint)),
 is_called OR ${sequence[4]} OR EXISTS (SELECT 1 FROM auth.refresh_tokens)) FROM auth.refresh_tokens_id_seq;`);
    }
  }
  if(inCopy)throw new Error('Truncated COPY');
}
const fkCheck = `DO $$ DECLARE fk record; bad boolean; BEGIN
 FOR fk IN
  SELECT ns.nspname AS source_schema,t.relname AS source_table,nt.nspname AS target_schema,rt.relname AS target_table,
   string_agg(format('r.%I IS NOT NULL',a.attname),' AND ' ORDER BY keys.ord) AS nonnull,
   string_agg(format('r.%I = target.%I',a.attname,ra.attname),' AND ' ORDER BY keys.ord) AS equality
  FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace
  JOIN pg_class rt ON rt.oid=c.confrelid JOIN pg_namespace nt ON nt.oid=rt.relnamespace
  CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY AS keys(src,dst,ord)
  JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=keys.src
  JOIN pg_attribute ra ON ra.attrelid=rt.oid AND ra.attnum=keys.dst
  WHERE c.contype='f' AND ns.nspname IN ('public','auth','storage')
  GROUP BY c.oid,ns.nspname,t.relname,nt.nspname,rt.relname
 LOOP
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I r WHERE %s AND NOT EXISTS(SELECT 1 FROM %I.%I target WHERE %s))',fk.source_schema,fk.source_table,fk.nonnull,fk.target_schema,fk.target_table,fk.equality) INTO bad;
  IF bad THEN RAISE EXCEPTION 'Orphaned rows in %.%',fk.source_schema,fk.source_table; END IF;
 END LOOP;
END $$;`;
const transaction = [
 '\\set ON_ERROR_STOP on','BEGIN;',"SET LOCAL statement_timeout = '120s';","SET LOCAL lock_timeout = '15s';",
 "SET LOCAL client_encoding = 'UTF8';","SET LOCAL TimeZone = 'UTC';",
 'SET LOCAL session_replication_role = replica;',schemaGuard,
 ...replaced.map(table=>`LOCK TABLE ${full(table)} IN ACCESS EXCLUSIVE MODE;`),
 'LOCK TABLE public.roster_lookup_indexes IN ACCESS EXCLUSIVE MODE;',
 'DELETE FROM public.roster_lookup_indexes;',...replaced.map(table=>`DELETE FROM ${full(table)};`),copySql,...inserts,
 'SET LOCAL session_replication_role = origin;',`DO $$ BEGIN ${assertCounts} END $$;`,
 `DO $$ BEGIN ${contentChecks.join('\n')} END $$;`,fkCheck,
].join('\n')+'\n';
const sql=transaction+"SELECT 'Refresh counts, full row contents and foreign keys verified; rolling back' AS result;\nROLLBACK;\n";
await writeFile(join(directory,'refresh-rehearsal.sql'),sql);
if (exerciseGuard) {
  const users = copyColumns.findIndex(copy=>copy.schema==='public' && copy.table==='users');
  if (users < 0) throw new Error('A populated users table is required to exercise the content guard');
  const staging=q(`archive_rows_${users}`);
  // Corrupt ONLY the temporary expected copy, after import. Target row counts
  // still pass, so the full-content comparison itself must reject the refresh.
  const tampered=sql.replace('\nSET LOCAL session_replication_role = origin;\n',
    `\nDELETE FROM pg_temp.${staging} WHERE ctid=(SELECT ctid FROM pg_temp.${staging} LIMIT 1);\nSET LOCAL session_replication_role = origin;\n`);
  await writeFile(join(directory,'refresh-rehearsal-content-guard.sql'),tampered);
}
await writeFile(join(directory,'refresh-final-review.sql'),[
 '-- REVIEW ONLY. This file commits. Never execute without separately authorized cutover.',
 '-- Use only the pinned Mumbai replacement with all writers paused and a freshly verified archive.',
 '-- Take destination recovery backup first. Recheck schema drift and production writer drain.',
 transaction,...sequenceSql,"NOTIFY pgrst, 'reload schema';",'COMMIT;',
].join('\n')+'\n');
await writeFile(join(directory,'refresh-sequences-review.sql'),[
 '-- REVIEW ONLY. Not executed by this tool. setval does not roll back.',
 '-- Final cutover must capture prior values and adjust sequences under the writer pause.',
 ...sequenceSql,
].join('\n')+'\n');
if(!args.includes('--rehearse')){
 console.log(JSON.stringify({prepared:true,sourceProjectRef:manifest.projectRef,destinationProjectRef:ref,tables:tables.length,fullContentComparisons:contentChecks.length,sequencesRequireCutoverReview:sequenceSql.length,finalReviewArtifactPrepared:true,commits:false,productionChanged:false}));
 process.exit(0);
}
const suppliedRef=process.env.DESTINATION_PROJECT_REF||process.env.RESTORE_PROJECT_REF;
const host=process.env.DESTINATION_DB_HOST||process.env.host,user=process.env.DESTINATION_DB_USER||process.env.user;
const password=process.env.DESTINATION_DB_PASSWORD||process.env.DB_PASS;
const port=Number(process.env.DESTINATION_DB_PORT||process.env.port||5432);
if(suppliedRef!==ref||port!==5432||!password||!(host===`db.${ref}.supabase.co`||host?.endsWith('.pooler.supabase.com')&&user===`postgres.${ref}`))throw new Error('Only the verified Mumbai rehearsal is allowed');
const db=new pg.Client({host,user,password,port,database:'postgres',ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
try {
 await db.connect(); await db.query('BEGIN READ ONLY');
 // Refuse missing columns, unexpected required columns, and non-unit sequences.
 for(const copy of copyColumns){
  const actual=(await db.query('SELECT column_name,column_default,is_nullable,is_identity,is_generated FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',[copy.schema,copy.table])).rows;
  for(const column of copy.columns)if(!actual.some(row=>row.column_name===column))throw new Error('Archived column is missing on destination');
  if(actual.some(row=>!copy.columns.includes(row.column_name)&&row.is_nullable==='NO'&&row.column_default===null&&row.is_identity!=='YES'&&row.is_generated==='NEVER'))throw new Error('New required column has no default');
 }
 const sequences=(await db.query("SELECT increment_by FROM pg_sequences WHERE schemaname IN ('public','auth','storage')")).rows;
 if(sequences.some(sequence=>String(sequence.increment_by)!=='1'))throw new Error('Non-unit sequence needs explicit review');
 await db.query('ROLLBACK');
 const result=await run(join(bin,process.platform==='win32'?'psql.exe':'psql'),['--no-psqlrc','--set','ON_ERROR_STOP=1','--file',exerciseGuard?'refresh-rehearsal-content-guard.sql':'refresh-rehearsal.sql'],
  {cwd:directory,env:{...process.env,PGHOST:host,PGPORT:String(port),PGUSER:user,PGPASSWORD:password,PGDATABASE:'postgres',PGSSLMODE:'require'}});
 await writeFile(join(directory,'refresh-rehearsal.log'),result.stdout+'\n'+result.stderr);
 if(exerciseGuard ? result.code===0 || !result.stderr.includes('Full row-content mismatch: public.users') : result.code!==0)throw new Error('Refresh rehearsal failed unexpectedly and disconnected without commit; inspect ignored diagnostic log');
 console.log(JSON.stringify({rehearsed:true,destinationProjectRef:ref,tables:tables.length,fullContentComparisons:contentChecks.length,contentGuardRejectedCorruption:exerciseGuard,sequencesChanged:false,sequencesRequireCutoverReview:sequenceSql.length,finalReviewArtifactPrepared:true,committed:false,productionChanged:false}));
}finally{await db.query('ROLLBACK').catch(()=>{});await db.end();}
