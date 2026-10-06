import pg from 'pg';
const userId = process.argv.find(a => a.startsWith('--user='))?.slice(7);
const company = process.argv.find(a => a.startsWith('--company='))?.slice(10);
if (!userId || !company) throw new Error('Provide --user=<UUID> and --company=<name pattern>');
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
const db = new pg.Client({ host: process.env.DB_POOLER_HOST || 'aws-0-ap-southeast-1.pooler.supabase.com', port: 5432, user: `postgres.${project}`, password: process.env.db_pass, database: 'postgres', ssl: { rejectUnauthorized: false } });
await db.connect();
try {
  await db.query('BEGIN READ ONLY');
  const drives = (await db.query(`select d.id,c.name from applications a join placement_drives d on d.id=a.placement_drive_id join companies c on c.id=d.company_id where a.user_id=$1 and c.name ~* $2`, [userId,company])).rows;
  for (const drive of drives) {
    const emails = (await db.query(`select c.id,c.subject,c.received_at,c.body_text from college_emails c where c.parsed_company_name=$1 order by c.received_at`,[drive.name])).rows;
    console.log(JSON.stringify({company:drive.name,driveId:drive.id,emails:emails.filter(e=>/ppt|pre.?placement/i.test(e.subject) && !/^(?:Re:|Reminder)/i.test(e.subject)).map(e=>({subject:e.subject,receivedAt:e.received_at,body:e.body_text?.slice(0,1300)}))}));
  }
  await db.query('ROLLBACK');
} finally { await db.end(); }
