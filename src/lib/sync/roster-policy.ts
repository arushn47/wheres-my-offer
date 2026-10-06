/** Purpose is evaluated per tab/section, not inherited from an email's subject. */
export function isNonShortlistRoster(name: string): boolean {
  return /applied|eligible|registered|registration|opt[\s_-]*in|wait[\s_-]*list|waiting|alternate|reserve|reject|not[\s_-]*(?:selected|shortlisted)/i.test(name);
}

export function isPositiveRosterRow(row: unknown[], headers?: unknown[]): boolean {
  if (row.some((cell) => /^(?:not\s+(?:selected|shortlisted)|rejected|waitlisted|withdrawn|declined)$/i.test(String(cell ?? '').trim()))) return false;
  const columns = (headers || []).flatMap((cell, index) =>
    /^(?:venue|seat|room|lab|hall|slot|allocation)(?:\s|$)/i.test(String(cell ?? '').trim()) ? [index] : []);
  return columns.length === 0 || columns.some((index) => {
    const value = String(row[index] ?? '').trim();
    return value.length > 0 && !/^(?:[-–—]+|n\/?a|nil|none|not\s+allocated|#n\/a)$/i.test(value);
  });
}

export function normalizeIdentityToken(value: unknown): string {
  const text = String(value ?? '').trim();
  return text.includes('@') ? text.toLowerCase() : text.replace(/[\u00a0\s\-_.]/g, '').toUpperCase();
}
