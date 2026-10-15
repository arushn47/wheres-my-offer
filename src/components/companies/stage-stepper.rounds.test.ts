import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StageStepper } from './stage-stepper';
import type { RoundStatusDecision } from '@/lib/sync/recruitment/round-status';

function node(status: string, round: string, decisions?: RoundStatusDecision[], notes?: string) {
  const html = renderToStaticMarkup(createElement(StageStepper, { status, roundDecisions: decisions, notes }));
  const markup = html.match(new RegExp(`<div[^>]*data-stage-id="${round}"[^>]*>[\\s\\S]*?</div>`))?.[0];
  expect(markup).toBeDefined();
  return markup!;
}

const interview: RoundStatusDecision = {
  roundKey: 'interview:1', roundType: 'interview', state: 'verified_present', eligible: true,
  finalNegative: false, sourceReceivedAt: '2026-10-15T13:00:00Z', parserVersion: 4, isCurrent: true,
};

describe('round completion markers', () => {
  it.each([undefined, [interview]])('keeps a scheduled interview pending even with a verified shortlist (%j)', decisions => {
    const markup = node('interview_scheduled', 'interview', decisions);
    expect(markup).toContain('Round pending completion');
    expect(markup).toContain('data-stage-state="active"');
    expect(markup).not.toContain('✓');
  });

  it('keeps ongoing interviews pending completion', () => {
    expect(node('interview_ongoing', 'interview', [interview])).not.toContain('✓');
  });

  it('checks the completed interview and retains earlier completed milestones', () => {
    expect(node('interview_completed', 'interview', [interview])).toContain('✓');
    expect(node('interview_scheduled', 'applied', [interview])).toContain('✓');
  });

  it('handles numbered announced interview rounds', () => {
    const notes = 'announced_process:[{"id":"test_1","roundType":"test","label":"Test","shortLabel":"Test"},{"id":"interview_1","roundType":"interview","label":"Interview","shortLabel":"Interview"}]';
    expect(node('interview_scheduled', 'interview_1', [interview], notes)).not.toContain('✓');
  });

  it('also distinguishes test shortlists from completed tests', () => {
    const test: RoundStatusDecision = { ...interview, roundKey: 'test:1', roundType: 'test' };
    expect(node('test_scheduled', 'test', [test])).toContain('Round pending completion');
    expect(node('test_completed', 'test', [test])).toContain('✓');
  });
});
