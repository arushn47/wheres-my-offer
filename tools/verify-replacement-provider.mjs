// Read-only Supabase Management API review. Never uses Vercel credentials.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import pg from 'pg';
import { spawn } from 'node:child_process';

const args=process.argv.slice(2),index=args.indexOf('--backup');
if(index<0||!args[index+1])throw new Error('--backup is required');
const backup=resolve(args[index+1]);
const binIndex=args.indexOf('--bin');
if(binIndex<0||!args[binIndex+1])throw new Error('--bin is required');
const bin=resolve(args[binIndex+1]);
const ref=process.env.DESTINATION_PROJECT_REF||process.env.RESTORE_PROJECT_REF;
const token=process.env.WMO_RESTORE_TOKEN;
if(ref!=='nvkxyeugonjevmbvxirm'||!token)throw new Error('Verified replacement and scoped Supabase token required');
async function get(path){
 const response=await fetch(`https://api.supabase.com/v1/projects/${ref}${path}`,{headers:{Authorization:`Bearer ${token}`}});
 if(!response.ok)throw new Error(`Management GET failed: HTTP ${response.status}`);
 return response.json();
}
const output=join(backup,'restore-preparation','replacement-provider');
await mkdir(output,{recursive:true});
const project=await get('');
if(project.region!=='ap-south-1'||project.status!=='ACTIVE_HEALTHY')throw new Error('Expected healthy Mumbai project');
const config=[];
for(const name of ['auth','storage','realtime']){
 const source=JSON.parse(await readFile(join(backup,`provider-config-${name}.json`),'utf8'));
 const destination=await get(`/config/${name}`);
 await writeFile(join(output,`${name}.json`),JSON.stringify(destination,null,2));
 const differs=Object.keys(source).filter(key=>JSON.stringify(source[key])!==JSON.stringify(destination[key]));
 config.push({service:name,changedFields:differs}); // Values can contain secrets: never print them.
}
const functions=await get('/functions');
const sourceSchema=await new Promise((yes,no)=>{
 const child=spawn(join(bin,process.platform==='win32'?'pg_restore.exe':'pg_restore'),['--schema-only','--no-owner','--file=-',join(backup,'database.dump')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let sql='';child.stdout.on('data',chunk=>{sql+=chunk;});child.stderr.resume();
 child.once('error',no);child.once('close',code=>code===0?yes(sql):no(new Error('Source publication review failed')));
});
const sourceApplicationPublicationTables=[...sourceSchema.matchAll(/ALTER PUBLICATION ([a-z0-9_]+) ADD TABLE (?:ONLY )?public\.([a-z0-9_]+);/g)]
 .map(match=>({pubname:match[1],tablename:match[2]})).sort((a,b)=>`${a.pubname}.${a.tablename}`.localeCompare(`${b.pubname}.${b.tablename}`));
const host=process.env.DESTINATION_DB_HOST||process.env.host,user=process.env.DESTINATION_DB_USER||process.env.user;
if(!(host===`db.${ref}.supabase.co`||host?.endsWith('.pooler.supabase.com')&&user===`postgres.${ref}`))throw new Error('Destination DB mismatch');
const db=new pg.Client({host,user,password:process.env.DESTINATION_DB_PASSWORD||process.env.DB_PASS,port:5432,database:'postgres',ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
let applicationPublicationTables=[];
try{
 await db.connect(); await db.query('BEGIN READ ONLY');
 applicationPublicationTables=(await db.query("SELECT pubname,tablename FROM pg_publication_tables WHERE schemaname='public' ORDER BY pubname,tablename")).rows;
 await db.query('ROLLBACK');
}finally{await db.end();}
const report={projectRef:ref,region:project.region,healthy:true,config,edgeFunctions:Array.isArray(functions)?functions.length:null,
 applicationPublicationTables,sourceApplicationPublicationTables,publicationTablesMatch:JSON.stringify(applicationPublicationTables)===JSON.stringify(sourceApplicationPublicationTables),readOnly:true,productionChanged:false};
await writeFile(join(output,'review.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
