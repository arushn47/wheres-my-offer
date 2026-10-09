import { expect, it, vi } from 'vitest';
import { persistSharedCircularVenues } from './shared-college-venues';
import { pdfRowsFromText } from '../extraction/pdf-parser';

type Params = Parameters<typeof persistSharedCircularVenues>;
const drive: Params[1] = { id: 'drive', drive_number: 'pat-PL-2026-1413', normalized_drive_number: '1413', source_college_email_id: 'primary' };
const company = { name: 'Hitachi Energy', aliases: [] };
const email = { subject: 'Hitachi Energy online test', bodyPlain: 'Test venue: VIT Vellore campus', bodyHtml: '', bodySnippet: '', receivedAt: new Date('2026-10-08T12:00:00Z') } as Params[4];
function setup() {
  const rpc = vi.fn().mockResolvedValue({ error: null });
  return { rpc, admin: { rpc } as unknown as Params[0] };
}
const source = { id: 'later-source', numbers: ['pat-PL-2026-1413'], classification: 'test', companyName: 'Hitachi Energy' };

it('writes a numbered follow-up circular through the display-only merge', async () => {
  const { rpc, admin } = setup();
  await persistSharedCircularVenues(admin, drive, source, company, email);
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc.mock.calls[0]).toEqual(['merge_drive_recruitment_venues', expect.objectContaining({
    p_drive_id: 'drive', p_source_id: 'later-source',
    p_entries: [expect.objectContaining({ kind: 'campus', name: 'VIT Vellore' })],
  })]);
});
it('accepts an exact unnumbered primary anchor', async () => {
  const { rpc, admin } = setup();
  await persistSharedCircularVenues(admin, drive, { ...source, id: 'primary', numbers: [] }, company, email);
  expect(rpc).toHaveBeenCalledOnce();
});
it('persists the subject-only Tata interview venue only for its exact primary registration source', async () => {
  const { rpc, admin } = setup();
  const tata = { name: 'Tata Technologies Dream Core', aliases: [] };
  const registration = { ...email, subject: 'Tata Technologies Dream core placement registration 2027 Batch - Physical interview at vellore campus', bodyPlain: 'Date of Visit:\nwill be informed later' };
  await persistSharedCircularVenues(admin, drive, { ...source, id: 'primary', numbers: [], classification: 'registration', companyName: tata.name }, tata, registration);
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc.mock.calls[0]).toEqual(['merge_drive_recruitment_venues', expect.objectContaining({
    p_drive_id: drive.id, p_source_id: 'primary',
    p_entries: [expect.objectContaining({ stage: 'Interviews', kind: 'campus', name: 'VIT Vellore', quote: registration.subject })],
  })]);
  rpc.mockClear();
  await persistSharedCircularVenues(admin, { ...drive, id: 'sibling', source_college_email_id: 'other-source' }, { ...source, id: 'primary', numbers: [], classification: 'registration', companyName: tata.name }, tata, registration);
  expect(rpc).not.toHaveBeenCalled();
});
it.each(['EXL Service', 'Ecolab'])('persists the virtual visit from the matched %s registration circular', async name => {
  const { rpc, admin } = setup();
  await persistSharedCircularVenues(admin, drive, { ...source, id: 'primary', numbers: [], classification: 'registration', companyName: name }, { name, aliases: [] }, {
    ...email, subject: `${name} Registration`, bodyPlain: 'Date of Visit:\n\n*Virtual*\n\nEligible Branches\nB. Tech',
  });
  expect(rpc.mock.calls[0]).toEqual(['merge_drive_recruitment_venues', expect.objectContaining({
    p_source_id: 'primary', p_entries: [expect.objectContaining({ stage: 'Recruitment', kind: 'online', name: 'Online' })],
  })]);
});
it('rejects company-only matches, pooled numbers, irrelevant mail and contradictory companies', async () => {
  const { rpc, admin } = setup();
  for (const candidate of [
    { ...source, numbers: [] },
    { ...source, numbers: ['1413', '1407'] },
    { ...source, classification: 'irrelevant' },
    { ...source, companyName: 'Chargebee' },
  ]) await persistSharedCircularVenues(admin, drive, candidate, company, email);
  expect(rpc).not.toHaveBeenCalled();
});
it('never infers home attendance merely from an online test platform', async () => {
  const { rpc, admin } = setup();
  await persistSharedCircularVenues(admin, drive, source, company, { ...email, bodyPlain: 'Online test on HackerRank.' });
  expect(rpc).not.toHaveBeenCalled();
});
it('reuses an Infosys assessment PDF for venues without reading an unrelated sibling or roster', async () => {
  const { rpc, admin } = setup();
  const infosys = { name: 'Infosys', aliases: [] };
  const ownDrive = { ...drive, drive_number: 'pat-pl-2026-1338', normalized_drive_number: 'pat-pl-2026-1338' };
  const circular = { ...email, subject: 'Infosys Regular Offer Registration 2027 Batch.', bodyPlain:
    'Our recruitment program will be conducted in person on your campus.', attachments: [
      { filename: 'Assessment Guidelines - Campus Hiring.pdf', parseStatus: 'complete' as const,
        extractedRows: pdfRowsFromText(['GENERAL GUIDELINES\n1. Test will be conducted in various labs in college campuses']) },
      { filename: 'roster.xlsx', parseStatus: 'complete' as const, extractedRows: pdfRowsFromText(['Interviews will be held at VIT Vellore.']) },
    ] } as Params[4];
  await persistSharedCircularVenues(admin, ownDrive, { ...source, companyName: 'Infosys', numbers: ['pat-pl-2026-1338'] }, infosys, circular);
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc.mock.calls[0][1].p_entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: 'Recruitment', kind: 'respective' }),
    expect.objectContaining({ stage: 'Test', kind: 'respective' }),
  ]));
  expect(rpc.mock.calls[0][1].p_entries.some((entry: { name: string }) => entry.name === 'VIT Vellore')).toBe(false);
  rpc.mockClear();
  await persistSharedCircularVenues(admin, { ...ownDrive, drive_number: 'pat-pl-2026-1078', normalized_drive_number: 'pat-pl-2026-1078' }, { ...source, companyName: 'Infosys', numbers: ['pat-pl-2026-1338'] }, infosys, circular);
  expect(rpc).not.toHaveBeenCalled();
});
it('preserves an explicit body round over general PDF guidance and ignores deferred PDFs', async () => {
  const { rpc, admin } = setup();
  await persistSharedCircularVenues(admin, drive, source, company, { ...email, bodyPlain: 'Test venue: VIT Vellore campus', attachments: [
    { filename: 'Assessment.pdf', parseStatus: 'complete', extractedRows: pdfRowsFromText(['Test will be conducted in various labs in college campuses']) },
    { filename: 'Interview.pdf', parseStatus: 'deferred', extractedRows: pdfRowsFromText(['Interviews will be held at VIT Chennai.']) },
  ] } as Params[4]);
  expect(rpc.mock.calls[0][1].p_entries).toEqual([expect.objectContaining({ stage: 'Test', kind: 'campus', name: 'VIT Vellore' })]);
});
it('persists both UBS attendance rounds only to #1114, never its #1368 sibling', async () => {
  const { rpc, admin } = setup();
  const ubs = { name: 'UBS', aliases: ['ubs', 'pat-PL-2026-1114', 'pat-PL-2026-1368'] };
  const update = { ...source, numbers: ['pat-PL-2026-1114'], classification: 'registration', companyName: 'UBS' };
  const ubsDrive = { ...drive, drive_number: 'pat-PL-2026-1114', normalized_drive_number: '1114' };
  const circular = { ...email, subject: 'Update: UBS- Super Dream Internship / Placement - 2027 Batch', bodyPlain:
    'Date of Visit:\n17-08-2026 - PPT Virtual mode\n19-08-2026 - Physical process at Chennai campus (For all)\nJob Location: Pune / Hyderabad' };
  await persistSharedCircularVenues(admin, ubsDrive, update, ubs, circular);
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc.mock.calls[0][1].p_entries).toEqual([
    expect.objectContaining({ stage: 'PPT', kind: 'online' }),
    expect.objectContaining({ stage: 'Physical Process', kind: 'campus', name: 'VIT Chennai' }),
  ]);
  rpc.mockClear();
  await persistSharedCircularVenues(admin, { ...ubsDrive, id: 'ubs-sibling', drive_number: 'pat-PL-2026-1368', normalized_drive_number: '1368' }, update, ubs, circular);
  expect(rpc).not.toHaveBeenCalled();
});
