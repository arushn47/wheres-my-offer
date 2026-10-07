import { describe, expect, it } from 'vitest';
import { postSyncDriveScope, restrictEligibleDrives } from './post-sync-scope';

describe('incremental post-sync scope', () => {
  it('keeps a new-drive sync scoped instead of reopening every existing application', () => {
    const scope = postSyncDriveScope(false, ['new-drive', 'updated-drive', 'new-drive']);
    expect(scope).toEqual(['new-drive', 'updated-drive']);
    expect([...restrictEligibleDrives(new Set(['new-drive', 'old-drive']), scope)]).toEqual(['new-drive']);
  });

  it('retains a full scan for completed onboarding and missing processing context', () => {
    expect(postSyncDriveScope(true, ['new-drive'])).toBeUndefined();
    expect(postSyncDriveScope(false, [])).toBeUndefined();
    expect([...restrictEligibleDrives(new Set(['one', 'two']), undefined)]).toEqual(['one', 'two']);
  });

  it('never treats a requested but ineligible sibling as evidence of participation', () => {
    expect([...restrictEligibleDrives(new Set(['deloitte-a']), ['deloitte-b'])]).toEqual([]);
    expect([...restrictEligibleDrives(new Set(['deloitte-a']), [])]).toEqual([]);
  });
});
