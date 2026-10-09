// Entirely local PostgreSQL (WASM); never reads production connection variables.
// Install test runtime: npm install --prefix scratch/sql-test-runtime --no-save --package-lock=false @electric-sql/pglite@0.3.14
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const runtime = resolve('scratch/sql-test-runtime/node_modules/@electric-sql/pglite/dist/index.js');
const user = '00000000-0000-4000-8000-000000000001';
const drive = '00000000-0000-4000-8000-000000000002';
const run = '00000000-0000-4000-8000-000000000003';
const key = `shortlist_absent:${user}:${drive}`;
const negative = (overrides = {}) => ({ roundKey: 'test:1', state: 'verified_absent', eligible: false, finalNegative: true, reason: 'complete_list_absence', sourceReceivedAt: new Date(Date.now()-60000).toISOString(), rosterKey: 'one', parserVersion: 4, evaluations: [{ state: 'verified_absent' }], ...overrides });
const payload = (overrides = {}) => ({ userId: user, placementDriveId: drive, type: 'shortlist_match', title: 'Not Shortlisted: Fixture', body: 'Confirmed negative', dedupeKey: key, ...overrides });
let db;
const commit = async (v, status = 'not_shortlisted', notification = payload(), lease = run) => (await db.query('SELECT public.commit_round_verdict($1,$2,$3,$4,$5,true,$6,null) id',[user,lease,drive,JSON.stringify(v),status,notification ? JSON.stringify(notification) : null])).rows[0].id;
const count = async table => (await db.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n;
const insertNotification = async (id, dedupeKey = key) => (await db.query(`INSERT INTO public.notifications(user_id,placement_drive_id,type,title,dedupe_key,decision_id) VALUES($1,$2,'shortlist_match','Fixture',$3,$4) RETURNING id`,[user,drive,dedupeKey,id])).rows[0].id;
const claim = async id => (await db.query('SELECT public.claim_notification_push($1) ok',[id])).rows[0].ok;

describe('negative round RPC migration in local PostgreSQL', { skip: !existsSync(runtime) }, () => {
  before(async () => {
    const { PGlite } = await import(pathToFileURL(runtime).href);
    db = new PGlite();
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE public.sync_state(user_id uuid PRIMARY KEY,run_id uuid,is_syncing boolean,lease_expires_at timestamptz);
      CREATE TABLE public.applications(user_id uuid,placement_drive_id uuid,manual_override boolean DEFAULT false,status text CHECK(status IN ('applied','shortlisted','not_shortlisted','withdrawn','declined','not_applied','unknown','registration_open','rejected','selected')),status_source text,status_confidence text,status_source_email_at timestamptz,last_updated timestamptz,PRIMARY KEY(user_id,placement_drive_id));
      CREATE TABLE public.round_verdicts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,placement_drive_id uuid,round_key text,verdict jsonb,source_received_at timestamptz,is_current boolean DEFAULT false,updated_at timestamptz DEFAULT now(),UNIQUE(user_id,placement_drive_id,round_key));
      CREATE UNIQUE INDEX current_round ON public.round_verdicts(user_id,placement_drive_id) WHERE is_current;
      CREATE TABLE public.notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,placement_drive_id uuid,type text,title text,dedupe_key text UNIQUE,decision_id uuid,is_read boolean DEFAULT false,dismissed_at timestamptz,superseded_at timestamptz,push_delivered_at timestamptz,push_claimed_at timestamptz);
      CREATE TABLE public.decision_notification_outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,decision_id uuid,dedupe_key text UNIQUE,payload jsonb,delivered_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE FUNCTION public.reconcile_drive_events(uuid,uuid,uuid,jsonb) RETURNS void LANGUAGE SQL AS $$ SELECT; $$;`);
    // Start from the existing RPC, then apply exactly the prepared migration.
    const original = readFileSync('supabase/migrations/migration_v40_round_decisions.sql','utf8');
    await db.exec(original.slice(original.indexOf('CREATE OR REPLACE FUNCTION public.commit_round_verdict('),original.indexOf('CREATE OR REPLACE FUNCTION public.update_sync_lease(')));
    const migration = readFileSync('supabase/migrations/migration_v47_negative_round_notifications.sql','utf8');
    await db.exec(migration);
    await db.exec(migration); // Redeployment is idempotent; contains no data backfill.
  });
  beforeEach(async () => {
    await db.exec('TRUNCATE sync_state,applications,round_verdicts,notifications,decision_notification_outbox');
    await db.query("INSERT INTO sync_state VALUES($1,$2,true,now()+interval '5 minutes')",[user,run]);
    await db.query("INSERT INTO applications(user_id,placement_drive_id,status) VALUES($1,$2,'applied')",[user,drive]);
  });
  after(async () => { await db?.close(); });
  it('queues a confirmed negative and claims push once, retaining the alert on replay', async () => {
    const v = negative(); const id = await commit(v);
    assert.equal(await count('decision_notification_outbox'),1);
    const notification = await insertNotification(id);
    assert.equal(await claim(notification),true); assert.equal(await claim(notification),null);
    await commit({...v,rosterKey:'revised'});
    assert.equal(await count('decision_notification_outbox'),1);
    assert.deepEqual((await db.query('SELECT is_read,superseded_at FROM notifications')).rows[0],{is_read:false,superseded_at:null});
  });
  it('excludes withdrawn/not-applied, manual overrides, and unsupported participation states', async () => {
    for(const status of ['withdrawn','declined','not_applied','registration_open','unknown']) {
      await db.query('UPDATE applications SET status=$1',[status]);
      await commit(negative(),status); assert.equal(await count('decision_notification_outbox'),0);
    }
    await db.exec("UPDATE applications SET manual_override=true,status='applied'");
    assert.equal(await commit(negative()),null); assert.equal(await count('decision_notification_outbox'),0);
  });
  it('requires a final complete verified scan, excluding deferred/missing/partial lists', async () => {
    for(const overrides of [{finalNegative:false},{reason:'partial_list_absence'},{state:'deferred'},{evaluations:[]},{evaluations:[{state:'deferred'}]}]) {
      await commit(negative(overrides),'applied'); assert.equal(await count('decision_notification_outbox'),0);
    }
    await commit(negative({evaluations:[],outcome:'rejected'})); assert.equal(await count('decision_notification_outbox'),1);
  });
  it('preserves positive notification keys, and supersedes the negative on confirmed requalification', async () => {
    const v=negative();const id=await commit(v);const negativeAlert=await insertNotification(id);
    const positive={...v,eligible:true,finalNegative:false,state:'verified_present',reason:'matched',sourceReceivedAt:new Date(Date.now()-50000).toISOString()};
    const positiveKey=`round:${user}:${drive}:test:1:present`;
    await commit(positive,'shortlisted',payload({dedupeKey:positiveKey,title:'Shortlisted: Fixture'}));
    const positiveAlert=await insertNotification(id,positiveKey);
    assert.equal(await claim(negativeAlert),null);assert.equal(await claim(positiveAlert),true);
    assert.equal((await db.query('SELECT status FROM applications')).rows[0].status,'shortlisted');
  });
  it('does not send a stale positive payload after the decision becomes negative', async () => {
    const id=await commit(negative({eligible:true,state:'verified_present',finalNegative:false}),'shortlisted',null);
    const n=await insertNotification(id,`round:${user}:${drive}:old:present`);
    await commit(negative({sourceReceivedAt:new Date(Date.now()-50000).toISOString()}));
    assert.equal(await claim(n),null);
  });
  it('repoints an undelivered elimination when the current decision changes, without duplicating it', async () => {
    const first=negative();const old=await commit(first);
    const fresh=negative({roundKey:'interview:1',sourceReceivedAt:new Date(Date.now()-50000).toISOString()});
    const current=await commit(fresh);
    assert.notEqual(old,current);assert.equal(await count('decision_notification_outbox'),1);
    assert.equal((await db.query('SELECT decision_id FROM decision_notification_outbox')).rows[0].decision_id,current);
    const n=await insertNotification(current);
    await commit(negative({roundKey:'selected',sourceReceivedAt:new Date(Date.now()-40000).toISOString()}));
    assert.equal(await count('notifications'),1); assert.equal(await count('decision_notification_outbox'),1);
    assert.equal(await claim(n),null); // An old verdict cannot push a later elimination.
  });
  it('keeps read/dismissed/superseded legacy elimination alerts as a dedupe ledger', async () => {
    for(const suffix of ['not_shortlisted','rejected','rejected_test','rejected_interview']) {
      await db.exec('TRUNCATE notifications,decision_notification_outbox');
      await insertNotification(null,`status:${user}:${drive}:${suffix}`);
      await db.exec('UPDATE notifications SET is_read=true,dismissed_at=now(),superseded_at=now()');
      await commit(negative()); assert.equal(await count('decision_notification_outbox'),0);
    }
  });
  it('rechecks participation at push time and rejects stale, expired, mismatched, or old recovery requests', async () => {
    const id=await commit(negative()); const n=await insertNotification(id);
    await db.exec("UPDATE applications SET status='withdrawn'");assert.equal(await claim(n),null);
    await db.exec("UPDATE applications SET status='applied',manual_override=true");assert.equal(await claim(n),null);
    await db.exec('UPDATE applications SET manual_override=false; TRUNCATE notifications,decision_notification_outbox');
    assert.equal((await db.query('SELECT enqueue_negative_round_notification($1,$2,$3,$4) ok',[user,run,id,JSON.stringify(payload({placementDriveId:user}))])).rows[0].ok,false);
    await db.exec("UPDATE round_verdicts SET source_received_at=now()-interval '3 days'");
    assert.equal((await db.query('SELECT enqueue_negative_round_notification($1,$2,$3,$4) ok',[user,run,id,JSON.stringify(payload())])).rows[0].ok,false);
    await db.exec("UPDATE sync_state SET lease_expires_at=now()-interval '1 second'");
    await assert.rejects(()=>commit(negative()),/Sync lease lost/);
    assert.equal(await count('decision_notification_outbox'),0);
  });
  it('recovers only an explicitly selected current verdict, queuing without changing status or history', async () => {
    const id=await commit(negative(),'not_shortlisted',null);
    const before=(await db.query('SELECT verdict,updated_at FROM round_verdicts')).rows;
    const queue=()=>db.query('SELECT enqueue_negative_round_notification($1,$2,$3,$4) ok',[user,run,id,JSON.stringify(payload())]);
    assert.equal((await queue()).rows[0].ok,true);await queue();
    assert.equal(await count('decision_notification_outbox'),1);
    assert.deepEqual((await db.query('SELECT verdict,updated_at FROM round_verdicts')).rows,before);
    assert.equal((await db.query('SELECT status FROM applications')).rows[0].status,'not_shortlisted');
    const n=await insertNotification(id);assert.equal(await claim(n),true);
    assert.equal((await queue()).rows[0].ok,false);
  });
  it('keeps both notification RPCs service-only', async () => {
    for(const role of ['anon','authenticated']) for(const fn of ['enqueue_negative_round_notification(uuid,uuid,uuid,jsonb)','claim_notification_push(uuid)']) {
      assert.equal((await db.query('SELECT has_function_privilege($1,$2,$3) ok',[role,fn,'EXECUTE'])).rows[0].ok,false);
    }
  });
  it('rolls back status, verdict and outbox together when an atomic commit fails', async () => {
    const id=await commit(negative()); const before=(await db.query('SELECT * FROM round_verdicts WHERE id=$1',[id])).rows;
    await assert.rejects(()=>commit(negative({roundKey:'interview:1'}),'invalid-status'));
    assert.deepEqual((await db.query('SELECT * FROM round_verdicts WHERE id=$1',[id])).rows,before);
    assert.equal(await count('round_verdicts'),1);assert.equal(await count('decision_notification_outbox'),1);
    assert.equal((await db.query('SELECT status FROM applications')).rows[0].status,'not_shortlisted');
  });
});
