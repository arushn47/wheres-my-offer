import { describe, expect, it, vi } from 'vitest';
import { runPhase3Migration } from './run';
import type {
  ApplicationRow,
  CandidateMatchRow,
  EmailRow,
  EventRow,
  NotificationRow,
  Phase3DiscoveryReader,
} from './discovery';
import type { ApplyUserActionsResult, Phase3RpcClient, PreflightCheckRow } from './rpc-client';
import type { RpcAction } from './assign';
import type { TenantDriveRecord } from './types';

const REAL_UUID = '123e4567-e89b-42d3-a456-426614174000';

interface FixtureUserData {
  drives: TenantDriveRecord[];
  emails: EmailRow[];
  applications: ApplicationRow[];
  events: EventRow[];
  notifications: NotificationRow[];
  candidateMatches: CandidateMatchRow[];
}

function emptyFixture(): FixtureUserData {
  return { drives: [], emails: [], applications: [], events: [], notifications: [], candidateMatches: [] };
}

function makeFakeReader(byUser: Record<string, FixtureUserData>): Phase3DiscoveryReader {
  const get = (userId: string) => byUser[userId] || emptyFixture();
  return {
    listUserDrives: async (userId) => get(userId).drives,
    listUserEmails: async (userId) => get(userId).emails,
    listUserApplications: async (userId) => get(userId).applications,
    listLegacyEvents: async (userId) => get(userId).events,
    listLegacyNotifications: async (userId) => get(userId).notifications,
    listLegacyCandidateMatches: async (userId) => get(userId).candidateMatches,
  };
}

function makeFakeRpcClient(opts?: {
  preflightRows?: PreflightCheckRow[];
  applyUserActions?: (userId: string, actions: RpcAction[]) => Promise<ApplyUserActionsResult>;
}): Phase3RpcClient & { calls: Array<{ userId: string; actions: RpcAction[] }> } {
  const calls: Array<{ userId: string; actions: RpcAction[] }> = [];
  return {
    calls,
    preflightReport: vi.fn(async () => opts?.preflightRows || [{ checkName: 'ok', status: 'PASS', details: '' }]),
    applyUserActions: async (userId, actions) => {
      calls.push({ userId, actions });
      if (opts?.applyUserActions) return opts.applyUserActions(userId, actions);
      return {
        committed: true,
        applied: actions.map((a) => ({ recordType: a.record_type, recordId: a.record_id, driveId: 'd' })),
        skippedAlreadyMigratedConcurrently: [],
        conflicts: [],
        drivesCreated: [],
        drivesReused: [],
      };
    },
  };
}

describe('runPhase3Migration — dry-run never writes', () => {
  it('does not call applyUserActions at all in dry-run mode', async () => {
    const reader = makeFakeReader({
      'user-a': {
        ...emptyFixture(),
        applications: [{ id: 'app-1', userId: 'user-a', companyId: 'c1', placementDriveId: null }],
      },
    });
    const rpcClient = makeFakeRpcClient();

    const summary = await runPhase3Migration({ reader, rpcClient, userIds: ['user-a'], mode: 'dry-run' });

    expect(rpcClient.calls).toHaveLength(0);
    expect(summary.readOnly).toBe(true);
    expect(summary.users[0].outcome.kind).toBe('dry_run');
  });

  it('defaults to dry-run when mode is omitted', async () => {
    const reader = makeFakeReader({});
    const rpcClient = makeFakeRpcClient();
    const summary = await runPhase3Migration({ reader, rpcClient, userIds: ['user-a'] });
    expect(summary.mode).toBe('dry-run');
    expect(rpcClient.calls).toHaveLength(0);
  });

  it('still calls the read-only preflight report in dry-run mode', async () => {
    const reader = makeFakeReader({});
    const rpcClient = makeFakeRpcClient();
    await runPhase3Migration({ reader, rpcClient, userIds: ['user-a'], mode: 'dry-run' });
    expect(rpcClient.preflightReport).toHaveBeenCalledTimes(1);
  });
});

