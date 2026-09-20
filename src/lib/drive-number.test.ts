import { describe, expect, it } from 'vitest';
import { normalizeDriveNumber as canonical } from './drive-number';
import { normalizeDriveNumber as fromLiveResolver } from './sync/drive-resolution';
import { normalizeDriveNumber as fromPhase3Resolver } from './migration/phase3/resolve-drive';

describe('normalizeDriveNumber — single source of truth', () => {
  it('the live sync-time resolver re-exports the exact same function as the canonical module', () => {
    expect(fromLiveResolver).toBe(canonical);
  });

  it('the Phase 3 migration resolver re-exports the exact same function as the canonical module', () => {
    // Regression guard: this used to be an independently copy-pasted implementation. If it ever
    // drifts back to a local copy, this identity check fails even before behavior diverges.
    expect(fromPhase3Resolver).toBe(canonical);
  });

  it('both call sites therefore agree on every case, by construction', () => {
    const samples = ['  R1  ', 'r1', null, undefined, '', '   ', 'Drive-2024/A'];
    for (const sample of samples) {
      expect(fromLiveResolver(sample)).toBe(fromPhase3Resolver(sample));
    }
  });
});
