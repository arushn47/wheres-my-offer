// Builds an isolated copy and performs authenticated HTTP reads. No deployments,
// production secrets, OAuth calls, worker dispatch or database mutations.
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import pg from 'pg';
import { SignJWT } from 'jose';

const root = process.cwd();
const ref = process.env.DESTINATION_PROJECT_REF || process.env.RESTORE_PROJECT_REF;
const url = process.env.DESTINATION_SUPABASE_URL || process.env.RESTORE_SUPABASE_URL;
const service = process.env.DESTINATION_SUPABASE_SERVICE_ROLE_KEY || process.env.RESTORE_SUPABASE_SERVICE_ROLE_KEY;
const anon = process.env.DESTINATION_SUPABASE_ANON_KEY || process.env.RESTORE_SUPABASE_ANON_KEY;
const host = process.env.DESTINATION_DB_HOST || process.env.host;
const user = process.env.DESTINATION_DB_USER || process.env.user;
if (ref !== 'nvkxyeugonjevmbvxirm' || new URL(url).hostname !== `${ref}.supabase.co` ||
    !service || !anon || !(host === `db.${ref}.supabase.co` || host?.endsWith('.pooler.supabase.com') && user === `postgres.${ref}`)) {
  throw new Error('Verified Mumbai destination credentials are required');
}
await mkdir(join(root, 'scratch'), { recursive: true });
const workspace = await mkdtemp(join(root, 'scratch', 'restored-preview-'));
const checks = [];
const assert = (ok, name) => { checks.push({ name, passed: Boolean(ok) }); if (!ok) throw new Error(name); };
const db = new pg.Client({host,user,password:process.env.DESTINATION_DB_PASSWORD || process.env.DB_PASS,
  port:Number(process.env.DESTINATION_DB_PORT || process.env.port || 5432),database:'postgres',ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
let server;
const key = randomBytes(32).toString('hex'); // Synthetic sessions are invalid in production.
const env = {};
for (const name of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','COMSPEC','PATHEXT','USERPROFILE','APPDATA','LOCALAPPDATA','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE']) {
  if (process.env[name]) env[name] = process.env[name];
}
Object.assign(env, { NODE_ENV:'production', NEXT_TELEMETRY_DISABLED:'1', NEXT_PUBLIC_SUPABASE_URL:url,
  NEXT_PUBLIC_SUPABASE_ANON_KEY:anon, SUPABASE_SERVICE_ROLE_KEY:service, TOKEN_ENCRYPTION_KEY:key,
  ROSTER_LOOKUP_ENABLED:'true', COMPACT_SYNC_PROGRESS_ENABLED:'true', COMPACT_DASHBOARD_READS_ENABLED:'true', SHARED_COLLEGE_SYNC_ENABLED:'false' });
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes:true })) {
    const path = join(directory,entry.name);
    if (entry.isDirectory()) result.push(...await files(path)); else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
async function sourceHash() {
  const hash = createHash('sha256');
  for (const path of await files(join(root,'src'))) { hash.update(relative(root,path)); hash.update(await readFile(path)); }
  return hash.digest('hex');
}
async function fingerprint() {
  // Application rows, including cached membership revisions, must remain unchanged.
  const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const hash = createHash('sha256');
  for (const {tablename} of tables) {
    if (!/^[a-z0-9_]+$/.test(tablename)) throw new Error('Unexpected table identifier');
    const {rows} = await db.query(`SELECT md5(row_to_json(t)::text) AS hash FROM public."${tablename}" t ORDER BY 1`);
    hash.update(tablename); for (const row of rows) hash.update(row.hash);
  }
  return hash.digest('hex');
}
async function startChild(args, childEnv, logName) {
  const child = spawn(process.execPath,args,{cwd:workspace,env:childEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const log = createWriteStream(join(workspace,logName));
  child.stdout.pipe(log); child.stderr.pipe(log);
  child.once('error', () => log.end()); child.once('exit', () => log.end());
  return child;
}
try {
  const beforeSource = await sourceHash();
  for (const name of ['src','public','package.json','package-lock.json','next.config.ts','tsconfig.json','postcss.config.mjs','next-env.d.ts']) {
    await cp(join(root,name),join(workspace,name),{recursive:true,filter:path=>!path.endsWith('.test.ts')});
  }
  await symlink(join(root,'node_modules'),join(workspace,'node_modules'),'junction');
  await db.connect(); await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const beforeData = await fingerprint();
  const identities = (await db.query('SELECT id,email,name FROM public.users ORDER BY id')).rows;
  assert(identities.length >= 2,'Restored identities available');
  const drives = (await db.query(`SELECT a.user_id,d.id,d.company_id,c.name,a.status FROM public.applications a
    JOIN public.placement_drives d ON d.id=a.placement_drive_id JOIN public.companies c ON c.id=d.company_id
    ORDER BY CASE WHEN c.name ILIKE '%axxela%' THEN 0 WHEN c.name ILIKE '%ubs%' THEN 1 WHEN c.name ILIKE '%myntra%' THEN 2 ELSE 3 END,a.user_id`)).rows;
  await db.query('ROLLBACK');
  // No .env files are copied. Every public database value is set at build time.
  const build = await startChild([join(root,'node_modules/next/dist/bin/next'),'build','--webpack'],env,'build.log');
  const buildCode = await new Promise((resolve,reject) => { build.once('exit',resolve); build.once('error',reject); });
  assert(buildCode === 0,'Isolated production build');
  for (const path of await files(join(workspace,'.next','static'))) {
    if (!path.endsWith('.js')) continue;
    const content = await readFile(path,'utf8');
    assert(!content.includes(service) && !content.includes('mltfzskewmpifnyleevb.supabase.co'), 'Browser bundle contains neither service key nor source URL');
  }
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0,'127.0.0.1',resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const audit = join(workspace,'outbound-audit.jsonl'); await writeFile(audit,'');
  const guardedEnv = {...env,PREVIEW_DESTINATION_URL:url,PREVIEW_AUDIT_FILE:audit,NEXT_PUBLIC_APP_URL:origin};
  const serverArgs=['--import',pathToFileURL(join(root,'tools/preview-readonly-guard.mjs')).href,join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)];
  server = await startChild(serverArgs,guardedEnv,'runtime.log');
  server.on('error',()=>{});
  let ready = false;
  for (let attempt=0;attempt<60;attempt++) {
    if (server.exitCode !== null) break;
    try { const response = await fetch(`${origin}/login`,{signal:AbortSignal.timeout(1000)}); if(response.status===200){ready=true;break;} } catch {}
    await new Promise(resolve => setTimeout(resolve,500));
  }
  assert(ready,'Isolated server starts');
  const anonymous = await fetch(`${origin}/companies`,{redirect:'manual'});
  assert(anonymous.status===307 && anonymous.headers.get('location')?.includes('/login'),'Unauthenticated page redirects to login');
  const unauthorized = await fetch(`${origin}/api/sync/status`,{redirect:'manual'});
  assert([307,401].includes(unauthorized.status),'Unauthenticated progress rejected');
  async function request(path, identity) {
    const session = await new SignJWT({userId:identity.id,email:identity.email,name:identity.name})
      .setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(key));
    const response = await fetch(`${origin}${path}`,{headers:{cookie:`session=${session}`},redirect:'manual',signal:AbortSignal.timeout(60000)});
    const content = await response.text();
    assert(response.status===200,`Authenticated ${path.split('?')[0]} responds for restored user`);
    assert(!content.includes('mltfzskewmpifnyleevb.supabase.co') && !content.includes(service),'Response excludes source URL and service key');
    return content;
  }
  for (const identity of identities) {
    const content = await request('/companies',identity);
    assert(content.includes('Placement Drives'),'Company list renders');
    for (const path of ['/','/analytics','/search']) await request(path,identity);
    const ownDrives = drives.filter(drive=>drive.user_id===identity.id);
    const onlyOther = drives.find(drive=>drive.user_id!==identity.id && !ownDrives.some(own=>own.id===drive.id));
    // These serialized personal application rows must not leak another user's status.
    if (onlyOther) assert(!content.includes(`\\"id\\":\\"${onlyOther.id}\\"`),'Company list excludes an unowned drive');
    const selected = [...new Map(ownDrives.filter(drive=>/axxela|ubs|myntra/i.test(drive.name)).map(drive=>[drive.company_id,drive])).values()];
    for (const drive of selected) {
      const detail = await request(`/companies/${drive.company_id}?driveId=${drive.id}`,identity);
      assert(detail.includes('Recruitment Stage') || detail.includes('RECRUITMENT STAGE'),'Company detail pipeline renders');
    }
    for (const path of ['/api/sync/status','/api/sync/shared-status','/api/notifications']) JSON.parse(await request(path,identity));
  }
  server.kill(); await new Promise(resolve=>server.once('exit',resolve));
  server=await startChild(serverArgs,{...guardedEnv,COMPACT_DASHBOARD_READS_ENABLED:'false'},'fallback-runtime.log');
  let fallbackReady=false;
  for(let attempt=0;attempt<60;attempt++) {
    if(server.exitCode!==null)break;
    try{const response=await fetch(`${origin}/login`,{signal:AbortSignal.timeout(1000)});if(response.status===200){fallbackReady=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert(fallbackReady,'Canonical fallback server starts without compact dashboard readers');
  for(const path of ['/companies','/search','/','/analytics']) await request(path,identities[0]);
  server.kill(); await new Promise(resolve=>server.once('exit',resolve));
  server=await startChild(serverArgs,{...guardedEnv,DATABASE_WRITES_PAUSED:'true'},'paused-runtime.log');
  let pausedReady=false;
  for(let attempt=0;attempt<60;attempt++) {
    if(server.exitCode!==null)break;
    try{const response=await fetch(`${origin}/login`,{signal:AbortSignal.timeout(1000)});if(response.status===200){pausedReady=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert(pausedReady,'Read-only maintenance server starts');
  for(const [path,method] of [['/api/webhooks/gmail','POST'],['/api/cron/sync','GET'],['/api/auth/callback','GET'],['/companies','POST'],['/api/notifications','DELETE']]){
    const response=await fetch(`${origin}${path}`,{method,redirect:'manual'});
    assert(response.status===503 && response.headers.get('retry-after')==='60',`Writer pause fences ${method} ${path} before dispatch`);
  }
  await request('/companies',identities[0]);
  JSON.parse(await request('/api/sync/status',identities[0]));
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert(await fingerprint()===beforeData,'All public database rows unchanged by preview');
  await db.query('ROLLBACK');
  assert(await sourceHash()===beforeSource,'Original application source unchanged');
  const operations = (await readFile(audit,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert(operations.every(operation=>operation.allowed),'All runtime outbound requests were permitted reads');
  assert(operations.some(operation=>operation.operation==='/rest/v1/rpc/get_shared_college_progress'),'Compact shared progress RPC exercised');
  await writeFile(join(workspace,'verification.json'),JSON.stringify({projectRef:ref,identities:identities.length,checks,
    outboundReadCount:operations.length,syntheticSessions:true,realOAuthTested:false,productionChanged:false,sourceHash:beforeSource},null,2));
  console.log(JSON.stringify({passed:true,projectRef:ref,identities:identities.length,checks:checks.length,outboundReads:operations.length,
    productionChanged:false,report:relative(root,join(workspace,'verification.json'))},null,2));
} catch(error) {
  await writeFile(join(workspace,'verification.json'),JSON.stringify({passed:false,checks,error:error.message,productionChanged:false},null,2));
  console.error(JSON.stringify({passed:false,error:error.message,workspace:relative(root,workspace)})); process.exitCode=1;
} finally {
  if(server && server.exitCode===null) { server.kill(); await new Promise(resolve=>server.once('exit',resolve)); }
  await db.query('ROLLBACK').catch(()=>{}); await db.end().catch(()=>{});
}
