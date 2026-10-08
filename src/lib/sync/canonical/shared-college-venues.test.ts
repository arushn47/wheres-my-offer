import { expect, it, vi } from 'vitest';
import { persistSharedCircularVenues } from './shared-college-venues';

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
