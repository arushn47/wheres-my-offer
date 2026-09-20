import { describe, expect, it } from 'vitest';
import { buildPerUserReport, buildRunSummary, summarizePlannedActions } from './report';
import { evaluatePreflight } from './validate';
import type { PlannedAction } from './plan-run';

const USER_A = 'user-a';
const COMPANY_1 = 'company-1';
const scope = { userId: USER_A, companyId: COMPANY_1 };

describe('summarizePlannedActions', () => {
  it('counts each action under its record type and action kind', () => {
    const actions: PlannedAction[] = [
      { recordType: 'application', action: { action: 'assign_existing_drive', scope, recordId: 'a', driveId: 'd' } },
      { recordType: 'application', action: { action: 'skip_unresolved', scope, recordId: 'b' } },
      { recordType: 'event', action: { action: 'defer_ambiguous', scope, recordId: 'c', reason: 'x' } },
    ];
    const counts = summarizePlannedActions(actions);
    expect(counts.application.assign_existing_drive).toBe(1);
    expect(counts.application.skip_unresolved).toBe(1);
    expect(counts.event.defer_ambiguous).toBe(1);
    expect(counts.candidate_match.assign_existing_drive).toBe(0);
    expect(counts.notification.assign_existing_drive).toBe(0);
    expect(counts.email.assign_existing_drive).toBe(0);
  });

  it('returns all-zero counts for an empty action list', () => {
    const counts = summarizePlannedActions([]);
    expect(counts.application).toEqual({
      assign_existing_drive: 0,
      create_drive_then_assign: 0,
      skip_already_migrated: 0,
      defer_ambiguous: 0,
      defer_conflict: 0,
      skip_unresolved: 0,
    });
  });
});

describe('buildRunSummary', () => {
  const preflight = evaluatePreflight([{ checkName: 'x', status: 'PASS', details: '' }]);

  it('aggregates totals across users and reports readOnly correctly for dry-run', () => {
    const userA = buildPerUserReport({
      userId: 'user-a',
      plannedActions: [
        { recordType: 'application', action: { action: 'assign_existing_drive', scope, recordId: 'a', driveId: 'd' } },
      ],
      driveCreationRequests: [],
      unscoped: [],
      outcome: { kind: 'dry_run' },
    });
    const userB = buildPerUserReport({
      userId: 'user-b',
      plannedActions: [
        { recordType: 'application', action: { action: 'assign_existing_drive', scope, recordId: 'b', driveId: 'd' } },
      ],
      driveCreationRequests: [],
      unscoped: [],
      outcome: { kind: 'dry_run' },
    });

    const summary = buildRunSummary({ mode: 'dry-run', preflight, users: [userA, userB], now: () => 'T' });
    expect(summary.readOnly).toBe(true);
    expect(summary.totals.usersPlanned).toBe(2);
    expect(summary.totals.actionCounts.application.assign_existing_drive).toBe(2);
    expect(summary.totals.usersCommitted).toBe(0);
    expect(summary.generatedAt).toBe('T');
  });

  it('counts distinct drive-creation requests once even if two users happen to create differently-scoped drives', () => {
    const userA = buildPerUserReport({
      userId: 'user-a',
      plannedActions: [],
      driveCreationRequests: [{ userId: 'user-a', companyId: 'c1', normalizedDriveNumber: 'r1' }],
      unscoped: [],
      outcome: { kind: 'dry_run' },
    });
    const summary = buildRunSummary({ mode: 'dry-run', preflight, users: [userA] });
    expect(summary.totals.distinctDrivesWouldCreateOrCreated).toBe(1);
  });

  it('tracks committed/rolled_back/skipped outcomes separately', () => {
    const committed = buildPerUserReport({
      userId: 'user-a',
      plannedActions: [],
      driveCreationRequests: [],
      unscoped: [],
      outcome: {
        kind: 'committed',
        result: { committed: true, applied: [], skippedAlreadyMigratedConcurrently: [], conflicts: [], drivesCreated: [], drivesReused: [] },
      },
    });
    const rolledBack = buildPerUserReport({
      userId: 'user-b',
      plannedActions: [],
      driveCreationRequests: [],
      unscoped: [],
      outcome: {
        kind: 'rolled_back',
        result: { committed: false, applied: [], skippedAlreadyMigratedConcurrently: [], conflicts: [], drivesCreated: [], drivesReused: [], error: 'boom' },
      },
    });
    const skipped = buildPerUserReport({
      userId: 'user-c',
      plannedActions: [],
      driveCreationRequests: [],
      unscoped: [],
      outcome: { kind: 'skipped', reason: 'no writable actions' },
    });

    const summary = buildRunSummary({ mode: 'execute', preflight, users: [committed, rolledBack, skipped] });
    expect(summary.totals.usersCommitted).toBe(1);
    expect(summary.totals.usersRolledBack).toBe(1);
    expect(summary.totals.usersSkipped).toBe(1);
  });
});
