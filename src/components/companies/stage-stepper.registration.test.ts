import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StageStepper } from './stage-stepper';

afterEach(() => vi.useRealTimers());

describe('registration deadline banner', () => {
  it('shows the saved Myfacto deadline in IST with its countdown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T17:30:00Z'));
    const html = renderToStaticMarkup(createElement(StageStepper, {
      status: 'registration_open',
      events: [{ eventType: 'registration_deadline', startTime: '2026-10-13T10:00:00Z' }],
    }));

    expect(html).toContain('Registration deadline:');
    expect(html).toContain('13 October 2026');
    expect(html).toMatch(/3:30\s*pm/i);
    expect(html).toContain('IST');
    expect(html).toContain('Closes in');
  });

  it('does not invent a deadline when none was extracted', () => {
    const html = renderToStaticMarkup(createElement(StageStepper, { status: 'registration_open' }));
    expect(html).toContain('Registration Window Open');
    expect(html).not.toContain('Registration deadline:');
  });
});
