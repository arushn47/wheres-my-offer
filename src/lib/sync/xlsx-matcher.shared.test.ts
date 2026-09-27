import { describe, expect, it } from 'vitest';
import { searchRollNumberInWorkbookRows } from './xlsx-matcher';

describe('shared workbook row matching', () => {
  it('matches a student ID against canonical rows without a Gmail fetch', () => {
    const result = searchRollNumberInWorkbookRows([
      {
        sheetName: 'Test Shortlist',
        rows: [
          ['Student Name', 'Registration Number', 'Venue'],
          ['A Student', '23BCE10472', 'PRP 717'],
          ['Another Student', '23BCE10473', 'SJT 703'],
        ],
      },
    ], '23BCE10472');

    expect(result.isMatched).toBe(true);
    expect(result.matchedValue).toBe('23BCE10472');
    expect(result.detectedIdColumnName).toBe('Registration Number');
    expect(result.additionalData?.Venue).toBe('PRP 717');
  });

  it('returns no match for a student absent from all cached rows', () => {
    const result = searchRollNumberInWorkbookRows([
      { sheetName: 'Shortlist', rows: [['Reg No'], ['23BCE10473']] },
    ], '23BCE10472');
    expect(result.isMatched).toBe(false);
  });
});
