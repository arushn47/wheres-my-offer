const READ_ONLY_APIS = new Set([
  '/api/sync/status',
  '/api/sync/shared-status',
  '/api/notifications',
]);

/** Fence new writers during an explicitly enabled database cutover pause. */
export function shouldPauseRequest(pathname: string, method: string, enabled: boolean): boolean {
  if (!enabled) return false;
  if (method !== 'GET' && method !== 'HEAD') return true;
  // GET cron, OAuth callbacks and repair routes can write too. Only audited
  // progress/notification reads may enter API handlers during the pause.
  return pathname.startsWith('/api/') && !READ_ONLY_APIS.has(pathname);
}
