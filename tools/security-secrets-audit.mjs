// Read-only scanner. Never print credentials or matching source lines.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { join } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const secrets = [];
const environment = [];
const publicKeys = new Set(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_SITE_URL']);
for (const file of readdirSync('.').filter(p => /^\.env(?:\.|$)/.test(p) && p !== '.env.example')) {
  const env = parseEnv(readFileSync(file, 'utf8'));
  environment.push({ file, keys: Object.keys(env), publicAllowlistViolations: Object.keys(env).filter(k => k.startsWith('NEXT_PUBLIC_') && !publicKeys.has(k)), encryptionKeyValid: env.TOKEN_ENCRYPTION_KEY === undefined ? null : /^[a-f\d]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY) });
  for (const [key, value] of Object.entries(env)) {
    if (value.length >= 16 && !publicKeys.has(key) && /SECRET|TOKEN|PASSWORD|DB_PASS|API_KEY|SERVICE_ROLE|ENCRYPTION|PRIVATE_KEY/i.test(key)) secrets.push({ key, value });
  }
}
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['google-api-key', /AIza[\w-]{35}/g],
  ['github-token', /(?:gh[pousr]_[A-Za-z\d]{36,}|github_pat_[A-Za-z\d_]{50,})/g],
  ['aws-access-key', /AKIA[A-Z\d]{16}/g],
  ['supabase-service-jwt', /eyJ[\w-]+\.[\w-]+\.[\w-]+/g],
];
function inspect(text, path, scope) {
  const findings = [];
  for (const { key, value } of secrets) if (text.includes(value)) findings.push({ scope, path, kind: `known-secret:${key}` });
  for (const [kind, regex] of patterns) {
    for (const m of text.matchAll(regex)) {
      if (kind === 'supabase-service-jwt') {
        try { if (JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url')).role !== 'service_role') continue; } catch { continue; }
      }
      findings.push({ scope, path, kind, line: text.slice(0, m.index).split('\n').length });
    }
  }
  return findings;
}
const findings = [];
const tracked = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
for (const path of tracked) {
  try { findings.push(...inspect(readFileSync(path, 'utf8'), path, 'working-tree')); } catch { /* Removed file */ }
}
const blobs = process.argv.includes('--current-only') ? [] : git('rev-list', '--objects', '--all').split('\n').filter(Boolean);
let blobCount = 0;
for (const entry of blobs) {
  const [oid, ...parts] = entry.split(' ');
  const path = parts.join(' ');
  if (!path) continue;
  // Trees also have paths; inspect blobs only, once per unique object.
  if (git('cat-file', '-t', oid).trim() !== 'blob') continue;
  blobCount++;
  const text = git('cat-file', 'blob', oid);
  findings.push(...inspect(text, path, `git:${oid.slice(0, 12)}`));
}
let bundleCount = 0;
function bundles(dir) {
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) bundles(path);
      else if (/\.(js|json|map|html)$/.test(name)) { bundleCount++; findings.push(...inspect(readFileSync(path, 'utf8'), path, 'browser-bundle')); }
    }
  } catch { /* No build yet */ }
}
bundles('.next/static');
const unique = [...new Map(findings.map(f => [JSON.stringify(f), f])).values()];
const report = { environment, trackedFiles: tracked.length, reachableBlobs: blobCount, browserBundles: bundleCount, findings: unique };
writeFileSync(process.argv.includes('--current-only') ? 'scratch/security-secrets-current.json' : 'scratch/security-secrets-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
