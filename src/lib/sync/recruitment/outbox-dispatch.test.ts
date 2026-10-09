import { describe, expect, it, vi } from 'vitest';
import { withOwnedMutationLease } from '../lease-context';
import { coalesceRoundOutbox, noteRoundOutboxCommit, type OutboxDrainResult } from './outbox-dispatch';
const empty = (): OutboxDrainResult => ({ pendingDecisionIds: new Set(), retry: false });

describe('immediate outbox coalescing', () => {
  it('drains immediately when a pending elimination is repointed to a new current decision', async () => {
    const drain = vi.fn(async () => empty());
    await withOwnedMutationLease('alice', 'run', async () => {
      noteRoundOutboxCommit('alice', 'old', 'shortlist_absent:alice:drive'); await coalesceRoundOutbox('alice', drain);
      noteRoundOutboxCommit('alice', 'new', 'shortlist_absent:alice:drive'); await coalesceRoundOutbox('alice', drain);
      expect(drain).toHaveBeenCalledTimes(2);
      noteRoundOutboxCommit('alice', 'new', 'shortlist_absent:alice:drive'); await coalesceRoundOutbox('alice', drain);
      expect(drain).toHaveBeenCalledTimes(2);
    });
  });
  it('recovers once and skips duplicate completion drains; a new key drains immediately', async () => {
    const drain = vi.fn(async () => empty());
    await withOwnedMutationLease('alice', 'run', async () => {
      await Promise.all(Array.from({ length: 8 }, () => coalesceRoundOutbox('alice', drain)));
      await coalesceRoundOutbox('alice', drain);
      expect(drain).toHaveBeenCalledTimes(1);
      noteRoundOutboxCommit('alice', 'decision', 'round:one');
      await coalesceRoundOutbox('alice', drain);
      expect(drain).toHaveBeenCalledTimes(2);
      noteRoundOutboxCommit('alice', 'decision', 'round:one');
      await coalesceRoundOutbox('alice', drain);
      expect(drain).toHaveBeenCalledTimes(2);
    });
    await withOwnedMutationLease('alice', 'next-run', () => coalesceRoundOutbox('alice', drain));
    expect(drain).toHaveBeenCalledTimes(3);
  });
  it('drains a commit arriving during delivery once before concurrent callers resolve', async () => {
    let finish!: (value: OutboxDrainResult) => void;
    const drain = vi.fn().mockImplementationOnce(() => new Promise<OutboxDrainResult>(resolve => { finish = resolve; })).mockResolvedValue(empty());
    await withOwnedMutationLease('alice', 'run', async () => {
      const first = coalesceRoundOutbox('alice', drain);
      noteRoundOutboxCommit('alice', 'new', 'round:new');
      const second = coalesceRoundOutbox('alice', drain);
      const third = coalesceRoundOutbox('alice', drain);
      finish(empty());
      await Promise.all([first, second, third]);
      expect(drain).toHaveBeenCalledTimes(2);
    });
  });
  it('retries failed/incomplete delivery without a hot loop and revisits dormant decisions only when committed', async () => {
    const drain = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ pendingDecisionIds: new Set(['decision']), retry: true })
      .mockResolvedValueOnce({ pendingDecisionIds: new Set(['dormant']), retry: false }).mockResolvedValue(empty());
    await withOwnedMutationLease('alice', 'run', async () => {
      await expect(coalesceRoundOutbox('alice', drain)).rejects.toThrow('network');
      await coalesceRoundOutbox('alice', drain);
      expect(drain).toHaveBeenCalledTimes(2);
      await coalesceRoundOutbox('alice', drain);
      await coalesceRoundOutbox('alice', drain);
      expect(drain).toHaveBeenCalledTimes(3);
      noteRoundOutboxCommit('alice', 'dormant');
      await coalesceRoundOutbox('alice', drain);
      expect(drain).toHaveBeenCalledTimes(4);
    });
  });
  it('does not share state with a different user or outside the owning run', async () => {
    const drain = vi.fn(async () => empty());
    await withOwnedMutationLease('alice', 'run', async () => {
      await coalesceRoundOutbox('alice', drain);
      await coalesceRoundOutbox('bob', drain);
      await coalesceRoundOutbox('bob', drain);
    });
    await coalesceRoundOutbox('alice', drain);
    expect(drain).toHaveBeenCalledTimes(4);
  });
});
