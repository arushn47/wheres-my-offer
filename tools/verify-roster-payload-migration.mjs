import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { readDestinationConnection } from './cutover-connections.mjs';

// Default: exercise fixtures and the real cache inside rolled-back transactions.
// --apply additionally commits the checked migration and reclaims its old TOAST.
const apply = process.argv.includes('--apply');
const sql = await readFile('supabase/migrations/migration_v49_deduplicate_roster_payloads.sql','utf8');
const body = sql.replace(/^BEGIN;/m,'').replace(/^COMMIT;/m,'');
const old = await readFile('supabase/migrations/migration_v41_roster_lookup.sql','utf8');
const client = new pg.Client({...await readDestinationConnection(),ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await client.connect();
try {
 await client.query("SET statement_timeout='90s'");
 await client.query('BEGIN');
 await client.query(`
 CREATE TEMP TABLE sync_state(is_syncing boolean,lease_expires_at timestamptz,updated_at timestamptz);
 CREATE TEMP TABLE shared_college_sync_state(is_syncing boolean,lease_expires_at timestamptz);
 CREATE TEMP TABLE gmail_pubsub_inbox(status text,locked_until timestamptz);
 CREATE TEMP TABLE college_archive_refresh_lease(locked_until timestamptz);
 CREATE TEMP TABLE college_attachments(id uuid PRIMARY KEY,roster_revision bigint,college_email_id uuid,filename text,size_bytes bigint,content_hash text,parse_status text);
 CREATE TEMP TABLE college_sheet_snapshots(content_hash text PRIMARY KEY,roster_revision bigint);
 CREATE TEMP TABLE college_sheet_sources(content_hash text,college_email_id uuid,parse_status text);
 CREATE TEMP TABLE roster_lookup_indexes(source_kind text,source_key text,source_revision bigint,policy_version integer,usable boolean,legacy_roster_hash text,token_locations jsonb,PRIMARY KEY(source_kind,source_key));
 INSERT INTO college_attachments SELECT ('00000000-0000-0000-0000-00000000000'||n)::uuid,1,'10000000-0000-0000-0000-000000000000','roster.csv',100,'content-'||n,'complete' FROM generate_series(1,3) n;
 INSERT INTO college_sheet_snapshots VALUES('sheet-content',1);
 INSERT INTO college_sheet_sources VALUES('sheet-content','10000000-0000-0000-0000-000000000000','complete');
 `);
 for(const name of ['publish_roster_lookup','lookup_candidate_rosters']) {
  const start=old.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end=old.indexOf('$$;',start)+3;
  await client.query(old.slice(start,end).replaceAll('public.','pg_temp.'));
 }
 const payload={later:{sheetIndex:1,rowNumber:4},earlier:{sheetIndex:0,rowNumber:2}};
 const publish=(key,revision=1,locations=payload)=>client.query('SELECT pg_temp.publish_roster_lookup($1,$2,$3,1,true,$4,$5) ok',['attachment',key,revision,'legacy',locations]);
 for(const n of [1,2]) assert.equal((await publish(`00000000-0000-0000-0000-00000000000${n}`)).rows[0].ok,true);
 await client.query("SELECT pg_temp.publish_roster_lookup('sheet','sheet-content',1,1,true,'legacy',$1)",[payload]);
 await client.query("INSERT INTO pg_temp.roster_lookup_indexes VALUES('attachment','00000000-0000-0000-0000-000000000003',0,1,true,'stale',$1)",[payload]);
 const lookup=(policy=1)=>client.query("SELECT * FROM pg_temp.lookup_candidate_rosters(ARRAY['10000000-0000-0000-0000-000000000000']::uuid[],ARRAY['later','missing','earlier'],$1) ORDER BY source_kind,source_key",[policy]);
 const expected=(await lookup()).rows;
 const fixtureSql=body.replaceAll('public.','pg_temp.').replace("table_schema='public'","table_schema LIKE 'pg_temp_%'");
 await client.query("INSERT INTO pg_temp.sync_state VALUES(true,now()+interval '1 minute',now()); SAVEPOINT busy_sync");
 await assert.rejects(client.query(fixtureSql),/Active sync/);
 await client.query('ROLLBACK TO SAVEPOINT busy_sync; DELETE FROM pg_temp.sync_state');
 await client.query(fixtureSql);
 assert.deepEqual((await lookup()).rows,expected);
 assert.equal((await client.query('SELECT count(*)::int n FROM pg_temp.roster_lookup_payloads')).rows[0].n,1);
 assert.ok((await lookup(2)).rows.every(row=>row.index_ready===false&&row.match_location===null));
 assert.equal((await publish('00000000-0000-0000-0000-000000000001',0)).rows[0].ok,false);
 const tuple=await client.query('SELECT ctid::text FROM pg_temp.roster_lookup_indexes ORDER BY source_kind,source_key');
 await publish('00000000-0000-0000-0000-000000000001');
 assert.deepEqual((await client.query('SELECT ctid::text FROM pg_temp.roster_lookup_indexes ORDER BY source_kind,source_key')).rows,tuple.rows);
 await publish('00000000-0000-0000-0000-000000000001',1,{replacement:{sheetIndex:0,rowNumber:8}});
 assert.equal((await client.query('SELECT pg_temp.prune_roster_lookup_payloads(100) n')).rows[0].n,0);
 await publish('00000000-0000-0000-0000-000000000001');
 assert.equal((await client.query('SELECT pg_temp.prune_roster_lookup_payloads(0) n')).rows[0].n,0);
 assert.equal((await client.query('SELECT pg_temp.prune_roster_lookup_payloads(100) n')).rows[0].n,1);
 await client.query(fixtureSql); // Rerunning a committed migration is harmless.
 assert.deepEqual((await lookup()).rows,expected);
 await client.query('ROLLBACK');
 console.log('Fixtures passed: matching, stale revisions/policies, deduplication, unchanged publications, bounded cleanup and idempotence.');

 await client.query('BEGIN');
 // All comparisons stay in PostgreSQL: no roster payload is downloaded.
 // Fence new sync claims before capturing the expected metadata.
 await client.query(body.slice(0,body.indexOf('CREATE TABLE')));
 const legacy=(await client.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='roster_lookup_indexes' AND column_name='token_locations') legacy")).rows[0].legacy;
 await client.query(`CREATE TEMP TABLE expected_roster_metadata ON COMMIT DROP AS
  SELECT source_kind,source_key,source_revision,policy_version,usable,legacy_roster_hash,
   ${legacy?"encode(sha256(convert_to(token_locations::text,'UTF8')),'hex')":"payload_hash"} payload_hash FROM public.roster_lookup_indexes`);
 const before=(await client.query(`SELECT pg_database_size(current_database())::text database_bytes,
  (pg_total_relation_size('public.roster_lookup_indexes')+coalesce(pg_total_relation_size(to_regclass('public.roster_lookup_payloads')),0))::text cache_bytes,
  (SELECT count(*)::int FROM public.roster_lookup_indexes) references,
  (SELECT count(*)::int FROM public.college_attachments) attachments,
  (SELECT count(*)::int FROM public.college_emails) emails,
  (SELECT count(*)::int FROM public.applications) applications`)).rows[0];
 // The migration rechecks all leases while the fence remains held.
 await client.query(body);
 assert.equal((await client.query(`SELECT count(*)::int n FROM (
  (SELECT * FROM expected_roster_metadata EXCEPT SELECT source_kind,source_key,source_revision,policy_version,usable,legacy_roster_hash,payload_hash FROM public.roster_lookup_indexes)
  UNION ALL (SELECT source_kind,source_key,source_revision,policy_version,usable,legacy_roster_hash,payload_hash FROM public.roster_lookup_indexes EXCEPT SELECT * FROM expected_roster_metadata)) differences`)).rows[0].n,0);
 assert.equal((await client.query(`SELECT count(*)::int n FROM public.roster_lookup_indexes i LEFT JOIN public.roster_lookup_payloads p USING(payload_hash)
  WHERE p.payload_hash IS NULL OR encode(sha256(convert_to(p.token_locations::text,'UTF8')),'hex')<>i.payload_hash`)).rows[0].n,0);
 const after=(await client.query(`SELECT count(*)::int payloads,pg_total_relation_size('public.roster_lookup_payloads')::text payload_bytes FROM public.roster_lookup_payloads`)).rows[0];
 await client.query(body); // Also verifies idempotence on real data.
 if(!apply) {
  await client.query('ROLLBACK');
  console.log(JSON.stringify({mode:'verified-and-rolled-back',before,after}));
 } else {
  const directory=`backups/roster-dedup-${new Date().toISOString().replaceAll(':','-')}`;
  await mkdir(directory,{recursive:true});
  await writeFile(`${directory}/verification.json`,JSON.stringify({before,after,metadataAndPayloadHashesPreserved:true},null,2));
  // Existing payloads are losslessly represented by the new table. Metadata
  // plus their hashes is enough to verify/reconstruct the former derived cache.
  await writeFile(`${directory}/metadata.json`,JSON.stringify((await client.query('SELECT * FROM expected_roster_metadata')).rows));
  await client.query('COMMIT');
  await client.query("SET lock_timeout='2s'; SET statement_timeout='15s'");
  await client.query('VACUUM (FULL,ANALYZE) public.roster_lookup_indexes');
  const final=(await client.query(`SELECT pg_database_size(current_database())::text database_bytes,
   (pg_total_relation_size('public.roster_lookup_indexes')+pg_total_relation_size('public.roster_lookup_payloads'))::text cache_bytes,
   (SELECT count(*)::int FROM public.roster_lookup_indexes) references,
   (SELECT count(*)::int FROM public.college_attachments) attachments,
   (SELECT count(*)::int FROM public.college_emails) emails,
   (SELECT count(*)::int FROM public.applications) applications`)).rows[0];
  for(const key of ['references','attachments','emails','applications']) assert.equal(final[key],before[key]);
  await writeFile(`${directory}/result.json`,JSON.stringify({before,after,final,committed:true},null,2));
  console.log(JSON.stringify({mode:'committed',before,after,final}));
 }
} catch(error) {
 await client.query('ROLLBACK').catch(()=>{});
 throw error;
} finally {await client.end();}
