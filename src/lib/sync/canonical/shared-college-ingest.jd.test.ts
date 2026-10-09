import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), fetch: vi.fn(), parse: vi.fn(), process: vi.fn(), venues: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mocks.from }) }));
vi.mock('@/lib/gmail/client', () => ({ fetchMessageDetail: mocks.fetch, createGmailClient: vi.fn() }));
vi.mock('@/lib/sync/classification/classifier', () => ({ classifyEmail: () => ({ classification: 'registration', confidence: 'high', companyName: 'EXL Service' }), isFuzzyCompanyMatch: () => false }));
vi.mock('@/lib/sync/recruitment/status-engine', () => ({ processEmailForEventsAndStatus: mocks.process }));
vi.mock('./shared-college-venues', () => ({ persistSharedCircularVenues: mocks.venues }));
vi.mock('@/lib/sync/extraction/pdf-parser', async importOriginal => ({ ...await importOriginal<object>(), parsePdfAttachment: mocks.parse }));
import { ingestSharedCollegeCircular } from './shared-college-ingest';
import { pdfRowsFromText } from '../extraction/pdf-parser';

const writes: Array<{ table: string; payload: Record<string, unknown> }> = [];
let cachedRows: unknown = null;
const drive = { id: 'drive', company_id: 'company', drive_name: 'EXL Service', drive_number: 'pat-PL-2026-1419', normalized_drive_number: 'pat-pl-2026-1419',
  source_college_email_id: null, role: 'Refer', location: 'Refer JD', ctc: null, stipend: null, companies: { name: 'EXL Service', aliases: [] } };
const received = '2026-10-09T07:00:00Z';
const personal = { id: 'receipt', user_id: 'user', placement_drive_id: 'drive', sender: 'noreply.cdcinfo@vitstudent.ac.in',
  subject: "Congratulations! You're Eligible for EXL Service Placement Drive", classification: 'registration', received_at: received };
let paired = true;
beforeEach(() => {
  vi.clearAllMocks(); writes.length = 0; cachedRows = null; paired = true;
  mocks.fetch.mockResolvedValue({ sender: 'CDC', senderEmail: 'vitlions2027@vitbhopal.ac.in', messageId: '<source@example.test>',
    subject: 'EXL Service Registration - pat-PL-2026-1419', receivedAt: new Date(received), gmailMessageId: 'gmail',
    bodyPlain: 'Job location: Refer JD\nDesignation: Associate Developer – Band A2', bodyHtml: '', bodySnippet: '',
    hasAttachments: true, attachments: [{ attachmentId: 'attachment', filename: 'EXL-JD.pdf', size: 100, mimeType: 'application/pdf' }] });
  mocks.parse.mockResolvedValue({ extractedRows: pdfRowsFromText(['Location\nNoida / Gurgaon / Pune / Bangalore']), parseStatus: 'complete', parseError: null });
  mocks.from.mockImplementation((table: string) => {
    const query = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), or: vi.fn().mockReturnThis(),
      update(payload: Record<string, unknown>) { writes.push({ table, payload }); return query; },
      upsert(payload: Record<string, unknown>) { writes.push({ table, payload }); if (table === 'college_attachments') cachedRows = payload.extracted_rows; return query; },
      maybeSingle: async () => ({ data: table === 'placement_drives' ? drive : null, error: null }),
      single: async () => ({ data: { id: 'source' }, error: null }),
      then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data:
        table === 'college_attachments' ? cachedRows ? [{ attachment_id: 'attachment', filename: 'EXL-JD.pdf', parse_status: 'complete', extracted_rows: cachedRows }] : []
          : table === 'personal_emails' && paired ? [personal] : [], error: null }).then(resolve); },
    };
    return query;
  });
});
const run = () => ingestSharedCollegeCircular({ account: {} as Parameters<typeof ingestSharedCollegeCircular>[0]['account'], gmailMessageId: 'gmail',
  gmail: { users: { messages: { attachments: { get: async () => ({ data: { data: Buffer.from('pdf bytes').toString('base64') } }) } } } } as unknown as Parameters<typeof ingestSharedCollegeCircular>[0]['gmail'] });

it('uses a freshly parsed JD for the initial canonical and drive metadata updates', async () => {
  await run();
  expect(mocks.parse).toHaveBeenCalledOnce();
  expect(writes.filter(write => write.table === 'college_emails').at(-1)?.payload.parsed_job_details).toMatchObject({
    role: 'Associate Developer – Band A2', location: 'Noida / Gurgaon / Pune / Bangalore',
  });
  expect(writes.find(write => write.table === 'placement_drives')?.payload).toMatchObject({
    role: 'Associate Developer – Band A2', location: 'Noida / Gurgaon / Pune / Bangalore',
  });
});
it('does not enrich a college-only registration drive without the personal announcement pair', async () => {
  paired = false;
  await run();
  expect(writes.some(write => write.table === 'placement_drives')).toBe(false);
  expect(mocks.process).not.toHaveBeenCalled();
});
