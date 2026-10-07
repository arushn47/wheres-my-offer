// Default: the populated-destination refresh is rehearsed and ROLLED BACK.
// --apply is a later, explicitly authorized operation, never an environment flip.
// It requires fresh paused source AND destination recovery backups, no live leases,
// an active HTTP writer fence, and an attestation about other deployment/direct writers.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve, join } from 'node:path';
import pg from 'pg';
import { readCutoverConnections, verifyProductionPause, checkLiveWriters, requireNoLiveWriters, SOURCE_REF, DESTINATION_REF } from './cutover-connections.mjs';
import { requireFinalArchive } from './cutover-archive-policy.mjs';

const args = process.argv.slice(2), apply = args.includes('--apply');
const option = name => { const i=args.indexOf(name); if(i<0 || !args[i+1]) throw new Error(`${name} is required`); return resolve(args[i+1]); };
const backup = option('--backup'), bin = option('--bin');
if (apply && !args.includes('--writers-drained')) throw new Error('Final refresh requires explicit --writers-drained attestation');
const {source,destination} = await readCutoverConnections();
const restore = parseEnv(await readFile(resolve('.env.restore.local'),'utf8'));
const childEnv = {...process.env,...restore};
// Ensure explicit destination values win even if the shell inherited other secrets.
Object.assign(childEnv,{DESTINATION_PROJECT_REF:DESTINATION_REF,DESTINATION_DB_HOST:destination.host,
 DESTINATION_DB_USER:destination.user,DESTINATION_DB_PORT:String(destination.port),DESTINATION_DB_PASSWORD:destination.password});
async function run(executable,flags,env=childEnv,cwd=process.cwd()) {
  const result = await new Promise((yes,no)=>{
    const child=spawn(executable,flags,{env,cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr=''; child.stdout.on('data',data=>{stdout+=data;}); child.stderr.on('data',data=>{stderr+=data;});
    child.once('error',no); child.once('close',code=>yes({code,stdout,stderr}));
  });
  if(result.code!==0) {
    const diagnostic=(result.stdout+'\n'+result.stderr).replaceAll(source.password,'[redacted]').replaceAll(destination.password,'[redacted]');
    await writeFile(join(backup,'cutover-last-failure.log'),diagnostic).catch(()=>{});
    throw new Error('Cutover step failed; inspect cutover-last-failure.log in the ignored backup. Keep production paused. No deployment or writer release was performed.');
  }
  return result;
}
async function verifyBackup(directory,ref) {
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')); requireFinalArchive(manifest,ref);
  for(const file of manifest.files) {
    if(!['database.dump','roles.sql'].includes(file.name)) throw new Error('Unexpected archive file');
    const hash=createHash('sha256'); for await(const data of createReadStream(join(directory,file.name))) hash.update(data);
    if(hash.digest('hex')!==file.sha256) throw new Error('Recovery archive checksum mismatch');
  }
}
async function fenceAndDrain() {
  await verifyProductionPause();
  for(const connection of [source,destination]) {
    const db=new pg.Client({...connection,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
    try { await db.connect(); await db.query('BEGIN READ ONLY'); requireNoLiveWriters(await checkLiveWriters(db)); }
    finally { await db.query('ROLLBACK').catch(()=>{}); await db.end(); }
  }
}
if(apply) {
  await verifyBackup(backup,SOURCE_REF);
  const recovery=option('--recovery-backup');
  if(recovery===backup) throw new Error('Source and destination recovery backups must be different');
  await verifyBackup(recovery,DESTINATION_REF);
  await fenceAndDrain();
}
await run(process.execPath,[resolve('tools/prepare-cutover-refresh.mjs'),'--backup',backup,'--bin',bin,'--rehearse']);
if(!apply) {
  console.log(JSON.stringify({destinationProjectRef:DESTINATION_REF,rehearsed:true,committed:false,productionChanged:false}));
  process.exit(0);
}
// Recheck immediately before executing the just-regenerated final artifact.
await verifyBackup(backup,SOURCE_REF); await fenceAndDrain();
const directory=join(backup,'restore-preparation');
const result=await run(join(bin,process.platform==='win32'?'psql.exe':'psql'),
 ['--no-psqlrc','--set','ON_ERROR_STOP=1','--file','refresh-final-review.sql'],
 {...childEnv,PGHOST:destination.host,PGPORT:String(destination.port),PGUSER:destination.user,
   PGPASSWORD:destination.password,PGDATABASE:'postgres',PGSSLMODE:'require'},directory);
await writeFile(join(directory,'final-refresh.log'),result.stdout+'\n'+result.stderr);
// On post-commit validation failure keep production paused; never auto flip back.
await run(process.execPath,[resolve('tools/verify-supabase-restore.mjs'),'--backup',backup,'--verify']);
await run(process.execPath,[resolve('tools/compare-restored-data.mjs'),'--backup',backup,'--bin',bin,'--allow-sequence-high-water']);
await run(process.execPath,[resolve('tools/verify-restored-runtime.mjs')]);
await run(process.execPath,[resolve('tools/prepare-replacement-costs.mjs')]);
const report={destinationProjectRef:DESTINATION_REF,committed:true,validated:true,sourceUnchanged:true,deploymentChanged:false,writersReleased:false};
await writeFile(join(directory,'final-refresh-result.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
