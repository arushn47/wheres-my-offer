import { expect, it, vi } from 'vitest';
import { planSyncPages } from './engine';

type Params = Parameters<typeof planSyncPages>;
const account = { id: 'personal-account' } as Params[2];

function database(options: { pending?: boolean; readError?: boolean; deleteError?: boolean; insertError?: boolean } = {}) {
  const pending = [{ id: 'saved-page', status: 'pending', message_ids: ['saved'] }];
  const removed: unknown[][] = [];
  const insert = vi.fn((rows: unknown[]) => ({
    select: () => ({ order: async () => ({
      data: options.insertError ? null : rows.map((row, i) => ({ ...row as object, id: `page-${i}` })),
      error: options.insertError ? { message: 'Insert unavailable' } : null,
    }) }),
  }));
  const remove = vi.fn(() => ({ eq: (field: string, value: string) => {
    removed.push([field, value]);
    return { eq: async (secondField: string, secondValue: string) => {
      removed.push([secondField, secondValue]);
      return { error: options.deleteError ? { message: 'Delete unavailable' } : null };
    } };
  } }));
  const admin = { from: () => ({
    select: () => ({ eq: () => ({ order: async () => ({
      data: options.pending ? pending : [],
      error: options.readError ? { message: 'Read unavailable' } : null,
    }) }) }),
    delete: remove, insert,
  }) } as unknown as Params[0];
  return { admin, insert, remove, removed, pending };
}

it('saves a single incoming email and removes only completed historical pages', async () => {
  const db = database();
  const pages = await planSyncPages(db.admin, 'user', account, ['incoming']);
  expect(pages[0].message_ids).toEqual(['incoming']);
  expect(db.removed).toEqual([['gmail_account_id', account.id], ['status', 'complete']]);
});

it('resumes a saved queue without replacing it with new discovery', async () => {
  const db = database({ pending: true });
  expect(await planSyncPages(db.admin, 'user', account, ['new'])).toEqual(db.pending);
  expect(db.remove).not.toHaveBeenCalled();
  expect(db.insert).not.toHaveBeenCalled();
});

it('fails before replacement when the saved queue cannot be read or cleaned up', async () => {
  for (const failure of [{ readError: true }, { deleteError: true }]) {
    const db = database(failure);
    await expect(planSyncPages(db.admin, 'user', account, ['new'])).rejects.toMatchObject({ message: expect.stringContaining('unavailable') });
    expect(db.insert).not.toHaveBeenCalled();
    if (failure.readError) expect(db.remove).not.toHaveBeenCalled();
  }
});

it('does not report discovery as durably saved when insertion fails', async () => {
  const db = database({ insertError: true });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(planSyncPages(db.admin, 'user', account, ['new'])).rejects.toThrow('Failed to plan sync pages');
  } finally { log.mockRestore(); }
});
