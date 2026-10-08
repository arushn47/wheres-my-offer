// Metadata-only audit of the pinned live Mumbai database. Never executes app RPCs,
// counts/scans message bodies, changes schema/data, or infers that an empty table is disposable.
import { Client } from 'pg';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readCutoverConnections, DESTINATION_REF } from './cutover-connections.mjs';

const staticAudit = JSON.parse(await readFile('scratch/codebase-audit/static.json', 'utf8'));
const { destination } = await readCutoverConnections();
const db = new Client({ ...destination, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
try {
  await db.connect();
  await db.query('BEGIN READ ONLY');
  await db.query("SET LOCAL statement_timeout='15s'");
  await db.query("SET LOCAL lock_timeout='2s'");
  const { rows: relations } = await db.query(`SELECT c.oid::int AS oid,c.relname AS name,c.relkind AS kind,
    c.reltuples::bigint AS estimated_rows,pg_total_relation_size(c.oid)::bigint AS total_bytes,c.relrowsecurity AS rls,
    COALESCE(s.n_tup_ins,0)::bigint AS inserts_since_stats_reset,COALESCE(s.n_tup_upd,0)::bigint AS updates_since_stats_reset,
    (SELECT count(*)::int FROM pg_trigger g WHERE g.tgrelid=c.oid AND NOT g.tgisinternal) AS triggers,
    (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) AS policies,
    (SELECT jsonb_agg(conname) FROM pg_constraint k WHERE k.confrelid=c.oid AND k.contype='f') AS incoming_foreign_keys
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') ORDER BY c.relname`);
  const { rows: functions } = await db.query(`SELECT p.proname AS name,
    COALESCE((SELECT jsonb_agg(c.relname) FROM pg_class c JOIN pg_namespace cn ON cn.oid=c.relnamespace
      WHERE cn.nspname='public' AND c.relkind IN ('r','p','v','m') AND lower(pg_get_functiondef(p.oid)) ~ ('(^|[^a-z0-9_])'||c.relname||'([^a-z0-9_]|$)')),'[]') AS referenced_relations,
    (SELECT count(*)::int FROM pg_trigger t WHERE t.tgfoid=p.oid AND NOT t.tgisinternal) AS triggers,
    EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') AS extension_owned
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' ORDER BY p.proname`);
  const { rows: views } = await db.query(`SELECT DISTINCT v.relname AS view_name,c.relname AS referenced_relation
    FROM pg_rewrite r JOIN pg_class v ON v.oid=r.ev_class JOIN pg_namespace vn ON vn.oid=v.relnamespace
    JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid JOIN pg_class c ON c.oid=d.refobjid
    JOIN pg_namespace cn ON cn.oid=c.relnamespace WHERE vn.nspname='public' AND cn.nspname='public'
    AND v.relkind IN ('v','m') AND c.oid<>v.oid ORDER BY v.relname,c.relname`);
  const references = staticAudit.databaseReferences;
  const report = { checkedAt: new Date().toISOString(), projectRef: DESTINATION_REF, readOnly: true,
    caveats: ['Row/activity estimates are not proof of disuse.', 'Function references are conservative text matches; dynamic SQL/external consumers need manual review.', 'No tables, functions, policies or indexes were dropped.'],
    relations: relations.map(table => ({ ...table,
      runtimeReferences: references.filter(r => r.runtime && r.tables.includes(table.name)).map(r => r.file),
      operationalReferences: references.filter(r => !r.runtime && r.tables.includes(table.name)).map(r => r.file),
      functionReferences: functions.filter(f => f.referenced_relations.includes(table.name)).map(f => f.name),
      viewReferences: views.filter(v => v.referenced_relation===table.name).map(v => v.view_name) })),
    functions: functions.map(f => ({ ...f, runtimeCallers: references.filter(r => r.runtime && r.rpcs.includes(f.name)).map(r => r.file),
      operationalCallers: references.filter(r => !r.runtime && r.rpcs.includes(f.name)).map(r => r.file) })), views };
  await db.query('ROLLBACK');
  await mkdir('scratch/codebase-audit', { recursive: true });
  await writeFile('scratch/codebase-audit/database.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ readOnly: true, relations: report.relations.map(r => ({ name:r.name,kind:r.kind,estimatedRows:r.estimated_rows,bytes:r.total_bytes,
    runtimeReferences:r.runtimeReferences.length,operationalReferences:r.operationalReferences.length,functionReferences:r.functionReferences.length,
    incomingForeignKeys:r.incoming_foreign_keys?.length || 0,viewReferences:r.viewReferences.length })),functions:functions.length }, null, 2));
} finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); }
