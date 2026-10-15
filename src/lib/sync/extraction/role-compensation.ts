/** Preserve the role attached to each explicitly stated stipend/package pair. */
export function extractRoleCompensation(text: string): { role: string; ctc: string; stipend: string } | null {
  const section = text.match(/\bRoles?\s*,\s*CTC\s*,\s*Stipend\s+details\s*:\s*([\s\S]*?)(?=\b(?:Job\s+location|JD|Registration|Mandatory\s+Note)\s*[:\-]|$)/i)?.[1];
  if (!section) return null;
  const rows = [...section.matchAll(/(?:^|\n)\s*([A-Za-z][A-Za-z &/().-]{2,90}?)\s*[-–—:]\s*(?:₹|INR|Rs\.?)?\s*([\d,]+(?:\.\d+)?)\s*(k|thousand)?\s+stipend\s*[-–—:]\s*(\d+(?:\.\d+)?)\s*(?:[-–—]|to)\s*(\d+(?:\.\d+)?)\s*LPA([^\n]*)/gi)]
    .map(match => ({ role: match[1].trim(), stipend: Number(match[2].replace(/,/g, '')) * (match[3] ? 1000 : 1),
      min: Number(match[4]), max: Number(match[5]), performance: /based\s+on\s+performance/i.test(match[6]) }))
    .filter(row => row.stipend >= 5000 && row.stipend <= 500000 && row.min >= 3 && row.max >= row.min && row.max <= 200);
  if (!rows.length) return null;
  const converted = /\bCTC\s*[:\-]?\s*check\s+below\s*\(?if\s+converted\)?/i.test(text);
  return {
    role: [...new Set(rows.map(row => row.role))].join(' / '),
    ctc: rows.map(row => `${row.role}: ${row.min} - ${row.max} LPA${converted ? ' (if converted)' : ''}${row.performance ? ' (based on performance)' : ''}`).join(' · '),
    stipend: rows.map(row => `${row.role}: ₹${row.stipend.toLocaleString('en-IN')}/month`).join(' · '),
  };
}
