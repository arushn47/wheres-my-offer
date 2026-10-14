export type EducationLevel = 'UG' | 'PG' | null;

/** Only recognise bachelor codes already supported by the student identity parser. */
export function inferEducationLevel(collegeEmail?: string | null): EducationLevel {
  const code = collegeEmail?.match(/\b\d{2}([A-Z]{3})\d{4,6}\b/i)?.[1].toUpperCase();
  return code && ['BCE', 'BCI', 'BCG', 'BAI', 'BDS', 'BSA', 'BEC', 'BEE', 'BME', 'BBI', 'BCL', 'BCH', 'BIT'].includes(code) ? 'UG' : null;
}

export function selectEducationCompensation(value: string | null | undefined, level: EducationLevel): string | null {
  if (!value) return null;
  if (!level) return value;
  return value.split(' · ').find(tier => tier.startsWith(`${level}:`)) || value;
}

/** Keep labelled packages separate; insurance is not annual salary. */
export function extractEducationCompensation(text: string): { ctc: string | null; stipend: string | null } {
  const ctcSection = text.match(/\bCTC\b\s*[:\-–—]?\s*([\s\S]*?)(?=\b(?:Stipend|Last\s+date|Website|Job\s+location|Registration|Eligibility)\b|$)/i)?.[1];
  const stipendSection = text.match(/\bStipend\b\s*[:\-–—]?\s*([\s\S]*?)(?=\b(?:CTC|Last\s+date|Website|Job\s+location|Registration|Eligibility)\b|$)/i)?.[1];
  function tiers(section: string | undefined, stipend: boolean): string | null {
    if (!section) return null;
    const labels = [...section.matchAll(/\b(UG|PG)\b\s*[:\-–—]?\s*/gi)];
    const values: string[] = [];
    for (let index = 0; index < labels.length; index++) {
      const label = labels[index];
      const piece = section.slice((label.index || 0) + label[0].length, labels[index + 1]?.index ?? section.length);
      const amount = stipend
        ? piece.match(/^(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(k|thousand)?\b/i)
        : piece.match(/^(?:INR|Rs\.?|₹)?\s*(\d+(?:\.\d+)?)\s*LPA\b/i);
      if (!amount) continue;
      const number = Number(amount[1].replace(/,/g, '')) * (stipend && amount[2] ? 1000 : 1);
      if (stipend ? number < 5000 || number > 500000 : number < 3 || number > 200) continue;
      let value = stipend ? `₹${number.toLocaleString('en-IN')}/month` : `${number} LPA`;
      if (!stipend) {
        const bonus = piece.match(/\+\s*(\d+(?:\.\d+)?)\s*(?:lakhs?|lacs?)\s+joining\s+bonus/i);
        if (bonus) value += ` + ${bonus[1]} lakh joining bonus`;
        if (/\bif\s+converted\b/i.test(piece)) value += ' (if converted)';
      }
      values.push(`${label[1].toUpperCase()}: ${value}`);
    }
    return values.length ? values.join(' · ') : null;
  }
  return { ctc: tiers(ctcSection, false), stipend: tiers(stipendSection, true) };
}