describe('runPhase3Migration — execute mode', () => {
  it('sends exactly the writable actions (assign/create) to the RPC, never the no-op ones', async () => {
    const reader = makeFakeReader({
      'user-a': {
        ...emptyFixture(),
        drives: [
          { id: REAL_UUID, userId: 'user-a', companyId: 'c1', normalizedDriveNumber: 'pat-pl-2026-1', identityState: 'assigned' },
        ],
        applications: [
          { id: 'app-assign', userId: 'user-a', companyId: 'c1', placementDriveId: null },
          { id: 'app-already', userId: 'user-a', companyId: 'c1', placementDriveId: 'existing' },
          { id: 'app-unresolved', userId: 'user-a', companyId: 'c2', placementDriveId: null },
        ],
        emails: [
          { id: 'email-r1', userId: 'user-a', companyId: 'c1', placementDriveId: null, subject: 'pat-PL-2026-1', bodySnippet: null },
        ],
      },
    });
    const rpcClient = makeFakeRpcClient();

    const summary = await runPhase3Migration({ reader, rpcClient, userIds: ['user-a'], mode: 'execute' });

    expect(rpcClient.calls).toHaveLength(1);
    const sentActionTypes = rpcClient.calls[0].actions.map((a) => `${a.record_type}:${a.action}`).sort();
    // Only the email has explicit drive evidence. The company-only application
    // remains unresolved and must not borrow the sibling email's drive.
    expect(sentActionTypes).toContain('email:assign_existing_drive');
    expect(sentActionTypes.some((t) => t.startsWith('application:'))).toBe(false);
    // The already-migrated and unresolved records must never appear in the RPC payload.
    const sentRecordIds = rpcClient.calls[0].actions.map((a) => a.record_id);
    expect(sentRecordIds).not.toContain('app-already');
    expect(sentRecordIds).not.toContain('app-unresolved');

    expect(summary.users[0].outcome.kind).toBe('committed');
  });

  it('skips a user entirely (no RPC call) when they have no writable actions', async () => {
    const reader = makeFakeReader({
      'user-a': {
        ...emptyFixture(),
        applications: [{ id: 'app-1', userId: 'user-a', companyId: 'c1', placementDriveId: 'already-migrated' }],
      },
    });
    const rpcClient = makeFakeRpcClient();
    const summary = await runPhase3Migration({ reader, rpcClient, userIds: ['user-a'], mode: 'execute' });

    expect(rpcClient.calls).toHaveLength(0);
    expect(summary.users[0].outcome).toEqual({ kind: 'skipped', reason: 'no writable actions for this user' });
  });
});

describe('runPhase3Migration — idempotent reruns', () => {
  it('produces zero writable actions on a second run once everything is already migrated', async () => {
    const reader = makeFakeReader({
      'user-a': {
        ...emptyFixture(),
        applications: [{ id: 'app-1', userId: 'user-a', companyId: 'c1', placementDriveId: null }],
        drives: [{ id: REAL_UUID, userId: 'user-a', companyId: 'c1', normalizedDriveNumber: 'pat-pl-2026-1', identityState: 'assigned' }],
        emails: [{ id: 'email-r1', userId: 'user-a', companyId: 'c1', placementDriveId: null, subject: 'pat-PL-2026-1', bodySnippet: null }],
      },
    });
    const rpcClient = makeFakeRpcClient();

    // First run: assigns app-1.
    const run1 = await runPhase3Migration({ reader, rpcClient, userIds: ['user-a'], mode: 'execute' });
    expect(run1.users[0].outcome.kind).toBe('committed');
    expect(rpcClient.calls).toHaveLength(1);

    // Second run against the SAME (unchanged) fixture — app-1 still shows placementDriveId: null
    // in the fixture because this fake reader doesn't mutate state, but planning is still
    // deterministic and idempotency is enforced at the SQL layer (`WHERE placement_drive_id IS
    // NULL`). Simulate a rerun against data that DOES reflect the prior commit:
    reader.listUserApplications = async () => [
      { id: 'app-1', userId: 'user-a', companyId: 'c1', placementDriveId: REAL_UUID },
    ];
    reader.listUserEmails = async () => [
      { id: 'email-r1', userId: 'user-a', companyId: 'c1', placementDriveId: REAL_UUID, subject: 'pat-PL-2026-1', bodySnippet: null },
    ];
    const run2 = await runPhase3Migration({ reader, rpcClient, userIds: ['user-a'], mode: 'execute' });

    expect(run2.users[0].outcome).toEqual({ kind: 'skipped', reason: 'no writable actions for this user' });
    expect(rpcClient.calls).toHaveLength(1); // no second RPC call was made
  });
});

describe('runPhase3Migration — transaction rollback surfaces cleanly', () => {
  it('reports a rolled_back outcome (not a thrown error) when the RPC reports committed:false', async () => {
    const reader = makeFakeReader({
      'user-a': {
        ...emptyFixture(),
        applications: [{ id: 'app-1', userId: 'user-a', companyId: 'c1', placementDriveId: null }],
        drives: [{ id: REAL_UUID, userId: 'user-a', companyId: 'c1', normalizedDriveNumber: 'pat-pl-2026-1', identityState: 'assigned' }],
        emails: [{ id: 'email-r1', userId: 'user-a', companyId: 'c1', placementDriveId: null, subject: 'pat-PL-2026-1', bodySnippet: null }],
      },
    });
    const rpcClient = makeFakeRpcClient({
      applyUserActions: async () => ({
        committed: false,
        applied: [],
        skippedAlreadyMigratedConcurrently: [],
        conflicts: [],
        drivesCreated: [],
        drivesReused: [],
        error: 'post-condition failed: duplicate drive-owned applications',
      }),
    });

    const summary = await runPhase3Migration({ reader, rpcClient, userIds: ['user-a'], mode: 'execute' });

    expect(summary.users[0].outcome.kind).toBe('rolled_back');
    expect(summary.totals.usersRolledBack).toBe(1);
    expect(summary.totals.usersCommitted).toBe(0);
  });
});

