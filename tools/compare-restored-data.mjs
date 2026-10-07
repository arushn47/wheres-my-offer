import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { sequenceMatches } from './cutover-archive-policy.mjs';

// Read-only destination dump; compares COPY row multisets without logging row data.
const args=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw new Error(`${name} is required`);return args[i+1];};
const backup=resolve(option('--backup')),bin=resolve(option('--bin'));
const manifest=JSON.parse(await readFile(join(backup,'manifest.json'),'utf8'));
const ref=process.env.DESTINATION_PROJECT_REF||process.env.RESTORE_PROJECT_REF;
const host=process.env.DESTINATION_DB_HOST||process.env.host,user=process.env.DESTINATION_DB_USER||process.env.user;
const password=process.env.DESTINATION_DB_PASSWORD||process.env.DB_PASS;
if(!ref||[manifest.projectRef,'xvxkkqdnatnqumnlshlg'].includes(ref)||!host||!password||host!==`db.${ref}.supabase.co`&&!(host.endsWith('.pooler.supabase.com')&&user===`postgres.${ref}`))throw new Error('Expected isolated destination credentials');
const directory=join(backup,'restore-preparation');
const destinationFile=join(directory,'destination-data-comparison.sql');
await new Promise((yes,no)=>{
  const child=spawn(join(bin,process.platform==='win32'?'pg_dump.exe':'pg_dump'),['--data-only','--no-owner','--schema=public','--schema=auth','--schema=storage','--exclude-table=auth.schema_migrations','--exclude-table=storage.migrations','--file',destinationFile],{env:{...process.env,PGHOST:host,PGPORT:process.env.DESTINATION_DB_PORT||process.env.port||'5432',PGUSER:user,PGPASSWORD:password,PGDATABASE:'postgres',PGSSLMODE:'require'},windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});child.on('error',no);child.on('close',code=>code===0?yes():no(new Error(`Read-only destination dump failed (${code}): ${stderr.replaceAll(password,'[redacted]')}`)));
});
function parse(sql) {
  const tables=new Map(),sequences=new Map();let current=null;
  for(const line of sql.replaceAll('\r\n','\n').split('\n')) {
    if(current){if(line==='\\.')current=null;else current.rows.push(line);continue;}
    const table=line.match(/^COPY (public|auth|storage)\.([a-z0-9_]+) \(([^)]+)\) FROM stdin;$/);
    if(table){current={columns:table[3],rows:[]};tables.set(`${table[1]}.${table[2]}`,current);}
    const sequence=line.match(/^SELECT pg_catalog\.setval\('([^']+)', (\d+), (true|false)\);$/);
    if(sequence)sequences.set(sequence[1],`${sequence[2]}:${sequence[3]}`);
  }
  if(current)throw new Error('Truncated COPY data');
  return {tables,sequences};
}
const source=parse((await readFile(join(directory,'application-data.sql'),'utf8'))+'\n'+await readFile(join(directory,'managed-data.sql'),'utf8'));
const destination=parse(await readFile(destinationFile,'utf8'));
const hash=rows=>createHash('sha256').update([...rows].sort().join('\n')).digest('hex');
const mismatches=[];
const expected=manifest.tableCounts.filter(table=>['public','auth','storage'].includes(table.table_schema)&&!['auth.schema_migrations','storage.migrations'].includes(`${table.table_schema}.${table.table_name}`));
for(const table of expected){
  const name=`${table.table_schema}.${table.table_name}`,a=source.tables.get(name),b=destination.tables.get(name);
  if(!b || b.rows.length!==Number(table.count)){mismatches.push(name);continue;}
  if(a){
    // Additive optimizations introduce columns. Compare every archived column,
    // preserving the exact COPY bytes rather than reserializing JSON or dates.
    const originalColumns=a.columns.split(',').map(column=>column.trim());
    const restoredColumns=b.columns.split(',').map(column=>column.trim());
    const positions=originalColumns.map(column=>restoredColumns.indexOf(column));
    if(positions.some(position=>position<0)){mismatches.push(name);continue;}
    const projected=b.rows.map(row=>{const values=row.split('\t');return positions.map(position=>values[position]).join('\t');});
    if(hash(a.rows)!==hash(projected))mismatches.push(name);
  }
}
for(const [sequence,value] of source.sequences)if(!sequenceMatches(value,destination.sequences.get(sequence),args.includes('--allow-sequence-high-water')))mismatches.push(`sequence:${sequence}`);
const report={destinationProjectRef:ref,tableCount:expected.length,sequenceCount:source.sequences.size,sequenceHighWaterAllowed:args.includes('--allow-sequence-high-water'),allRowContentHashesMatch:mismatches.length===0,mismatches,readOnly:true,productionCutover:false};
await writeFile(join(directory,'row-content-verification.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));if(mismatches.length)process.exitCode=1;
