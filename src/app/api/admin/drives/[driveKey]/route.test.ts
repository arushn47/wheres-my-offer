import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { from, update, inIds } = vi.hoisted(() => ({ from: vi.fn(), update: vi.fn(), inIds: vi.fn() }));
vi.mock('@/lib/auth/admin', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from }) }));
import { PATCH } from './route';
import { getDriveDisplayName } from '@/lib/drive-display';

it('displays the India drive independently of a legacy EY SAP parent label', () => {
  expect(getDriveDisplayName('EY INDIA', 'EY SAP')).toBe('EY India');
  expect(getDriveDisplayName('EY SAP', 'EY (Ernst & Young)')).toBe('EY SAP');
});

it('renames the selected drive without renaming its parent employer or sibling drives', async () => {
  const drive = { id: 'india-drive', company_id: 'ey-parent', drive_number: '1445', drive_name: 'EY INDIA' };
  inIds.mockResolvedValue({ error: null });
  update.mockReturnValue({ in: inIds });
  from.mockImplementation(table => {
    if (table !== 'placement_drives') throw new Error(`Unexpected parent/sibling table write: ${table}`);
    return { select: () => ({ or: () => Promise.resolve({ data: [drive], error: null }) }), update };
  });
  const response = await PATCH(new NextRequest('http://localhost/api/admin/drives/drive%3A1445', {
    method: 'PATCH', body: JSON.stringify({ companyName: 'EY India' }),
    headers: { 'Content-Type': 'application/json' },
  }), { params: Promise.resolve({ driveKey: 'drive:1445' }) });
  expect(response.status).toBe(200);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ drive_name: 'EY India' }));
  expect(inIds).toHaveBeenCalledWith('id', ['india-drive']);
  expect(from).not.toHaveBeenCalledWith('companies');
});
