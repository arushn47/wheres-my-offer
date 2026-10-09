import { expect, it, vi } from 'vitest';
import { loadCachedPdfAttachments } from './cached-pdf-attachments';
import { mergePdfJobDetails, pdfRowsFromText } from '../extraction/pdf-parser';
import { extractJobDetails } from '../extraction/events';

type Row = { id: string; college_email_id: string; filename: string; parse_status: string; extracted_rows: unknown };
function database(rows: Row[], failure?: Error) {
  const from = vi.fn(() => {
    let ids: string[] = [], first = 0, last = 999;
    const query = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn((_key: string, values: string[]) => { ids = values; return query; }),
      ilike: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
      range: vi.fn((start: number, end: number) => { first = start; last = end; return query; }),
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve({ data: rows.filter(row => ids.includes(row.college_email_id)
          && /\.pdf$/i.test(row.filename) && row.parse_status === 'complete').slice(first, last + 1), error: failure || null }).then(resolve);
      },
    };
    return query;
  });
  return { from } as unknown as Parameters<typeof loadCachedPdfAttachments>[0];
}
const row = (id: string, source: string, title: string): Row => ({ id, college_email_id: source, filename: 'JD.pdf', parse_status: 'complete',
  extracted_rows: pdfRowsFromText([`Job Title: ${title}`]) });

it('loads complete cached PDFs only for selected sources, keeping sibling roles separate', async () => {
  const db = database([row('1', 'ecolab', 'Engineering Intern'), row('2', 'exl', 'Associate Developer'),
    { ...row('3', 'ecolab', 'Wrong Analyst'), filename: 'shortlist.xlsx' },
    { ...row('4', 'ecolab', 'Wrong Developer'), parse_status: 'deferred' }]);
  const cache = await loadCachedPdfAttachments(db, ['ecolab', 'ecolab']);
  expect(cache.size).toBe(1);
  expect(mergePdfJobDetails(extractJobDetails('Designation: Refer JD'), cache.get('ecolab')).role).toBe('Engineering Intern');
  expect(cache.has('exl')).toBe(false);
  expect(db.from).toHaveBeenCalledOnce();
});
it('pages cached attachments past the database row cap', async () => {
  const db = database(Array.from({ length: 1001 }, (_, i) => row(String(i), 'source', 'Engineer')));
  const cache = await loadCachedPdfAttachments(db, ['source']);
  expect(cache.get('source')).toHaveLength(1001);
  expect(db.from).toHaveBeenCalledTimes(2);
});
it('does no reads for an empty scope and propagates failed reads instead of losing JD evidence', async () => {
  const failure = new Error('Read failed');
  const db = database([], failure);
  expect((await loadCachedPdfAttachments(db, [])).size).toBe(0);
  expect(db.from).not.toHaveBeenCalled();
  await expect(loadCachedPdfAttachments(db, ['source'])).rejects.toBe(failure);
});
