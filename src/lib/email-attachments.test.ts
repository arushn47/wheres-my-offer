import { expect, it } from 'vitest';
import { groupEmailAttachmentNames } from './email-attachments';

it('preserves all PDFs and workbooks per email instead of overwriting earlier filenames', () => {
  const grouped = groupEmailAttachmentNames([
    { college_email_id: 'arrowhead', filename: 'Conversational_AI_JD.pdf' },
    { college_email_id: 'arrowhead', filename: 'Data_Analyst_JD.pdf' },
    { college_email_id: 'other', filename: 'CTC.xlsx' },
    { college_email_id: 'arrowhead', filename: 'QA_Engineer_JD.pdf' },
    { college_email_id: 'arrowhead', filename: 'Roles.xlsx' },
    { college_email_id: 'arrowhead', filename: 'Roles.xlsx' },
    { college_email_id: 'arrowhead', filename: ' ' },
    { college_email_id: null, filename: 'Unlinked.pdf' },
  ]);
  expect(grouped.get('arrowhead')).toEqual(['Conversational_AI_JD.pdf', 'Data_Analyst_JD.pdf', 'QA_Engineer_JD.pdf', 'Roles.xlsx']);
  expect(grouped.get('other')).toEqual(['CTC.xlsx']);
  expect(grouped.size).toBe(2);
});
