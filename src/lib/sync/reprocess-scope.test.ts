import { describe, expect, it } from 'vitest';
import { classifyReprocessScope } from './reprocess-scope';

describe('reprocess scope', () => {
  it('keeps explicit drive evidence in DriveScope', () => {
    expect(classifyReprocessScope({ companyId: 'c', placementDriveId: 'a', assignmentState: 'assigned' })).toEqual({ kind: 'drive', companyId: 'c', placementDriveId: 'a' });
  });
  it('keeps null-drive records in LegacyCompanyScope', () => {
    expect(classifyReprocessScope({ companyId: 'c', placementDriveId: null })).toEqual({ kind: 'legacy', companyId: 'c' });
  });
  it('quarantines conflicting or unassigned records', () => {
    expect(classifyReprocessScope({ companyId: 'c', placementDriveId: null, assignmentState: 'conflict' }).kind).toBe('quarantine');
    expect(classifyReprocessScope({ companyId: 'c', placementDriveId: 'a', assignmentState: 'ambiguous' }).kind).toBe('quarantine');
  });
});