describe('runPhase3Migration — global preflight gating', () => {
  it('aborts before processing any user when the preflight is BLOCKED, in execute mode', async () => {
    const reader = makeFakeReader({
      'user-a': {
        ...emptyFixture(),
        applications: [{ id: 'app-1', userId: 'user-a', companyId: 'c1', placementDriveId: null }],
      },
    });
    const rpcClient = makeFakeRpcClient({
      preflightRows: [{ checkName: 'applications.drive_ownership', status: 'BLOCKED', details: 'bad data' }],
    });

    const summary = await runPhase3Migration({ reader, rpcClient, userIds: ['user-a', 'user-b'], mode: 'execute' });

    expect(rpcClient.calls).toHaveLength(0);
    expect(summary.users.every((u) => u.outcome.kind === 'skipped')).toBe(true);
    expect(summary.preflight.status).toBe('BLOCKED');
  });

  it('does NOT gate dry-run mode on a BLOCKED preflight (dry-run should still show you the plan)', async () => {
    const reader = makeFakeReader({
      'user-a': {
        ...emptyFixture(),
        applications: [{ id: 'app-1', userId: 'user-a', companyId: 'c1', placementDriveId: null }],
      },
    });
    const rpcClient = makeFakeRpcClient({
      preflightRows: [{ checkName: 'x', status: 'BLOCKED', details: 'bad data' }],
    });

    const summary = await runPhase3Migration({ reader, rpcClient, userIds: ['user-a'], mode: 'dry-run' });
    expect(summary.users[0].outcome.kind).toBe('dry_run');
  });
});

describe('runPhase3Migration — tenant isolation across users', () => {
  it('never mixes one user\'s drives/records into another user\'s plan, even when both share a normalized drive number', async () => {
    const reader = makeFakeReader({
      'user-a': {
        ...emptyFixture(),
        applications: [{ id: 'app-a', userId: 'user-a', companyId: 'c1', placementDriveId: null }],
        emails: [{ id: 'email-a', userId: 'user-a', companyId: 'c1', placementDriveId: null, subject: 'pat-PL-2026-1', bodySnippet: null }],
      },
      'user-b': {
        ...emptyFixture(),
        applications: [{ id: 'app-b', userId: 'user-b', companyId: 'c9', placementDriveId: null }],
        emails: [{ id: 'email-b', userId: 'user-b', companyId: 'c9', placementDriveId: null, subject: 'pat-PL-2026-1', bodySnippet: null }],
      },
    });
    const rpcClient = makeFakeRpcClient();

    const summary = await runPhase3Migration({ reader, rpcClient, userIds: ['user-a', 'user-b'], mode: 'execute' });

    expect(rpcClient.calls).toHaveLength(2);
    const userACall = rpcClient.calls.find((c) => c.userId === 'user-a')!;
    const userBCall = rpcClient.calls.find((c) => c.userId === 'user-b')!;
    expect(userACall.actions.every((a) => a.user_id === 'user-a')).toBe(true);
    expect(userBCall.actions.every((a) => a.user_id === 'user-b')).toBe(true);
    expect(summary.totals.distinctDrivesWouldCreateOrCreated).toBe(2); // same drive number, two distinct users
  });

  it('isolates a single bad user\'s planning failure without aborting the whole batch', async () => {
    const reader = makeFakeReader({
      'user-bad': {
        ...emptyFixture(),
        // Two different companies both claiming to create the SAME normalized drive number —
        // planDriveCreations() must throw for this user.
        applications: [
          { id: 'app-1', userId: 'user-bad', companyId: 'c1', placementDriveId: null },
          { id: 'app-2', userId: 'user-bad', companyId: 'c2', placementDriveId: null },
        ],
        emails: [
          { id: 'email-1', userId: 'user-bad', companyId: 'c1', placementDriveId: null, subject: 'pat-PL-2026-1', bodySnippet: null },
          { id: 'email-2', userId: 'user-bad', companyId: 'c2', placementDriveId: null, subject: 'pat-PL-2026-1', bodySnippet: null },
        ],
      },
      'user-good': {
        ...emptyFixture(),
        applications: [{ id: 'app-good', userId: 'user-good', companyId: 'c3', placementDriveId: null }],
        drives: [{ id: REAL_UUID, userId: 'user-good', companyId: 'c3', normalizedDriveNumber: 'pat-pl-2026-1', identityState: 'assigned' }],
        emails: [{ id: 'email-good', userId: 'user-good', companyId: 'c3', placementDriveId: null, subject: 'pat-PL-2026-1', bodySnippet: null }],
      },
    });
    const rpcClient = makeFakeRpcClient();

    const summary = await runPhase3Migration({ reader, rpcClient, userIds: ['user-bad', 'user-good'], mode: 'execute' });

    const badReport = summary.users.find((u) => u.userId === 'user-bad')!;
    const goodReport = summary.users.find((u) => u.userId === 'user-good')!;
    expect(badReport.outcome.kind).toBe('skipped');
    expect((badReport.outcome as { reason: string }).reason).toContain('planning failed');
    expect(goodReport.outcome.kind).toBe('committed');
    expect(rpcClient.calls).toHaveLength(1);
    expect(rpcClient.calls[0].userId).toBe('user-good');
  });
});
