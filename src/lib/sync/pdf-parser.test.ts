import { describe, expect, it } from 'vitest';
import { mergePdfJobDetails, pdfRowsFromText, isPdfAttachment } from './pdf-parser';
import { extractJobDetails } from './events';

describe('pdf-parser', () => {
  it('recognizes PDF filenames only', () => {
    expect(isPdfAttachment('JD.pdf')).toBe(true);
    expect(isPdfAttachment('JD.PDF')).toBe(true);
    expect(isPdfAttachment('roster.xlsx')).toBe(false);
    expect(isPdfAttachment('image.png')).toBe(false);
  });

  it('wraps page text in the workbook-shaped rows payload', () => {
    const rows = pdfRowsFromText(['Page one text', '', 'Page two text']);
    expect(rows).toEqual([
      { sheetName: 'pdf_text', rows: [['Page one text'], ['Page two text']] },
    ]);
  });

  it('fills body gaps with details extracted from parsed PDF text', () => {
    const bodyDetails = extractJobDetails('Designation: GET\nRegistration closes 30th September 2026.');
    expect(bodyDetails.ctc).toBeNull();

    const merged = mergePdfJobDetails(bodyDetails, [
      {
        filename: 'Tata-Technologies-JD.pdf',
        parseStatus: 'complete',
        extractedRows: pdfRowsFromText(['Compensation: 7.5 LPA\nJob location: Pune / Bangalore']),
      },
    ]);
    expect(merged.role).toBe('GET');
    expect(merged.ctc).toBe('7.5 LPA');
  });

  it('never overwrites body-derived values with PDF values', () => {
    const bodyDetails = extractJobDetails('CTC: 6.5 LPA');
    const merged = mergePdfJobDetails(bodyDetails, [
      {
        filename: 'JD.pdf',
        parseStatus: 'complete',
        extractedRows: pdfRowsFromText(['CTC: 20 LPA']),
      },
    ]);
    expect(merged.ctc).toBe('6.5 LPA');
  });

  it('ignores deferred, failed, and non-PDF attachments', () => {
    const bodyDetails = extractJobDetails('Designation: GET');
    const unchanged = mergePdfJobDetails(bodyDetails, [
      { filename: 'scanned.pdf', parseStatus: 'deferred', extractedRows: null },
      { filename: 'roster.xlsx', parseStatus: 'complete', extractedRows: pdfRowsFromText(['CTC: 20 LPA']) },
      { filename: 'broken.pdf', parseStatus: 'error', extractedRows: null },
      undefined,
    ]);
    expect(unchanged.ctc).toBeNull();
  });

  it('returns the input untouched when no attachments exist', () => {
    const bodyDetails = extractJobDetails('CTC: 6.5 LPA');
    expect(mergePdfJobDetails(bodyDetails, [])).toBe(bodyDetails);
    expect(mergePdfJobDetails(bodyDetails, undefined)).toBe(bodyDetails);
  });
});
