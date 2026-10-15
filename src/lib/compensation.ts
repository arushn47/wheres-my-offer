/** Keep a selected degree tier compact; unknown students still see both labelled tiers. */
export function formatCompensationLabel(value: string | null | undefined): string {
  const clean = value?.replace(/\*/g, '').trim() || '';
  if (clean === 'Check documents') return 'See docs';
  // Keep card labels short; the original labelled role breakdown remains in the tooltip.
  const roleTiers = clean.split(' · ');
  if (roleTiers.length > 1 && roleTiers.every(tier => /^[A-Za-z][^:]+:/.test(tier) && !/^(UG|PG):/.test(tier))) {
    const annual = roleTiers.map(tier => tier.match(/:\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*LPA/i));
    if (annual.every(Boolean)) return `${Math.min(...annual.map(match => Number(match![1])))} - ${Math.max(...annual.map(match => Number(match![2])))} LPA`;
    const monthly = roleTiers.map(tier => tier.match(/:\s*₹([\d,]+)\/month/i));
    if (monthly.every(Boolean)) {
      const numbers = monthly.map(match => Number(match![1].replace(/,/g, '')));
      const min = Math.min(...numbers), max = Math.max(...numbers);
      return `₹${min.toLocaleString('en-IN')}${min === max ? '' : ` - ₹${max.toLocaleString('en-IN')}`}/month`;
    }
  }
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
