import { expect, it } from 'vitest';
import { buildExtractionProvenance } from './extraction-provenance';
import { pdfRowsFromText } from './pdf-parser';

it('attributes a JD-derived work location to its own circular while preserving body role evidence', () => {
  const source = { id: 'source', college_email_id: 'canonical', received_at: '2026-10-09T07:00:00Z',
    body_text: 'Designation: Associate Developer – Band A2\nJob location: Refer JD',
    attachments: [{ filename: 'JD.pdf', parseStatus: 'complete', extractedRows: pdfRowsFromText(['Location: Noida / Gurgaon / Pune / Bangalore']) }] };
  expect(buildExtractionProvenance([source], { role: 'Associate Developer – Band A2', location: 'Noida / Gurgaon / Pune / Bangalore' })).toMatchObject({
    role: { sourceEmailId: 'canonical', confidence: 'parsed' }, location: { sourceEmailId: 'canonical', confidence: 'parsed' },
  });
});
