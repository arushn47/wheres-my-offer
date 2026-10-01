import { describe, expect, it } from 'vitest';
import { getEffectiveStage } from './stages';

describe('not-shortlisted stage with PPT evidence', () => {
  it('does not label a future PPT as post-PPT', () => {
    const result = getEffectiveStage('not_shortlisted', null, [{
      event_type: 'ppt',
      start_time: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }]);

    expect(result.statusSubtitle).toBe('Not Shortlisted · In Screening');
    expect(result.furthestPassedStage).toBe(0);
  });

  it('labels an elapsed PPT as post-PPT', () => {
    const result = getEffectiveStage('not_shortlisted', null, [{
      event_type: 'ppt',
      start_time: new Date(Date.now() - 3 * 60 * 60 * 1000),
      end_time: new Date(Date.now() - 90 * 60 * 1000),
    }]);

    expect(result.statusSubtitle).toBe('Not Shortlisted · Post-PPT');
    expect(result.furthestPassedStage).toBe(1);
  });

  it('labels an elapsed PPT as ppt_completed when application status is applied', () => {
    const result = getEffectiveStage('applied', null, [{
      event_type: 'ppt',
      start_time: new Date(Date.now() - 48 * 60 * 60 * 1000),
      end_time: new Date(Date.now() - 46 * 60 * 60 * 1000),
    }]);

    expect(result.effectiveStatus).toBe('ppt_completed');
    expect(result.statusSubtitle).toBe('PPT Completed · Test Shortlist Awaited');
    expect(result.stageIndex).toBe(1);
    expect(result.furthestPassedStage).toBe(1);
    expect(result.isPptCompleted).toBe(true);
  });
});
