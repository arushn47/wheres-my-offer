import { getConfirmedRoundDecision, getEliminationRoundDecision, getRoundParticipation, usesAutomaticRoundStatus, type RoundStatusDecision } from './round-status';

interface PipelineStage { id: string; label: string; shortLabel: string }

/** Map verified evidence to individual nodes; missing intermediate matches stay unearned. */
export function getVerifiedPipelineState(params: {
  stages: PipelineStage[];
  decisions?: RoundStatusDecision[];
  status: string;
  manualOverride?: boolean;
  pptCompleted: boolean;
}) {
  const { stages, decisions = [], status, manualOverride, pptCompleted } = params;
  const current = getConfirmedRoundDecision(decisions);
  if (!current || !usesAutomaticRoundStatus(status, manualOverride)) return null;
  const participation = getRoundParticipation(decisions, current);
  const findStage = (decision: RoundStatusDecision) => {
    const family = decision.roundType?.replace(/_r2$/, '') || 'test';
    if (family === 'selected') {
      if (decision.eligible && decision.state === 'verified_present') return stages.findIndex(stage => stage.id === 'offer');
      const hadInterview = decisions.some(d => d.eligible && d.state === 'verified_present' && d.roundType?.startsWith('interview'));
      if (!hadInterview) {
        const hadTest = decisions.some(d => d.eligible && d.state === 'verified_present' && (d.roundType === 'test' || d.roundType === 'test_r2'));
        if (hadTest) {
          const intStage = stages.findIndex(s => s.id.startsWith('interview'));
          if (intStage >= 0) return intStage;
          const testStage = stages.findIndex(s => s.id.startsWith('test'));
          if (testStage >= 0) return testStage;
        } else {
          const testStage = stages.findIndex(s => s.id.startsWith('test'));
          if (testStage >= 0) return testStage;
        }
      }
      return stages.findIndex(stage => stage.id === 'offer');
    }
    const candidates = stages.map((stage, index) => ({ stage, index }))
      .filter(({ stage }) => family === 'game' ? /game/i.test(stage.id) : stage.id.startsWith(family));
    if (candidates.length === 1) return candidates[0].index;
    const ordinal = decision.roundNumber || 1;
    return candidates[ordinal - 1]?.index ?? -1;
  };
  // Missing a later broadcast list cannot skip an unearned entry shortlist.
  const screenedBeforeTest = current.state === 'verified_absent' && !participation.test && !participation.interview &&
    status !== 'rejected_test' && status !== 'rejected_interview';
  // Screening blocks the first entry round the candidate has not reached.
  // If PPT comes first, its bubble carries the cross until inclusion is confirmed.
  const screeningIndex = stages.findIndex(stage => stage.id.startsWith('test') ||
    (!participation.ppt && !pptCompleted && stage.id.startsWith('ppt')));
  const eliminationRound = getEliminationRoundDecision(decisions, current);
  const currentIndex = eliminationRound
    ? findStage(eliminationRound)
    : screenedBeforeTest && current.roundType !== 'ppt'
      ? screeningIndex : findStage(current);
  const verified = new Set<number>([stages.findIndex(stage => stage.id === 'applied')]);
  if (pptCompleted || participation.ppt) {
    stages.forEach((stage, index) => { if (stage.id.startsWith('ppt')) verified.add(index); });
  }
  for (const decision of decisions) {
    if (decision.eligible && decision.state === 'verified_present' && decision.parserVersion >= current.parserVersion && decision.sourceReceivedAt <= current.sourceReceivedAt) {
      const index = findStage(decision);
      if (index >= 0) verified.add(index);
    }
  }
  if (current.state === 'verified_absent') verified.delete(currentIndex);
  return { current, currentIndex, verified };
}
