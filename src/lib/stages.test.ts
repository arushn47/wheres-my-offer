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

  it('labels not_shortlisted as Post-PPT when drive has an announced PPT in notes', () => {
    const notesWithPpt = 'announced_process:[{"id":"ppt","roundType":"ppt","label":"PPT","shortLabel":"PPT"},{"id":"test","roundType":"test","label":"Online Test","shortLabel":"Test"}]';
    const result = getEffectiveStage('not_shortlisted', null, [], notesWithPpt);

    expect(result.statusSubtitle).toBe('Not Shortlisted · Post-PPT');
    expect(result.furthestPassedStage).toBe(1);
    expect(result.isPptCompleted).toBe(true);
    expect(result.hasPpt).toBe(true);
  });

  it('labels not_shortlisted as Post-PPT when notes contain explicit Not Shortlisted(Post PPT) token', () => {
    const notes = 'eliminated_at:post_ppt\nNot Shortlisted (Post PPT)';
    const result = getEffectiveStage('not_shortlisted', null, [], notes);

    expect(result.statusSubtitle).toBe('Not Shortlisted · Post-PPT');
    expect(result.furthestPassedStage).toBe(1);
    expect(result.isPptCompleted).toBe(true);
  });

  it('labels not_shortlisted_post_ppt status directly as Post-PPT', () => {
    const result = getEffectiveStage('not_shortlisted_post_ppt', null, []);

    expect(result.effectiveStatus).toBe('not_shortlisted');
    expect(result.statusSubtitle).toBe('Not Shortlisted · Post-PPT');
    expect(result.furthestPassedStage).toBe(1);
    expect(result.isPptCompleted).toBe(true);
  });
});

import { getPipelineStages } from '@/components/companies/stage-stepper';
import { buildAnnouncedProcessToken, parseRecruitmentProcess } from '@/lib/sync/round-identity';

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

  it('renders clean round stage names for announced process notes instead of full event strings', () => {
    const emailText = `Date of Visit:
Test - 26th Sept 2026 (4 PM) @ VIT Vellore campus & others in respective campus venues
Physical Interview 31 august - Will be announced later`;

    const announced = parseRecruitmentProcess(emailText)!;
    const notes = buildAnnouncedProcessToken(announced);

    const effective = getEffectiveStage('applied', null, []);
    const stages = getPipelineStages({
      effective,
      currentStage: 0,
      furthestPassed: -1,
      eliminatedStage: -1,
      notes,
    });

    expect(stages.map(s => s.label)).toEqual(['Applied', 'Test', 'Interview', 'Selected / Offer']);
    expect(stages.map(s => s.shortLabel)).toEqual(['Applied', 'Test', 'Interview', 'Offer']);
  });

  it('guarantees Test round is included between PPT and Interview for PPT Completed companies (e.g. UBS, Chargebee, EY SAP)', () => {
    const emailText = `Date of Visit:
*Pre-placement talk:* 29-September-26; 4:00 PM to 5:00 PM
*Interview:* 6-October-26; 10:00 AM onwards`;

    const announced = parseRecruitmentProcess(emailText)!;
    const notes = buildAnnouncedProcessToken(announced);

    const events = [{
      event_type: 'ppt',
      start_time: new Date(Date.now() - 48 * 60 * 60 * 1000),
      end_time: new Date(Date.now() - 46 * 60 * 60 * 1000),
    }];
    const effective = getEffectiveStage('ppt_completed', null, events, notes);
    const stages = getPipelineStages({
      effective,
      currentStage: effective.stageIndex,
      furthestPassed: effective.furthestPassedStage,
      eliminatedStage: effective.eliminatedStage,
      allEvents: events,
      notes,
    });

    // Must have Test between PPT and Interview!
    expect(stages.map(s => s.shortLabel)).toEqual(['Applied', 'PPT', 'Test', 'Interview', 'Offer']);
  });

  it('marks PPT as passed milestone and Post-PPT subtitle for not_shortlisted drives with announced PPT (e.g. Amazon, Blackrock)', () => {
    const amazonNotes = `vellore\nannounced_process:[{"id":"ppt_1","label":"PPT: 10.08.2026*","shortLabel":"PPT","dateStr":"10.08.2026","roundType":"ppt"},{"id":"test_10_08_2026_2","label":"Test: 10.08.2026 *","shortLabel":"Test: 10.08.2026 *","dateStr":"10.08.2026","roundType":"test","roundNumber":1},{"id":"interview_date_will_be_informed_later_3","label":"Interview Date:  will be informed later*","shortLabel":"Interview Date:  will be informed later*","roundType":"interview","roundNumber":1}]`;

    const effective = getEffectiveStage('not_shortlisted', null, [], amazonNotes, false);
    expect(effective.isPptCompleted).toBe(true);
    expect(effective.furthestPassedStage).toBe(1);
    expect(effective.statusSubtitle).toBe('Not Shortlisted · Post-PPT');

    const stages = getPipelineStages({
      effective,
      currentStage: effective.stageIndex,
      furthestPassed: effective.furthestPassedStage,
      eliminatedStage: effective.eliminatedStage,
      allEvents: [],
      notes: amazonNotes,
    });

    expect(stages.map(s => s.id)).toEqual([
      'applied',
      'ppt_1',
      'test_10_08_2026_2',
      'interview_date_will_be_informed_later_3',
      'offer',
    ]);
  });

  it('determines registration_open with countdown when registration deadline is upcoming', () => {
    const futureDate = new Date(Date.now() + 15 * 60 * 60 * 1000); // 15 hours from now
    const effective = getEffectiveStage('not_applied', null, [{
      event_type: 'registration_deadline',
      start_time: futureDate,
    }]);

    expect(effective.effectiveStatus).toBe('registration_open');
    expect(effective.statusSubtitle).toContain('Closes in');
  });

  it('preserves registration_open when raw status is registration_open', () => {
    const effective = getEffectiveStage('registration_open', null, []);
    expect(effective.effectiveStatus).toBe('registration_open');
    expect(effective.statusSubtitle).toBe('Registration Open');
  });
});


