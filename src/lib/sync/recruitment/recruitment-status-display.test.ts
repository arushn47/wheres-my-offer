import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StageStepper } from '@/components/companies/stage-stepper';
import { StatusChip } from '@/components/ui/status-chip';
import { getEffectiveStage } from '@/lib/stages';
import { resolveRecruitmentStatus, type RoundStatusDecision } from './round-status';

const deferred: RoundStatusDecision = {
  roundKey: 'test:1', roundType: 'test', state: 'deferred', eligible: false,
  finalNegative: false, sourceReceivedAt: '2026-10-06T10:00:00Z', parserVersion: 3, isCurrent: true,
};
const stages = (status: string, decisions: RoundStatusDecision[]) => renderToStaticMarkup(
  React.createElement(StageStepper, { status, roundDecisions: decisions })
);
const badge = (status: string) => renderToStaticMarkup(React.createElement(StatusChip, { status }));

describe('consistent recruitment status across badge and pipeline', () => {
  it('keeps Chargebee at the last milestone when no shortlist is verified', () => {
    const status = resolveRecruitmentStatus('ppt_completed', [deferred]);
    expect(status).toBe('ppt_completed');
    expect(badge(status)).toContain('PPT Completed');
    const pipeline = stages(status, [deferred]);
    expect(pipeline).toContain('PPT Completed');
    expect(pipeline).toContain('data-stage-id="test" data-stage-state="unverified"');
    expect(pipeline).not.toMatch(/Pending|Verification|Shortlisted/);
    expect(getEffectiveStage(status, null, []).statusSubtitle).toContain('PPT Completed');
  });

  it('shows the confirmed test shortlist in both Toshiba/Prodapt badge and pipeline', () => {
    const present = { ...deferred, state: 'verified_present', eligible: true };
    const status = resolveRecruitmentStatus('applied', [present]);
    expect(status).toBe('shortlisted');
    expect(badge(status)).toContain('Shortlisted');
    expect(stages(status, [present])).toContain('Test Shortlisted');
    expect(getEffectiveStage(status, null, []).statusSubtitle).toBe('Shortlisted for Test');
  });

  it('shows the completed round consistently after a verified test finishes', () => {
    const present = { ...deferred, state: 'verified_present', eligible: true };
    const status = resolveRecruitmentStatus('test_completed', [present]);
    expect(status).toBe('test_completed');
    expect(badge(status)).toContain('Test Completed');
    expect(stages(status, [present])).toContain('Test Completed');
    expect(stages(status, [present])).not.toContain('Test Shortlisted');
  });

  it('keeps Honeywell absent rather than replacing rejection with a parsing label', () => {
    const absent = { ...deferred, state: 'verified_absent', finalNegative: true, isCurrent: false, sourceReceivedAt: '2026-10-05T10:00:00Z' };
    const status = resolveRecruitmentStatus('not_shortlisted', [absent, deferred]);
    expect(status).toBe('not_shortlisted');
    expect(badge(status)).toContain('Not Shortlisted');
    const pipeline = stages(status, [absent, deferred]);
    expect(pipeline).toContain('data-stage-id="test" data-stage-state="absent"');
    expect(pipeline).not.toMatch(/Pending|Verification/);
  });

  it('retains the previous checked absence even when that roster was partial', () => {
    const absent = { ...deferred, state: 'verified_absent', isCurrent: false, sourceReceivedAt: '2026-10-05T10:00:00Z' };
    expect(resolveRecruitmentStatus('applied', [absent, deferred])).toBe('not_shortlisted');
  });

  it('does not revive retired Toshiba/Prodapt eligibility results as offers', () => {
    const retired: RoundStatusDecision = { ...deferred, roundKey: 'result:selected', roundType: 'selected', state: 'verified_present', eligible: true, parserVersion: 1, isCurrent: false };
    const status = resolveRecruitmentStatus('applied', [retired]);
    expect(status).toBe('applied');
    expect(badge(status)).toContain('Applied');
    expect(stages(status, [retired])).toContain('data-stage-id="test" data-stage-state="unverified"');
    expect(stages(status, [retired])).not.toContain('Test Shortlisted');
  });

  it('does not use obsolete parser results to override a newer checked absence', () => {
    const retired: RoundStatusDecision = { ...deferred, roundKey: 'result:selected', roundType: 'selected', state: 'verified_present', eligible: true, parserVersion: 1, isCurrent: false, sourceReceivedAt: '2026-10-07T10:00:00Z' };
    const absent = { ...deferred, state: 'verified_absent', finalNegative: true };
    expect(resolveRecruitmentStatus('applied', [retired, absent])).toBe('not_shortlisted');
  });

  it.each(['withdrawn', 'declined', 'not_applied', 'registration_open'])('does not override %s with shared round evidence', status => {
    expect(resolveRecruitmentStatus(status, [{ ...deferred, state: 'verified_present', eligible: true }])).toBe(status);
  });

  it('honors a manual status and does not advance the stepper from automatic evidence', () => {
    const decisions = [{ ...deferred, state: 'verified_present', eligible: true }];
    expect(resolveRecruitmentStatus('applied', decisions, true)).toBe('applied');
    const pipeline = renderToStaticMarkup(React.createElement(StageStepper, { status: 'applied', manualOverride: true, roundDecisions: decisions }));
    expect(pipeline).toContain('data-stage-id="test" data-stage-state="unverified"');
  });

  it('places a verified final selection on the offer node even without older roster history', () => {
    const selected: RoundStatusDecision = { ...deferred, roundKey: 'selected', roundType: 'selected', state: 'verified_present', eligible: true };
    const status = resolveRecruitmentStatus('applied', [selected]);
    expect(status).toBe('selected');
    expect(badge(status)).toContain('Selected / Offer');
    expect(stages(status, [selected])).toContain('data-stage-id="offer" data-stage-state="verified"');
  });
});
