/** Compact totals for the legacy relocation breakdown, without rewriting stored evidence. */
export function formatTotalCtc(value: string | null | undefined): string {
  const clean = value?.replace(/\*/g, '').trim() || '';
  const relocation = clean.match(/^(\d+(?:\.\d+)?)\s*LPA\s*\+\s*(?:up\s+to\s+)?₹?\s*(\d+(?:\.\d+)?)\s*(?:lakh|LPA)(?:\s+one-time)?\s+relocation\s+(?:assistance|allowance)$/i);
  if (!relocation) return clean;
  const total = Math.round((Number(relocation[1]) + Number(relocation[2])) * 100) / 100;
  return `${total} LPA`;
}
