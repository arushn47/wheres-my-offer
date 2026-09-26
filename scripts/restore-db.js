/**
 * scripts/restore-db.js
 * 
 * Standalone restore utility for Where's My Offer.
 * Restores a SQL dump created by backup-db.js to the database specified in .env.local
 * or via custom connection string.
 * 
 * Usage:
 *   node scripts/restore-db.js [path-to-sql-file]
 *   npm run db:restore
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pgPath = require.resolve('pg', { paths: [process.cwd()] });
const { Client } = require(pgPath);

const envFile = path.join(process.cwd(), '.env.local');
const env = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
const passMatch = env.match(/db_pass=([^\r\n]+)/);
const dbPass = passMatch ? passMatch[1].trim() : '';

const backupDir = path.join(process.cwd(), 'backups');
let targetFile = process.argv[2] || path.join(backupDir, 'latest.sql');

if (!fs.existsSync(targetFile)) {
  // Check for compressed .gz
  if (fs.existsSync(targetFile + '.gz')) {
    targetFile = targetFile + '.gz';
  } else {
    console.error(`Error: Backup file not found: ${targetFile}`);
    process.exit(1);
  }
}

async function runRestore() {
  console.log(`[Restore] Target backup file: ${targetFile}`);
  let sqlContent = '';

  if (targetFile.endsWith('.gz')) {
    console.log(`[Restore] Decompressing gzip file...`);
    const buffer = fs.readFileSync(targetFile);
    sqlContent = zlib.gunzipSync(buffer).toString('utf8');
  } else {
    sqlContent = fs.readFileSync(targetFile, 'utf8');
  }

  console.log(`[Restore] Connecting to PostgreSQL database...`);
  const client = new Client({
    host: 'aws-0-ap-southeast-1.pooler.supabase.com',
    port: 5432,
    user: 'postgres.mltfzskewmpifnyleevb',
    password: dbPass,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  console.log(`[Restore] Executing SQL restore (size: ${(sqlContent.length / (1024 * 1024)).toFixed(2)} MB)...`);
  const startTime = Date.now();

  try {
    await client.query(sqlContent);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=======================================================`);
    console.log(`✅ Database successfully restored in ${duration}s!`);
    console.log(`=======================================================\n`);
  } catch (err) {
    console.error(`[Restore] Error executing restore SQL:`, err);
  } finally {
    await client.end();
  }
}

runRestore().catch(console.error);
