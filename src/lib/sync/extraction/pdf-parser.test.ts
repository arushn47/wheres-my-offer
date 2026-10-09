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

  it('fills EXL work locations from its JD table while preserving the circular designation', () => {
    const body = extractJobDetails('Job location: Refer JD\nDesignation: Associate Developer – Band A2');
    const merged = mergePdfJobDetails(body, [{ filename: 'EXL-JD.pdf', parseStatus: 'complete', extractedRows: pdfRowsFromText([
      'Position Title, Responsibility Level\nAssociate Developer (Band A2)\nFunction\nEXL - Data Management / Digital Engineering / AI Solutions\nLocation\nNoida / Gurgaon / Pune / Bangalore\n(as per EXL’s business requirements & management decision)\nEligibility\nB. Tech CS/IT',
    ]) }]);
    expect(merged.role).toBe('Associate Developer – Band A2');
    expect(merged.location).toBe('Noida / Gurgaon / Pune / Bangalore');
  });

  it('recognizes a JD position-title cell and replaces historical Refer fragments with real fields', () => {
    const body = { ...extractJobDetails(''), role: 'Refer', location: 'Refer JD' };
    const merged = mergePdfJobDetails(body, [{ filename: 'JD.pdf', parseStatus: 'complete', extractedRows: pdfRowsFromText([
      'Position Title, Responsibility Level\nAssociate Developer (Band A2)\nLocation: Noida / Gurgaon / Pune / Bangalore (as per business requirements)',
    ]) }]);
    expect(merged.role).toBe('Associate Developer');
    expect(merged.location).toBe('Noida / Gurgaon / Pune / Bangalore');
    expect(body.role).toBe('Refer');
  });

  it('retains a confirmed Pan India location while filling an Ecolab role only from its own JD', () => {
    const body = extractJobDetails('Job location: Pan India\nDesignation: Refer JD');
    const ownJd = { filename: 'Ecolab-JD.pdf', parseStatus: 'complete', extractedRows: pdfRowsFromText(['Job Title: Engineering Intern\nLocation: Chennai']) };
    expect(mergePdfJobDetails(body, [ownJd])).toMatchObject({ role: 'Engineering Intern', location: 'Pan India' });
    expect(mergePdfJobDetails(body, [])).toMatchObject({ role: null, location: 'Pan India' });
    expect(mergePdfJobDetails(body, [{ ...ownJd, parseStatus: 'deferred' }]).role).toBeNull();
  });

  it('uses the campus-drive fallback for Ecolab’s actual JD expectations without an explicit title', () => {
    const body = extractJobDetails('Job location: Pan India\nDesignation: Refer JD');
    const merged = mergePdfJobDetails(body, [{ filename: 'CampusRecruitment 2027-28.pdf', parseStatus: 'complete', extractedRows: pdfRowsFromText([
      'Analytics and Digital Solutions\nCampus Recruitment | 2027 – 28\nBuild a career in Enterprise AI\nAnalytics and Digital Solutions (ADS)\nRole Expectations\n• Entry-level position with 0 years of corporate experience\n• Strong grip on problem-solving, numerical reasoning and inductive reasoning skills\n• Exposure to Application development and deployment with any repository lineage in GitHub etc.\nEngineering\nStreams\nConceptual Understanding Must Possess Good to haves\nCS, IT, AI / Data Science, E&C\nEligibility: CGPA of 6 and above',
    ]) }]);
    expect(merged.role).toBeNull();
    expect(merged.location).toBe('Pan India');
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
