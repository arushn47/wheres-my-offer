import pg from 'pg';
import { createDecipheriv } from 'node:crypto';
import { loadEnvFile } from 'node:process';

// Read-only checks. No Gmail calls, watch renewal, delivery or queue dispatch.
loadEnvFile('.env.local');
const ref=process.env.DESTINATION_PROJECT_REF||process.env.RESTORE_PROJECT_REF;
const host=process.env.DESTINATION_DB_HOST||process.env.host,user=process.env.DESTINATION_DB_USER||process.env.user;
const password=process.env.DESTINATION_DB_PASSWORD||process.env.DB_PASS;
if(!ref||['mltfzskewmpifnyleevb','xvxkkqdnatnqumnlshlg','ocafpqeocxvlmhlyijaw'].includes(ref)||!host||!password||
  host!==`db.${ref}.supabase.co`&&!(host.endsWith('.pooler.supabase.com')&&user===`postgres.${ref}`))throw Error('Expected isolated replacement connection');
const url=process.env.DESTINATION_SUPABASE_URL||process.env.RESTORE_SUPABASE_URL;
if(new URL(url).hostname!==`${ref}.supabase.co`)throw Error('Destination API URL mismatch');
const db=new pg.Client({host,user,password,port:5432,database:'postgres',ssl:{rejectUnauthorized:false}});
const failures=[];
let decryptedFields=0,isolationChecks=0;
try{
 await db.connect();
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const users=(await db.query('SELECT id FROM public.users ORDER BY id LIMIT 2')).rows;
 if(users.length!==2)throw Error('Two restored identities are required for isolation checks');
 for(const user of users){
   await db.query('SET LOCAL ROLE authenticated');
   await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)",[JSON.stringify({sub:user.id,role:'authenticated'}),user.id]);
   for(const table of ['users','applications','gmail_accounts','notifications','personal_emails','events']){
     const column=table==='users'?'id':'user_id';
     const count=(await db.query(`SELECT count(*)::int AS count FROM public.${table} WHERE ${column}<>$1`,[user.id])).rows[0].count;
     if(count!==0)failures.push(`Isolation failed for ${table}`);
     isolationChecks++;
   }
   await db.query('RESET ROLE');
 }
 const key=Buffer.from(process.env.TOKEN_ENCRYPTION_KEY||'','hex');
 if(key.length!==32)throw Error('Retained application encryption key is missing or invalid');
 const accounts=(await db.query('SELECT access_token_encrypted,refresh_token_encrypted FROM public.gmail_accounts')).rows;
 for(const account of accounts)for(const field of ['access_token_encrypted','refresh_token_encrypted']){
   if(!account[field])continue;
   const value=Buffer.from(account[field],'base64');
   const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,16));cipher.setAuthTag(value.subarray(16,32));
   const plaintext=Buffer.concat([cipher.update(value.subarray(32)),cipher.final()]);
   if(!plaintext.length)failures.push('Empty decrypted Gmail token');
   plaintext.fill(0);decryptedFields++;
 }
 const expected=(await db.query('SELECT count(*)::int AS count FROM public.applications')).rows[0].count;
 await db.query('ROLLBACK');
 const service=process.env.DESTINATION_SUPABASE_SERVICE_ROLE_KEY||process.env.RESTORE_SUPABASE_SERVICE_ROLE_KEY;
 const anon=process.env.DESTINATION_SUPABASE_ANON_KEY||process.env.RESTORE_SUPABASE_ANON_KEY;
 async function count(table,key){
   const response=await fetch(`${url}/rest/v1/${table}?select=id`,{method:'HEAD',headers:{apikey:key,Authorization:`Bearer ${key}`,Prefer:'count=exact'}});
   if(!response.ok)throw Error(`Destination ${table} HEAD failed: HTTP ${response.status}`);
   return Number(response.headers.get('content-range')?.split('/')[1]);
 }
 const serviceCount=await count('applications',service),anonymousPrivateCount=await count('gmail_accounts',anon);
 if(serviceCount!==expected)failures.push('Service API count mismatch');
 if(anonymousPrivateCount!==0)failures.push('Anonymous private account access');
 console.log(JSON.stringify({projectRef:ref,isolationChecks,decryptedTokenFields:decryptedFields,serviceApplications:serviceCount,anonymousPrivateAccounts:anonymousPrivateCount,passed:failures.length===0,failures,productionChanged:false},null,2));
 if(failures.length)process.exitCode=1;
}finally{await db.query('ROLLBACK').catch(()=>{});await db.end();}
