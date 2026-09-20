export type ApplicationOperationScope =
  | { kind: 'drive'; placementDriveId: string; companyId: string }
  | { kind: 'legacy'; companyId: string; applicationId?: string | null }
  | { kind: 'quarantine'; companyId: string | null; reason: 'ambiguous' | 'conflict' | 'unassigned' | 'low_confidence' };

export function getLiveApplicationScope(params: {
  companyId: string | null;
  placementDriveId: string | null;
  assignmentState: string;
  assignmentConfidence: string;
}): ApplicationOperationScope {
  if (
    params.companyId &&
    params.placementDriveId &&
    ['assigned', 'manually_assigned'].includes(params.assignmentState) &&
    ['high', 'medium'].includes(params.assignmentConfidence)
  ) {
    return {
      kind: 'drive',
      placementDriveId: params.placementDriveId,
      companyId: params.companyId,
    };
  }

  return {
    kind: 'quarantine',
    companyId: params.companyId,
    reason: params.assignmentConfidence === 'low' && params.placementDriveId
      ? 'low_confidence'
      : (params.assignmentState as 'ambiguous' | 'conflict' | 'unassigned'),
  };
}
