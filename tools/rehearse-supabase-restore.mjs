import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Only restores a fresh destination; never edits application/provider configuration.
// Default is read-only preflight. --apply explicitly executes the rehearsal restore.
const args = process.argv.slice(2);
const option = name => { const i=args.indexOf(name); if(i<0||!args[i+1])throw new Error(`${name} is required`);return args[i+1]; };
const backup = resolve(option('--backup'));
const bin = resolve(option('--bin'));
const manifest = JSON.parse(await readFile(join(backup,'manifest.json'),'utf8'));
const ref = process.env.DESTINATION_PROJECT_REF || process.env.RESTORE_PROJECT_REF;
const host = process.env.DESTINATION_DB_HOST || process.env.host;
const user = process.env.DESTINATION_DB_USER || process.env.user;
const port = process.env.DESTINATION_DB_PORT || process.env.port || '5432';
const password = process.env.DESTINATION_DB_PASSWORD || process.env.DB_PASS;
if (!ref || [manifest.projectRef,'xvxkkqdnatnqumnlshlg'].includes(ref)) throw new Error('Forbidden destination project');
if (!password || !host || (host!==`db.${ref}.supabase.co` && !(host.endsWith('.pooler.supabase.com') && user===`postgres.${ref}`)) || port!=='5432') throw new Error('Expected destination session-pooler/direct credentials');
async function run(executable,flags,options={}) {
  return new Promise((yes,no)=>{
    const child=spawn(executable,flags,{...options,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',no);child.on('close',code=>yes({code,stdout,stderr}));
  });
}
const verifier=resolve('tools/verify-supabase-restore.mjs');
const preflight=await run(process.execPath,[verifier,'--backup',backup]);
if(preflight.code!==0)throw new Error('Destination preflight failed; no restore attempted. Run the read-only verifier for details.');
if(!args.includes('--apply')) { console.log(preflight.stdout.trim());process.exit(0); }
// Regenerate from the immutable archive, validating both archive checksums first.
const preparation=await run(process.execPath,[resolve('tools/prepare-supabase-restore.mjs'),'--backup',backup,'--bin',bin]);
if(preparation.code!==0)throw new Error('Archive preparation failed; no restore attempted');
const directory=join(backup,'restore-preparation');
const result=await run(join(bin,process.platform==='win32'?'psql.exe':'psql'),['--no-psqlrc','--single-transaction','--set','ON_ERROR_STOP=1','--file','restore.sql'],{
  cwd:directory,env:{...process.env,PGHOST:host,PGPORT:port,PGUSER:user,PGPASSWORD:password,PGDATABASE:'postgres',PGSSLMODE:'require'},
});
await writeFile(join(directory,'rehearsal-restore.log'),result.stdout+'\n'+result.stderr);
if(result.code!==0)throw new Error(`Rehearsal restore failed (${result.code}) and its transaction rolled back. Diagnostic log is in the ignored backup directory.`);
const verification=await run(process.execPath,[verifier,'--backup',backup,'--verify']);
await writeFile(join(directory,'rehearsal-verification.json'),verification.stdout);
await writeFile(join(directory,'rehearsal-verification-diagnostics.log'),verification.stderr);
console.log(JSON.stringify({destinationProjectRef:ref,restoreCompleted:true,verificationPassed:verification.code===0,productionCutover:false}));
if(verification.code!==0)process.exitCode=1;
