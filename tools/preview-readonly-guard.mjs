// Local rehearsal only. Load with Node --import, never in a deployment.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';

const destination = new URL(process.env.PREVIEW_DESTINATION_URL);
if (destination.hostname !== 'nvkxyeugonjevmbvxirm.supabase.co') {
  throw new Error('Preview must use the verified Mumbai replacement');
}
const readRpcs = new Set(['get_user_sync_page_progress', 'get_shared_college_progress', 'lookup_candidate_rosters', 'get_user_round_status_rows', 'get_user_drive_activity', 'get_recent_college_search_rows']);
function authorize(input, method = 'GET') {
  const url = new URL(input);
  const verb = method.toUpperCase();
  const rpc = url.pathname.startsWith('/rest/v1/rpc/') ? url.pathname.slice('/rest/v1/rpc/'.length) : null;
  const allowed = url.origin === destination.origin &&
    (rpc ? verb === 'POST' && readRpcs.has(rpc) : ['GET', 'HEAD'].includes(verb) && url.pathname.startsWith('/rest/v1/'));
  // Record only aggregate-safe operation names: never filters, headers or bodies.
  appendFileSync(process.env.PREVIEW_AUDIT_FILE, JSON.stringify({ allowed, method: verb, operation: allowed ? url.pathname : 'blocked' }) + '\n');
  if (!allowed) throw new Error('Read-only preview blocked an outbound request');
}
const originalFetch = globalThis.fetch;
globalThis.fetch = function(input, init) {
  authorize(input instanceof Request ? input.url : String(input), init?.method || (input instanceof Request ? input.method : 'GET'));
  return originalFetch(input, init);
};
for (const [module, protocol] of [[http, 'http:'], [https, 'https:']]) {
  const request = module.request;
  module.request = function(input, options, callback) {
    const isUrl = typeof input === 'string' || input instanceof URL;
    const config = isUrl ? (typeof options === 'object' ? options : {}) : input;
    const url = isUrl ? new URL(input) : new URL(`${config.protocol || protocol}//${config.hostname || config.host}${config.port ? ':' + config.port : ''}${config.path || '/'}`);
    authorize(url, config.method || 'GET');
    return request.call(this, input, options, callback);
  };
  module.get = function(...args) { const req = module.request(...args); req.end(); return req; };
}
syncBuiltinESMExports();
