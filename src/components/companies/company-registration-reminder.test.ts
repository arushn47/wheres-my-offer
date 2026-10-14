import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanyRegistrationReminder } from './company-registration-reminder';
import type { RegistrationRequirements } from '@/lib/sync/extraction/registration-requirements';

afterEach(() => vi.useRealTimers());
const requirements: RegistrationRequirements = {
  companyFormRequired: true,
  companyLinks: [{ url: 'https://forms.office.com/r/example', label: 'Student details form' }],
  sourceQuote: 'Register in NEO PAT & company link',
};
const render = (value: RegistrationRequirements | null, deadline = '2026-10-15T04:30:00Z') => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
  return renderToStaticMarkup(createElement(CompanyRegistrationReminder, {
    requirements: value, status: 'applied', deadline,
  }));
};

it('keeps a company-form action visible after NeoPAT registration without claiming completion', () => {
  const html = render(requirements);
  expect(html).toContain('NeoPAT + company registration required');
  expect(html).toContain('Open company form');
  expect(html).toContain('href="https://forms.office.com/r/example"');
  expect(html).toContain('Open NeoPAT');
  expect(html).toContain('href="https://vit.neopat.ai/"');
  expect(html).not.toContain('does not submit the company form');
  expect(html).not.toContain('Open registration email');
});
it('directs students to the email below when the stored body lost the company hyperlink', () => {
  const html = render({ ...requirements, companyLinks: [] });
  expect(html).toContain('Find the company form link in the registration email below.');
  expect(html).toContain('Open NeoPAT');
  expect(html).not.toContain('Open company form');
});
it('adds no banner without an explicit requirement and removes expired reminders', () => {
  expect(render(null)).toBe('');
  expect(render(requirements, '2026-10-14T04:30:00Z')).toBe('');
});

it('offers NeoPAT for an open registration without implying a company form is required', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
  const html = renderToStaticMarkup(createElement(CompanyRegistrationReminder, {
    requirements: null, status: 'registration_open', embedded: true,
    deadline: '2026-10-15T04:30:00Z',
  }));
  expect(html).toContain('href="https://vit.neopat.ai/"');
  expect(html).toContain('Open NeoPAT');
  expect(html).not.toContain('company form');
  expect(html).not.toContain('company registration required');
});
