export type ReprocessScope =
  | { kind: 'drive'; placementDriveId: string; companyId: string }
  | { kind: 'legacy'; companyId: string }
  | { kind: 'quarantine'; companyId: string | null; reason: 'ambiguous' | 'conflict' | 'unassigned' | 'low_confidence' };

export function classifyReprocessScope(params: {
  companyId: string | null;
  placementDriveId: string | null;
  assignmentState?: string | null;
  assignmentConfidence?: string | null;
}): ReprocessScope {
  if (params.placementDriveId && params.companyId && ['assigned', 'manually_assigned'].includes(params.assignmentState || 'assigned')) {
    return { kind: 'drive', placementDriveId: params.placementDriveId, companyId: params.companyId };
  }
  if (!params.placementDriveId && params.companyId && !['ambiguous', 'conflict', 'unassigned'].includes(params.assignmentState || '')) {
    return { kind: 'legacy', companyId: params.companyId };
  }
  return {
    kind: 'quarantine',
    companyId: params.companyId,
    reason: params.assignmentConfidence === 'low' ? 'low_confidence' : (params.assignmentState as 'ambiguous' | 'conflict' | 'unassigned') || 'unassigned',
  };
}
