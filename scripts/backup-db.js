/**
 * scripts/backup-db.js
 * 
 * Standalone, zero-dependency PostgreSQL backup utility for Where's My Offer.
 * Streams all tables and schemas directly from Supabase into a timestamped SQL dump.
 * 
 * Usage:
 *   node scripts/backup-db.js
 *   npm run db:backup
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pgPath = require.resolve('pg', { paths: [process.cwd()] });
const { Client } = require(pgPath);

// Ensure backups directory exists
const backupDir = path.join(process.cwd(), 'backups');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

// Read database credentials from .env.local
const envFile = path.join(process.cwd(), '.env.local');
if (!fs.existsSync(envFile)) {
  console.error('Error: .env.local not found');
  process.exit(1);
}

const env = fs.readFileSync(envFile, 'utf8');
const passMatch = env.match(/db_pass=([^\r\n]+)/);
const dbPass = passMatch ? passMatch[1].trim() : '';

if (!dbPass) {
  console.error('Error: db_pass not found in .env.local');
  process.exit(1);
}

async function runBackup() {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `wmo-backup-${timestamp}.sql`;
  const gzFilename = `${filename}.gz`;
  const outPath = path.join(backupDir, filename);
  const gzPath = path.join(backupDir, gzFilename);

  console.log(`[Backup] Connecting to Supabase database...`);
  const client = new Client({
    host: 'aws-0-ap-southeast-1.pooler.supabase.com',
    port: 5432,
    user: 'postgres.mltfzskewmpifnyleevb',
    password: dbPass,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  const writeStream = fs.createWriteStream(outPath, { encoding: 'utf8' });

  writeStream.write(`-- Where's My Offer Database Backup\n`);
  writeStream.write(`-- Generated: ${new Date().toISOString()}\n\n`);
  writeStream.write(`SET statement_timeout = 0;\n`);
  writeStream.write(`SET lock_timeout = 0;\n`);
  writeStream.write(`SET client_encoding = 'UTF8';\n`);
  writeStream.write(`SET standard_conforming_strings = on;\n\n`);

  // Get all user tables in public schema
  const tablesRes = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `);

  const tables = tablesRes.rows.map(r => r.table_name);
  console.log(`[Backup] Found ${tables.length} tables in public schema.`);

  writeStream.write(`SET session_replication_role = 'replica';\n\n`);

  for (const table of tables) {
    process.stdout.write(`[Backup] Exporting table: ${table}... `);
    
    // Get columns
    const colsRes = await client.query(`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position;
    `, [table]);

    const columns = colsRes.rows.map(c => `"${c.column_name}"`);
    const colList = columns.join(', ');

    // Get rows
    const dataRes = await client.query(`SELECT * FROM public."${table}"`);
    const rowCount = dataRes.rowCount;

    writeStream.write(`-- Table: public."${table}" (${rowCount} rows)\n`);
    writeStream.write(`TRUNCATE TABLE public."${table}" CASCADE;\n`);

    if (rowCount > 0) {
      const batchSize = 100;
      for (let i = 0; i < rowCount; i += batchSize) {
        const batch = dataRes.rows.slice(i, i + batchSize);
        const valueClauses = [];

        for (const row of batch) {
          const values = colsRes.rows.map(col => {
            const val = row[col.column_name];
            if (val === null || val === undefined) return 'NULL';
            if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
            if (typeof val === 'number') return String(val);
            if (val instanceof Date) return `'${val.toISOString()}'`;
            if (typeof val === 'object') {
              return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
            }
            return `'${String(val).replace(/'/g, "''")}'`;
          });
          valueClauses.push(`(${values.join(', ')})`);
        }

        writeStream.write(`INSERT INTO public."${table}" (${colList}) VALUES\n  ${valueClauses.join(',\n  ')};\n`);
      }
    }

    writeStream.write(`\n`);
    console.log(`${rowCount} rows`);
  }

  writeStream.write(`SET session_replication_role = 'origin';\n`);
  writeStream.write(`-- Backup Complete\n`);

  await new Promise(resolve => writeStream.end(resolve));
  await client.end();

  // Compress the SQL dump with gzip
  console.log(`[Backup] Compressing SQL dump with gzip...`);
  const rawData = fs.readFileSync(outPath);
  const compressed = zlib.gzipSync(rawData, { level: 9 });
  fs.writeFileSync(gzPath, compressed);

  const rawSizeMb = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2);
  const gzSizeMb = (fs.statSync(gzPath).size / (1024 * 1024)).toFixed(2);

  const latestPath = path.join(backupDir, 'latest.sql');
  fs.copyFileSync(outPath, latestPath);

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=======================================================`);
  console.log(`✅ Backup successfully created in ${durationSec}s!`);
  console.log(`📁 Raw SQL:       ${outPath} (${rawSizeMb} MB)`);
  console.log(`📦 Compressed:    ${gzPath} (${gzSizeMb} MB)`);
  console.log(`🔗 Latest:        ${latestPath}`);
  console.log(`=======================================================\n`);
}

runBackup().catch(err => {
  console.error('[Backup] Fatal error:', err);
  process.exit(1);
});
