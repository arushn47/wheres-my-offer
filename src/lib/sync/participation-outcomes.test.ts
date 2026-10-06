import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StageStepper } from '@/components/companies/stage-stepper';
import { getEffectiveStage } from '@/lib/stages';
import { isOpenPptInvitation } from './placement-evidence';
import { resolveRoundVerdicts } from './round-verdict';
import { buildAnnouncedProcessToken } from './round-identity';
import { getEliminationRoundDecision, resolveRecruitmentStatus, statusForRoundVerdict, isRoundEventEligible, type RoundStatusDecision } from './round-status';

const absent: RoundStatusDecision = { roundKey: 'interview:1', roundType: 'interview', state: 'verified_absent', eligible: false, finalNegative: true, sourceReceivedAt: '2026-10-06T12:00:00Z', parserVersion: 4, isCurrent: true };
const prior = (round: 'ppt' | 'test' | 'interview'): RoundStatusDecision => ({ ...absent, roundKey: `${round}:previous`, roundType: round, state: 'verified_present', eligible: true, finalNegative: false, isCurrent: false, sourceReceivedAt: '2026-10-01T12:00:00Z' });

describe('screening, post-PPT, and test elimination require personal participation', () => {
  it.each(['applied', 'not_shortlisted', 'rejected', 'rejected_test'])('keeps %s in screening without prior test/PPT evidence', status => {
    const resolved = resolveRecruitmentStatus(status, [absent], false, 'Eliminated in Test Round\neliminated_at:post_ppt');
    expect(resolved).toBe('not_shortlisted');
    expect(statusForRoundVerdict(absent, status)).toBe('not_shortlisted');
    const pipeline = renderToStaticMarkup(React.createElement(StageStepper, { status: resolved, roundDecisions: [absent] }));
    expect(pipeline).toContain('data-stage-id="test" data-stage-state="absent"');
    expect(pipeline).toContain('data-stage-id="interview" data-stage-state="unverified"');
    expect(getEffectiveStage(resolved, null, []).statusSubtitle).toBe('Not Shortlisted · In Screening');
  });

  it('marks an included PPT but no test inclusion as post-PPT', () => {
    const decisions = [prior('ppt'), absent];
    const status = resolveRecruitmentStatus('not_shortlisted', decisions);
    expect(status).toBe('not_shortlisted_post_ppt');
    const effective = getEffectiveStage(status, null, []);
    expect(effective.statusSubtitle).toBe('Not Shortlisted · Post-PPT');
    const pipeline = renderToStaticMarkup(React.createElement(StageStepper, { status, roundDecisions: decisions }));
    expect(pipeline).toContain('PPT Completed');
    expect(pipeline).toContain('data-stage-id="test" data-stage-state="absent"');
    expect(pipeline).not.toContain('Eliminated in Test');
  });

  it('marks verified test inclusion followed by next-round absence as test elimination', () => {
    const decisions = [prior('test'), absent];
    expect(resolveRecruitmentStatus('not_shortlisted', decisions)).toBe('rejected_test');
    expect(statusForRoundVerdict(absent, 'applied', false, decisions)).toBe('rejected_test');
  });

  it('uses the latest verified evaluated round for the cross without changing the status label', () => {
    const decisions = [
      prior('test'),
      { ...prior('test'), roundKey: 'game', roundType: 'game' as const, sourceReceivedAt: '2026-10-05T12:00:00Z' },
      absent,
    ];
    expect(resolveRecruitmentStatus('not_shortlisted', decisions)).toBe('rejected_test');
    expect(getEliminationRoundDecision(decisions)?.roundType).toBe('game');
    const events = [{ event_type: 'online_test', start_time: '2026-10-01T12:00:00Z' }];
    const effective = getEffectiveStage('rejected_test', null, events, 'eliminated_at:game');
    expect(effective.statusSubtitle).toBe('Eliminated in Test Round');
    const notes = 'eliminated_at:game\n' + buildAnnouncedProcessToken([
      { id: 'test_1', roundType: 'test', roundNumber: 1, label: 'Test 1', shortLabel: 'Test 1' },
      { id: 'game_round', roundType: 'other', label: 'Game Round', shortLabel: 'Game' },
      { id: 'test_2', roundType: 'test', roundNumber: 2, label: 'Test 2', shortLabel: 'Test 2' },
      { id: 'interview', roundType: 'interview', label: 'Interview', shortLabel: 'Interview' },
    ]);
    for (const compact of [true, false]) {
      const pipeline = renderToStaticMarkup(React.createElement(StageStepper, { status: 'rejected_test', roundDecisions: decisions, notes, events, compact }));
      expect(pipeline).toContain('data-stage-id="test_1" data-stage-state="verified"');
      expect(pipeline).toContain('data-stage-id="game_round" data-stage-state="absent"');
      expect(pipeline).toContain('data-stage-id="test_2" data-stage-state="unverified"');
      expect(pipeline).not.toContain('Eliminated in Game');
    }
  });

  it('puts screening on an unearned PPT and leaves Test unearned', () => {
    const events = [{ event_type: 'ppt', start_time: '2026-10-01T12:00:00Z' }];
    for (const roundDecisions of [[absent], []]) {
      const pipeline = renderToStaticMarkup(React.createElement(StageStepper, { status: 'not_shortlisted', roundDecisions, events, compact: true }));
      expect(pipeline).toContain('data-stage-id="ppt" data-stage-state="absent"');
      expect(pipeline).toContain('data-stage-id="test" data-stage-state="unverified"');
    }
  });

  it('keeps the cross on Test after verified PPT inclusion', () => {
    const events = [{ event_type: 'ppt', start_time: '2026-10-01T12:00:00Z' }];
    const decisions = [prior('ppt'), absent];
    const pipeline = renderToStaticMarkup(React.createElement(StageStepper, { status: 'not_shortlisted_post_ppt', roundDecisions: decisions, events, compact: true }));
    expect(pipeline).toContain('data-stage-id="ppt" data-stage-state="verified"');
    expect(pipeline).toContain('data-stage-id="test" data-stage-state="absent"');
  });

  it('does not let a newer roster match or obsolete parser result fabricate prior test participation', () => {
    expect(resolveRecruitmentStatus('not_shortlisted', [{ ...prior('test'), sourceReceivedAt: '2026-10-07T12:00:00Z', eligible: false, state: 'deferred' }, absent])).toBe('not_shortlisted');
    expect(resolveRecruitmentStatus('not_shortlisted', [{ ...prior('test'), parserVersion: 1 }, absent])).toBe('not_shortlisted');
  });

  it('keeps absence from the PPT roster in screening', () => {
    expect(resolveRecruitmentStatus('applied', [{ ...absent, roundType: 'ppt', roundKey: 'ppt:1' }])).toBe('not_shortlisted');
  });

  it('honors manual overrides', () => {
    expect(resolveRecruitmentStatus('rejected_test', [absent], true)).toBe('rejected_test');
  });
});

