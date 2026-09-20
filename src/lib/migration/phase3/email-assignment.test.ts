import { describe, expect, it } from 'vitest';

function isContradictory(row: { placement_drive_id: string | null; assignment_state: string | null }) {
  return (
    (['assigned', 'manually_assigned'].includes(row.assignment_state || '') && !row.placement_drive_id) ||
    (Boolean(row.placement_drive_id) && ['ambiguous', 'conflict', 'unassigned', 'legacy'].includes(row.assignment_state || ''))
  );
}

describe('email assignment metadata invariant', () => {
  it('accepts a drive-owned assigned email', () => {
    expect(isContradictory({ placement_drive_id: 'drive-a', assignment_state: 'assigned' })).toBe(false);
  });

  it('flags a drive-owned email with stale unassigned metadata', () => {
    expect(isContradictory({ placement_drive_id: 'drive-a', assignment_state: 'unassigned' })).toBe(true);
  });

  it('flags assigned metadata without a drive and does not infer one', () => {
    expect(isContradictory({ placement_drive_id: null, assignment_state: 'assigned' })).toBe(true);
  });
});
