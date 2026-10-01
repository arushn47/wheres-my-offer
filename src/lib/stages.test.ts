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

import { getPipelineStages } from '@/components/companies/stage-stepper';

describe('getPipelineStages dynamic recruitment pipeline', () => {
  it('omits PPT when test round is completed without PPT (e.g. Axxela)', () => {
    const events = [{
      event_type: 'online_test',
      start_time: new Date(Date.now() - 24 * 60 * 60 * 1000),
      end_time: new Date(Date.now() - 22 * 60 * 60 * 1000),
    }];
    const effective = getEffectiveStage('test_completed', null, events);
    const stages = getPipelineStages({
      effective,
      currentStage: effective.stageIndex,
      furthestPassed: effective.furthestPassedStage,
      eliminatedStage: effective.eliminatedStage,
      allEvents: events,
    });

    // PPT should be omitted, future rounds (Interview, Offer) preserved!
    expect(stages.map(s => s.id)).toEqual(['applied', 'test', 'interview', 'offer']);
  });

  it('keeps PPT and future rounds when company is at Applied stage (basic UI)', () => {
    const effective = getEffectiveStage('applied', null, []);
    const stages = getPipelineStages({
      effective,
      currentStage: effective.stageIndex,
      furthestPassed: effective.furthestPassedStage,
      eliminatedStage: effective.eliminatedStage,
      allEvents: [],
    });

    // Full 5 stages preserved
    expect(stages.map(s => s.id)).toEqual(['applied', 'ppt', 'test', 'interview', 'offer']);
  });

  it('keeps PPT and future rounds when PPT is scheduled (e.g. LTM)', () => {
    const events = [{
      event_type: 'ppt',
      start_time: new Date(Date.now() + 48 * 60 * 60 * 1000),
    }];
    const effective = getEffectiveStage('ppt_scheduled', null, events);
    const stages = getPipelineStages({
      effective,
      currentStage: effective.stageIndex,
      furthestPassed: effective.furthestPassedStage,
      eliminatedStage: effective.eliminatedStage,
      allEvents: events,
    });

    expect(stages.map(s => s.id)).toEqual(['applied', 'ppt', 'test', 'interview', 'offer']);
  });

  it('keeps PPT when company had PPT and is now at Test stage', () => {
    const events = [
      {
        event_type: 'ppt',
        start_time: new Date(Date.now() - 72 * 60 * 60 * 1000),
        end_time: new Date(Date.now() - 70 * 60 * 60 * 1000),
      },
      {
        event_type: 'online_test',
        start_time: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    ];
    const effective = getEffectiveStage('test_scheduled', null, events);
    const stages = getPipelineStages({
      effective,
      currentStage: effective.stageIndex,
      furthestPassed: effective.furthestPassedStage,
      eliminatedStage: effective.eliminatedStage,
      allEvents: events,
    });

    expect(stages.map(s => s.id)).toEqual(['applied', 'ppt', 'test', 'interview', 'offer']);
  });

  it('omits PPT and preserves upcoming rounds when eliminated in test round without PPT', () => {
    const events = [{
      event_type: 'online_test',
      start_time: new Date(Date.now() - 48 * 60 * 60 * 1000),
      end_time: new Date(Date.now() - 46 * 60 * 60 * 1000),
    }];
    const effective = getEffectiveStage('not_shortlisted', null, events);
    const stages = getPipelineStages({
      effective,
      currentStage: effective.stageIndex,
      furthestPassed: effective.furthestPassedStage,
      eliminatedStage: effective.eliminatedStage,
      allEvents: events,
    });

    expect(stages.map(s => s.id)).toEqual(['applied', 'test', 'interview', 'offer']);
  });
});

