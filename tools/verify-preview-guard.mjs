import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import https from 'node:https';

const directory=await mkdtemp(resolve('scratch','preview-guard-check-'));
process.env.PREVIEW_DESTINATION_URL='https://nvkxyeugonjevmbvxirm.supabase.co';
process.env.PREVIEW_AUDIT_FILE=join(directory,'audit.jsonl');
let delivered=0;
globalThis.fetch=async()=>{delivered++;return new Response('{}');};
await import(pathToFileURL(resolve('tools/preview-readonly-guard.mjs')).href);
for(const [url,method] of [
 ['https://mltfzskewmpifnyleevb.supabase.co/rest/v1/users','GET'],
 ['https://oauth2.googleapis.com/token','POST'],
 ['https://nvkxyeugonjevmbvxirm.supabase.co/rest/v1/users','POST'],
 ['https://nvkxyeugonjevmbvxirm.supabase.co/rest/v1/users','PATCH'],
 ['https://nvkxyeugonjevmbvxirm.supabase.co/rest/v1/users','DELETE'],
 ['https://nvkxyeugonjevmbvxirm.supabase.co/rest/v1/rpc/publish_roster_lookup_index','POST'],
 ['https://nvkxyeugonjevmbvxirm.supabase.co/auth/v1/token','POST'],
]) assert.throws(()=>fetch(url,{method}),/blocked/);
assert.throws(()=>https.request('https://gmail.googleapis.com/gmail/v1/users/me'),/blocked/);
assert.equal(delivered,0);
await fetch(`${process.env.PREVIEW_DESTINATION_URL}/rest/v1/users`);
await fetch(`${process.env.PREVIEW_DESTINATION_URL}/rest/v1/rpc/get_shared_college_progress`,{method:'POST'});
assert.equal(delivered,2);
const audit=(await readFile(process.env.PREVIEW_AUDIT_FILE,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
assert.equal(audit.filter(row=>!row.allowed).length,8);
assert(audit.every(row=>!JSON.stringify(row).includes('googleapis')));
// No recursive deletion; only this check's two known files/directory.
await rm(process.env.PREVIEW_AUDIT_FILE); await rmdir(directory);
console.log(JSON.stringify({passed:true,blockedRequests:8,permittedReads:2,networkRequests:0}));
