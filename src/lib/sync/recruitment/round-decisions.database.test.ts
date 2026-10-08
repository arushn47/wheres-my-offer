import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, it, expect } from 'vitest';

// Explicit opt-in: all schema changes and fixture writes are rolled back together.
// Uses a caller-selected existing application, and never clears a live lease.
const enabled = process.env.RUN_DATABASE_ROUND_TESTS === '1';
describe.skipIf(!enabled)('round decision database transactions', () => {
  it('fences stale writers, commits before delivery, preserves IDs and overrides, and replays once', async () => {
    const userId = process.env.ROUND_TEST_USER_ID!;
    const driveId = process.env.ROUND_TEST_DRIVE_ID!;
    expect(userId).toBeTruthy(); expect(driveId).toBeTruthy();
    const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
    const db = new Client({ host: process.env.DB_POOLER_HOST || 'aws-0-ap-southeast-1.pooler.supabase.com', port: 5432,
      user: 'postgres.' + ref, password: process.env.db_pass, database: 'postgres', ssl: { rejectUnauthorized: false } });
    await db.connect();
    try {
      await db.query('BEGIN');
      const sql = await readFile('supabase/migrations/migration_v40_round_decisions.sql', 'utf8');
      await db.query(sql.replace(/^BEGIN;/, '').replace(/COMMIT;\s*$/, ''));
      const run = randomUUID();
      expect((await db.query('select public.acquire_sync_lease($1,$2,300) as ok',[userId,run])).rows[0].ok).toBe(true);
      expect((await db.query('select public.acquire_sync_lease($1,$2,300) as ok',[userId,randomUUID()])).rows[0].ok).toBe(false);
      await db.query('update public.applications set manual_override=false where user_id=$1 and placement_drive_id=$2',[userId,driveId]);
      const present = { roundKey: 'test:999', eligible: true, finalNegative: false, state: 'verified_present', sourceReceivedAt: new Date().toISOString(), sourceEmailId: randomUUID(), rosterKey: 'snapshot', evaluations: [] };
      const event = { event_type: 'online_test',title:'Fixture test',start_time: new Date(Date.now()+86400000).toISOString(),end_time:null,venue:'Lab',mode:'online',confidence:'high',round_number:999,round_key:present.roundKey };
      const payload = { userId, placementDriveId:driveId,type:'shortlist_match',title:'Fixture',body:'Fixture',dedupeKey:'fixture:'+randomUUID() };
      const commit = async (verdict: typeof present, status: string, events: unknown[], notification: unknown = payload) => db.query('select public.commit_round_verdict($1,$2,$3,$4,$5,true,$6,$7) as id',[userId,run,driveId,verdict,status,notification,JSON.stringify(events)]);
      const id = (await commit(present,'shortlisted',[event])).rows[0].id;
      const eventId = (await db.query('select id from public.events where user_id=$1 and placement_drive_id=$2 and round_number=999',[userId,driveId])).rows[0].id;
      await db.query('update public.events set gcal_event_id=$1 where id=$2',['fixture-calendar',eventId]);
      await commit(present,'shortlisted',[{...event,venue:'Lab 102'}]);
      const replay = (await db.query('select id,gcal_event_id,venue from public.events where id=$1',[eventId])).rows[0];
      expect(replay).toEqual({id:eventId,gcal_event_id:'fixture-calendar',venue:'Lab 102'});
      // Both extraction variants share the database identity despite differing round metadata.
      await db.query('select public.reconcile_drive_events($1,$2,$3,$4)',[userId,run,driveId,JSON.stringify([event,{...event,round_number:998}])]);
      expect((await db.query('select id,gcal_event_id,round_number from public.events where id=$1',[eventId])).rows[0])
        .toEqual({id:eventId,gcal_event_id:'fixture-calendar',round_number:998});
      await commit(present,'shortlisted',[event]);
      expect((await db.query('select count(*)::int as n from public.decision_notification_outbox where decision_id=$1',[id])).rows[0].n).toBe(1);
      const notificationId = (await db.query("insert into public.notifications(user_id,placement_drive_id,type,title,body,message,dedupe_key,decision_id) values($1,$2,'shortlist_match','Fixture','Fixture','Fixture',$3,$4) returning id",[userId,driveId,payload.dedupeKey,id])).rows[0].id;
      expect((await db.query('select public.claim_notification_push($1) as ok',[notificationId])).rows[0].ok).toBe(true);
      expect((await db.query('select public.claim_notification_push($1) as ok',[notificationId])).rows[0].ok).toBe(null);
      await db.query('SAVEPOINT failed_commit');
      await expect(commit(present,'invalid-status',[event])).rejects.toThrow();
      await db.query('ROLLBACK TO SAVEPOINT failed_commit');
      expect((await db.query('select status from public.applications where user_id=$1 and placement_drive_id=$2',[userId,driveId])).rows[0].status).toBe('shortlisted');
      const absent = {...present,eligible:false,finalNegative:false,state:'verified_absent',sourceReceivedAt:new Date(Date.now()+1000).toISOString()};
      await commit(absent,'applied',[],null);
      expect((await db.query('select superseded_at,is_read from public.notifications where id=$1',[notificationId])).rows[0].is_read).toBe(true);
      expect((await db.query('select count(*)::int as n from public.calendar_removal_outbox where user_id=$1 and gcal_event_id=$2',[userId,'fixture-calendar'])).rows[0].n).toBe(1);
      await db.query("update public.applications set manual_override=true,status='withdrawn' where user_id=$1 and placement_drive_id=$2",[userId,driveId]);
      expect((await commit({...present,sourceReceivedAt:new Date(Date.now()+2000).toISOString()},'shortlisted',[event])).rows[0].id).toBe(null);
      expect((await db.query('select status from public.applications where user_id=$1 and placement_drive_id=$2',[userId,driveId])).rows[0].status).toBe('withdrawn');
      await db.query("update public.sync_state set lease_expires_at=now()-interval '1 second' where user_id=$1",[userId]);
      expect((await db.query("select public.update_sync_lease($1,$2,'{}',300) as ok",[userId,run])).rows[0].ok).toBe(null);
      const successor=randomUUID();
      expect((await db.query('select public.acquire_sync_lease($1,$2,300) as ok',[userId,successor])).rows[0].ok).toBe(true);
      expect((await db.query('select public.assert_sync_lease($1,$2) as ok',[userId,run])).rows[0].ok).toBe(false);
      await db.query('SAVEPOINT fenced_write');
      await db.query("select set_config('request.headers',$1,true)",[JSON.stringify({'x-sync-run-id':run})]);
      await expect(db.query("update public.applications set status='applied' where user_id=$1 and placement_drive_id=$2",[userId,driveId])).rejects.toThrow('Sync lease lost');
      await db.query('ROLLBACK TO SAVEPOINT fenced_write');
    } finally { await db.query('ROLLBACK'); await db.end(); }
  },30000);
});
