// Read-only by default. No Vercel credentials, changes, deployment or queue claims.
import pg from 'pg';
import { readCutoverConnections, checkLiveWriters, requireNoLiveWriters, verifyProductionPause, SOURCE_REF, DESTINATION_REF } from './cutover-connections.mjs';

const connections = await readCutoverConnections();
const paused = process.argv.includes('--require-paused');
if (paused) await verifyProductionPause();
const report = {sourceProjectRef:SOURCE_REF,destinationProjectRef:DESTINATION_REF,productionPauseVerified:paused,databases:{},readOnly:true};
for (const [name,connection] of Object.entries(connections)) {
  const db = new pg.Client({...connection,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
  try {
    await db.connect(); await db.query('BEGIN READ ONLY');
    const writers = await checkLiveWriters(db);
    const {rows} = await db.query(`SELECT
      (SELECT count(*)::int FROM public.users) AS users,
      (SELECT count(*)::int FROM public.applications) AS applications,
      (SELECT count(*)::int FROM public.gmail_pubsub_inbox WHERE status<>'completed') AS pending_push_records,
      (SELECT count(*)::int FROM public.pending_drive_recalculations) AS pending_drive_recalculations`);
    if (paused) requireNoLiveWriters(writers);
    report.databases[name] = {...rows[0],writers};
  } finally { await db.query('ROLLBACK').catch(()=>{}); await db.end(); }
}
console.log(JSON.stringify(report));
