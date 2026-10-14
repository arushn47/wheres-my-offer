/** Keep a selected degree tier compact; unknown students still see both labelled tiers. */
export function formatCompensationLabel(value: string | null | undefined): string {
  const clean = value?.replace(/\*/g, '').trim() || '';
  if (clean === 'Check documents') return 'See docs';
  if (!/^(?:UG|PG):\s*/i.test(clean) || clean.includes(' · ')) return clean;
  const selected = clean.replace(/^(?:UG|PG):\s*/i, '');
  return selected.match(/^\d+(?:\.\d+)?\s*LPA\b/i)?.[0] || selected.replace(/\s*\(if converted\)/gi, '').trim();
}

/** Compact totals for the legacy relocation breakdown, without rewriting stored evidence. */
export function formatTotalCtc(value: string | null | undefined): string {
  const clean = formatCompensationLabel(value);
  const relocation = clean.match(/^(\d+(?:\.\d+)?)\s*LPA\s*\+\s*(?:up\s+to\s+)?₹?\s*(\d+(?:\.\d+)?)\s*(?:lakh|LPA)(?:\s+one-time)?\s+relocation\s+(?:assistance|allowance)$/i);
  if (!relocation) return clean;
  const total = Math.round((Number(relocation[1]) + Number(relocation[2])) * 100) / 100;
  return `${total} LPA`;
}
