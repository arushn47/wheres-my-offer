import { parseEnv } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export const SOURCE_REF = 'mltfzskewmpifnyleevb';
export const DESTINATION_REF = 'nvkxyeugonjevmbvxirm';
// Windows process.env is case-insensitive: source db_pass and destination
// DB_PASS collide when both dotenv files are loaded into the same environment.
// Parse independently into ordinary objects; never merge these secret maps.
export async function readCutoverConnections() {
  const source = parseEnv(await readFile(resolve('.env.local'),'utf8'));
  const destination = parseEnv(await readFile(resolve('.env.restore.local'),'utf8'));
  return cutoverConnections(source,destination);
}
export function cutoverConnections(env, restore = env) {
  if (new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname !== `${SOURCE_REF}.supabase.co`) throw new Error('Local source configuration must still identify production');
  const ref = restore.DESTINATION_PROJECT_REF || restore.RESTORE_PROJECT_REF;
  const destinationUrl = restore.DESTINATION_SUPABASE_URL || restore.RESTORE_SUPABASE_URL;
  if (ref !== DESTINATION_REF || new URL(destinationUrl).hostname !== `${ref}.supabase.co`) throw new Error('Pinned Mumbai destination required');
  const source = {host:env.DB_POOLER_HOST || 'aws-0-ap-southeast-1.pooler.supabase.com',port:Number(env.DB_POOLER_PORT || 5432),
    user:env.DB_USER || `postgres.${SOURCE_REF}`,password:env.DB_PASSWORD || env.db_pass,database:env.DB_NAME || 'postgres'};
  const destination = {host:restore.DESTINATION_DB_HOST || restore.host,port:Number(restore.DESTINATION_DB_PORT || restore.port || 5432),
    user:restore.DESTINATION_DB_USER || restore.user,password:restore.DESTINATION_DB_PASSWORD || restore.DB_PASS,database:'postgres'};
  for (const [id,connection] of [[SOURCE_REF,source],[DESTINATION_REF,destination]]) {
    if (!connection.password || connection.port !== 5432 || connection.database !== 'postgres' ||
        !(connection.host === `db.${id}.supabase.co` || connection.host?.endsWith('.pooler.supabase.com') && connection.user === `postgres.${id}`)) {
      throw new Error('Invalid or mixed cutover database credentials');
    }
  }
  return {source,destination};
}

/** Anonymous requests cannot dispatch work if the pause is absent; no OAuth code
 * or cron secret is sent. All responses must identify the actual writer fence. */
export async function verifyProductionPause(request = fetch) {
  for (const [path,method] of [['/api/cron/sync','GET'],['/api/auth/callback','GET'],['/api/sync','POST']]) {
    const response = await request(`https://www.wheresmyoffer.in${path}`,{method,redirect:'manual',signal:AbortSignal.timeout(15000)});
    const content = await response.json().catch(()=>null);
    if (response.status !== 503 || response.headers.get('retry-after') !== '60' ||
        content?.error !== 'Database maintenance is in progress. Please retry shortly.') {
      throw new Error('Production writer pause is not active; no refresh is allowed');
    }
  }
}

export async function checkLiveWriters(client) {
  const {rows} = await client.query(`SELECT
    (SELECT count(*)::int FROM public.sync_state WHERE is_syncing AND
      (lease_expires_at>now() OR lease_expires_at IS NULL AND updated_at>now()-interval '3 minutes')) AS user_leases,
    (SELECT count(*)::int FROM public.shared_college_sync_state WHERE is_syncing AND lease_expires_at>now()) AS shared_leases,
    (SELECT count(*)::int FROM public.gmail_pubsub_inbox WHERE status='processing' AND locked_until>now()) AS push_claims,
    (SELECT count(*)::int FROM public.college_archive_refresh_lease WHERE locked_until>now()) AS archive_leases`);
  return rows[0];
}

export function requireNoLiveWriters(counts) {
  if (Object.values(counts).some(value=>value !== 0)) throw new Error('Live database writer lease/claim remains; wait for it to drain');
}
