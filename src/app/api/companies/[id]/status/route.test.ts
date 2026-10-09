import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), from: vi.fn(), update: vi.fn(), reconcile: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getSession: mocks.session }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mocks.from }) }));
vi.mock('@/lib/calendar/google-sync', () => ({ reconcileUserGoogleCalendar: mocks.reconcile }));
import { PATCH } from './route';
const companyId = '10000000-0000-4000-8000-000000000001';
const driveId = '20000000-0000-4000-8000-000000000002';
const appId = '30000000-0000-4000-8000-000000000003';
const caller = '40000000-0000-4000-8000-000000000004';
const params = { params: Promise.resolve({ id: companyId }) };
const request = (body: unknown) => new Request(`https://example.test/api/companies/${companyId}/status`, { method: 'PATCH', body: JSON.stringify(body) });
let owned: { id: string } | null;
let ownerFilters: Record<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks(); owned = { id: appId }; ownerFilters = {};
  mocks.session.mockResolvedValue({ userId: caller });
  mocks.reconcile.mockResolvedValue({});
  mocks.from.mockImplementation((table: string) => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((key: string, value: unknown) => { if (table === 'applications') ownerFilters[key] = value; return query; }),
      maybeSingle: vi.fn(async () => ({ data: table === 'placement_drives' ? { id: driveId, company_id: companyId } : owned, error: null })),
      update: mocks.update.mockImplementation(() => query),
      single: vi.fn(async () => ({ data: { id: appId, user_id: caller, status: 'applied' }, error: null })),
    };
    return query;
  });
});
it('rejects an unauthenticated update before reading any records', async () => {
  mocks.session.mockResolvedValue(null);
  expect((await PATCH(request({ status: 'applied' }), params)).status).toBe(401);
  expect(mocks.from).not.toHaveBeenCalled();
});
it('does not allow a drive without an owned application to be changed', async () => {
  owned = null;
  expect((await PATCH(request({ status: 'applied', placement_drive_id: driveId }), params)).status).toBe(404);
  expect(ownerFilters).toMatchObject({ user_id: caller, placement_drive_id: driveId });
  expect(mocks.update).not.toHaveBeenCalled();
});
it('rejects another application ID and malformed input', async () => {
  expect((await PATCH(request({ status: 'applied', placement_drive_id: driveId, application_id: companyId }), params)).status).toBe(404);
  expect((await PATCH(request({ status: { injected: true } }), params)).status).toBe(400);
  expect(mocks.update).not.toHaveBeenCalled();
});
it('updates an owned application with the caller identity and keeps calendar reconciliation', async () => {
  expect((await PATCH(request({ status: 'applied', placement_drive_id: driveId, application_id: appId, user_id: 'victim' }), params)).status).toBe(200);
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ user_id: caller, status: 'applied' }));
  expect(ownerFilters).toMatchObject({ id: appId, user_id: caller });
  await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith(caller));
});