describe('PPT audience extraction', () => {
  it.each([
    ['Myntra Pre-placement talk is scheduled on 14 September', 'All the applied candidates are informed to join the PPT without fail. Post pre-placement talk, shortlists will be circulated.'],
    ['Goldman PPT is scheduled tomorrow', 'Please find the attached applied students list. Kindly join the PPT using the webinar id below.'],
    ['UBS Pre-placement talk is scheduled tomorrow', 'Find the below shortlisted candidates list. Not shortlisted students can also attend the PPT session if they are interested.'],
  ])('recognizes the inclusive audience in %s', (subject, body) => {
    expect(isOpenPptInvitation(subject, body)).toBe(true);
    const verdict = resolveRoundVerdicts([{ emailId: 'open', subject, body, receivedAt: '2026-10-01T12:00:00Z', rosters: [], directInvitation: true, roundTypeOverride: 'ppt' }], ['I4W0P0K8'])[0];
    expect(verdict).toMatchObject({ roundType: 'ppt', state: 'verified_present', eligible: true, openInvitation: true });
    expect(statusForRoundVerdict(verdict, 'applied')).toBe('ppt_scheduled');
    expect(isRoundEventEligible(verdict, 'ppt')).toBe(true);
    expect(isRoundEventEligible(verdict, 'online_test')).toBe(false);
    expect(isRoundEventEligible(verdict, 'technical_interview')).toBe(false);
  });

  it.each([
    ['Sabre PPT & Online test is scheduled', 'Please find the attached shortlisted students list. All the students must attend the PPT and Test.'],
    ['Conneqtion PPT & online test is scheduled', 'Please find the attached shortlisted students list.'],
    ['Company placement circular', 'Selection process: PPT, Test, Interview. All interested and eligible students should register.'],
  ])('does not treat a restricted roster or outline as an open invitation in %s', (subject, body) => {
    expect(isOpenPptInvitation(subject, body)).toBe(false);
  });
});
