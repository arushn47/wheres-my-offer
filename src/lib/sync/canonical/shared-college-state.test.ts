import { describe, expect, it } from 'vitest';
import { getInitialArchivePageState, isSharedArchiveComplete } from './shared-college-state';

describe('shared College initial archive cursor', () => {
  it('completes an empty one-page mailbox instead of listing it forever', () => {
    expect(getInitialArchivePageState({
      initial_scan_complete: false,
      next_page_token: null,
      pending_next_page_token: null,
    })).toEqual({
      isInitialArchiveScan: true,
      completingPendingInitialPage: false,
      completingLastInitialPage: true,
    });
  });

  it('does not mark a multi-page archive complete until its last page', () => {
    expect(getInitialArchivePageState({
      initial_scan_complete: false,
      next_page_token: 'page-2',
      pending_next_page_token: null,
    }).completingLastInitialPage).toBe(true);
    expect(getInitialArchivePageState({
      initial_scan_complete: false,
      next_page_token: 'page-2',
      pending_next_page_token: 'page-3',
    })).toEqual({
      isInitialArchiveScan: true,
      completingPendingInitialPage: true,
      completingLastInitialPage: false,
    });
  });

  it('keeps the initial scan complete when no cursor remains', () => {
    expect(getInitialArchivePageState({
      initial_scan_complete: true,
      next_page_token: null,
      pending_next_page_token: null,
    })).toEqual({
      isInitialArchiveScan: false,
      completingPendingInitialPage: false,
      completingLastInitialPage: false,
    });
  });

  it('resumes a persisted page cursor even if the completion flag was set early', () => {
    expect(getInitialArchivePageState({
      initial_scan_complete: true,
      next_page_token: 'remaining-page',
      pending_next_page_token: null,
    })).toEqual({
      isInitialArchiveScan: true,
      completingPendingInitialPage: false,
      completingLastInitialPage: true,
    });
  });
});

describe('shared archive verification readiness', () => {
  it('allows absence verification only after every initial page and worker batch completes', () => {
    expect(isSharedArchiveComplete({ initial_scan_complete: true, next_page_token: null, is_syncing: false, pending_count: 0 })).toBe(true);
    expect(isSharedArchiveComplete({ initial_scan_complete: true, next_page_token: 'page-2', is_syncing: false, pending_count: 0 })).toBe(false);
    expect(isSharedArchiveComplete({ initial_scan_complete: false, next_page_token: null, is_syncing: false, pending_count: 0 })).toBe(false);
    expect(isSharedArchiveComplete({ initial_scan_complete: true, next_page_token: null, is_syncing: false, pending_count: 3 })).toBe(false);
    expect(isSharedArchiveComplete(null)).toBe(false);
  });

  it('is not defeated by the worker lease or by a crashed worker that never released it', () => {
    // A running sweep (or a stale lock from a killed worker) only ever adds rows:
    // it must not silently disable absence verification, otherwise every negative
    // status is retracted to `applied` for as long as the flag is stuck.
    expect(isSharedArchiveComplete({ initial_scan_complete: true, next_page_token: null, is_syncing: true, pending_count: 0 })).toBe(true);
    expect(isSharedArchiveComplete({ initial_scan_complete: true, next_page_token: null, is_syncing: true, pending_count: 4 })).toBe(false);
  });
});
