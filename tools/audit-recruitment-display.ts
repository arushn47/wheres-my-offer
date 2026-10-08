import pg from 'pg';
import { getRoundParticipation, resolveRecruitmentStatus, summarizeRoundDecisions } from '@/lib/sync/recruitment/round-status';
import { getEffectiveStage } from '@/lib/stages';

const userId = process.argv.find(arg => arg.startsWith('--user='))?.slice(7);
const allUsers = process.argv.includes('--all');
const assertParticipation = process.argv.includes('--assert-participation');
if (!userId && !allUsers) throw new Error('Provide --user=<user UUID> or --all to audit recruitment statuses.');

const projectRef = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
const db = new pg.Client({
  host: process.env.DB_POOLER_HOST || 'aws-0-ap-southeast-1.pooler.supabase.com', port: 5432,
  user: `postgres.${projectRef}`, password: process.env.db_pass, database: 'postgres',
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
});
await db.connect();
try {
  await db.query('BEGIN READ ONLY');
  const { rows } = await db.query(`
    select a.placement_drive_id, c.name, a.status, a.manual_override, a.notes,
      coalesce((select jsonb_agg(jsonb_build_object('verdict', v.verdict, 'is_current', v.is_current))
        from round_verdicts v where v.user_id = a.user_id and v.placement_drive_id = a.placement_drive_id), '[]') decisions,
      coalesce((select jsonb_agg(jsonb_build_object('event_type', e.event_type, 'start_time', e.start_time, 'end_time', e.end_time))
        from events e where e.user_id = a.user_id and e.placement_drive_id = a.placement_drive_id), '[]') events
    from applications a join placement_drives d on d.id = a.placement_drive_id join companies c on c.id = d.company_id
    where ($1::uuid is null or a.user_id = $1) order by c.name
  `, [userId || null]);
  const companyFilter = process.argv.find(arg => arg.startsWith('--company='))?.slice(10);
  let checked = 0;
  let failures = 0;
  for (const app of rows) {
    if (companyFilter && !new RegExp(companyFilter, 'i').test(app.name)) continue;
    const decisions = summarizeRoundDecisions(app.decisions);
    const resolved = resolveRecruitmentStatus(app.status, decisions, app.manual_override, app.notes || '');
    const effective = getEffectiveStage(resolved, null, app.events, app.notes, app.manual_override);
    if (assertParticipation) {
      if (app.manual_override) continue;
      checked++;
      const participation = getRoundParticipation(decisions);
      const invalidTest = effective.effectiveStatus === 'rejected_test' && !participation.test && app.status !== 'test_completed';
      const invalidPpt = effective.effectiveStatus === 'not_shortlisted_post_ppt' && !participation.ppt && !['ppt_completed', 'ppt_ongoing'].includes(app.status);
      if (!invalidTest && !invalidPpt) continue;
      failures++;
    }
    console.log(JSON.stringify({ drive: app.placement_drive_id, company: app.name, stored: app.status, displayed: effective.effectiveStatus, text: effective.statusSubtitle,
      rounds: decisions.map(d => ({ round: d.roundKey, type: d.roundType, state: d.state, receivedAt: d.sourceReceivedAt, current: d.isCurrent, version: d.parserVersion })) }));
  }
  if (assertParticipation) {
    console.log(JSON.stringify({ checked, failures }));
    if (failures) process.exitCode = 1;
  }
  await db.query('ROLLBACK');
} finally {
  await db.end();
}
