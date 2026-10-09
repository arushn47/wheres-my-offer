// Executes the existing venue RPC entirely in local PostgreSQL (WASM).
// Optional runtime setup is shared with negative-round-rpcs.test.mjs.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const runtime = resolve('scratch/sql-test-runtime/node_modules/@electric-sql/pglite/dist/index.js');
const drive = '00000000-0000-4000-8000-000000000001';
const source = '00000000-0000-4000-8000-000000000002';
const later = '00000000-0000-4000-8000-000000000003';
const sibling = '00000000-0000-4000-8000-000000000004';
let db;
const merge = (id, emailId, date, entries) => db.query('SELECT public.merge_drive_recruitment_venues($1,$2,$3,$4)', [id, emailId, date, JSON.stringify(entries)]);
const projection = async id => (await db.query('SELECT recruitment_venues FROM placement_drives WHERE id=$1', [id])).rows[0].recruitment_venues;
describe('existing venue merge preserves distinct physical and virtual rounds', { skip: !existsSync(runtime) }, () => {
  before(async () => {
    const { PGlite } = await import(pathToFileURL(runtime).href);
    db = new PGlite();
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE placement_drives(id uuid PRIMARY KEY,drive_number text,normalized_drive_number text,source_college_email_id uuid,excluded_email_ids text[]);
      CREATE TABLE college_emails(id uuid PRIMARY KEY,classification text,parsed_drive_numbers jsonb);`);
    await db.exec(readFileSync('supabase/migrations/migration_v44_drive_venues.sql', 'utf8'));
    await db.query(`INSERT INTO placement_drives VALUES($1,'pat-PL-2026-1114','1114',$2,'{}'),($3,'pat-PL-2026-1368','1368',NULL,'{}')`, [drive, source, sibling]);
    await db.query(`INSERT INTO college_emails VALUES($1,'registration','["pat-PL-2026-1114"]'),($2,'next_round','["pat-PL-2026-1114"]')`, [source, later]);
  });
  after(async () => { await db?.close(); });
  it('retains physical Chennai attendance when a later round announces a virtual interview', async () => {
    await merge(drive, source, '2026-07-20T07:39:00Z', [
      { stage: 'PPT', kind: 'online', name: 'Online', quote: '17-08-2026 - PPT Virtual mode' },
      { stage: 'Physical Process', kind: 'campus', name: 'VIT Chennai', quote: '19-08-2026 - Physical process at Chennai campus (For all)' },
    ]);
    await merge(drive, later, '2026-08-25T03:51:50Z', [
      { stage: 'Recruitment', kind: 'online', name: 'Online', quote: 'UBS next round of selection process is scheduled on 28th August 2026 - Virtual' },
      { stage: 'Interviews', kind: 'online', name: 'Online', quote: 'They will have a virtual interview on 28/08/2026' },
    ]);
    const entries = (await projection(drive)).entries;
    assert.equal(entries.length, 4);
    assert.equal(entries.find(e => e.stage === 'Physical Process').name, 'VIT Chennai');
    assert.equal(entries.find(e => e.stage === 'Interviews').kind, 'online');
  });
  it('rejects the same numbered circular on a sibling drive and remains idempotent', async () => {
    const entries = [{ stage: 'Physical Process', kind: 'campus', name: 'VIT Chennai', quote: 'Physical process at Chennai campus (For all)' }];
    await merge(sibling, source, '2026-07-20T07:39:00Z', entries);
    assert.equal(await projection(sibling), null);
    await merge(drive, source, '2026-07-20T07:39:00Z', entries);
    const before = await projection(drive);
    await merge(drive, source, '2026-07-20T07:39:00Z', entries);
    assert.deepEqual(await projection(drive), before);
  });
  it('lets a newer confirmed local interview instruction replace an older host-campus interview', async () => {
    await db.exec('UPDATE placement_drives SET recruitment_venues=NULL');
    await merge(drive, source, '2026-07-17T13:22:39Z', [
      { stage: 'Interviews', kind: 'campus', name: 'VIT Chennai', quote: 'Shortlisted students will have interviews at chennai campus on 25-07-2026' },
    ]);
    await merge(drive, later, '2026-09-16T09:38:16Z', [
      { stage: 'Interviews', kind: 'respective', name: 'Respective campus', quote: 'Please report to the campus at the earliest' },
    ]);
    const entries = (await projection(drive)).entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'respective');
    assert.equal(entries[0].sourceId, later);
  });
});
