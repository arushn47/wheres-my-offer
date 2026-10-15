/** Keep every distinct filename on each email, including unparsed documents. */
export function groupEmailAttachmentNames(rows: Array<{ college_email_id: string | null; filename: string | null }>): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const name = row.filename?.trim();
    if (!row.college_email_id || !name) continue;
    const names = grouped.get(row.college_email_id) || [];
    if (!names.includes(name)) names.push(name);
    grouped.set(row.college_email_id, names);
  }
  return grouped;
}
