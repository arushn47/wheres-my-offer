import { expect, it } from 'vitest';
import { formatCompensationLabel, formatTotalCtc } from './compensation';

it.each([
  ['13 LPA + up to ₹3 lakh one-time relocation assistance', '16 LPA'],
  ['13 LPA + up to 3 LPA relocation allowance', '16 LPA'],
  ['12.5 LPA + up to ₹2.5 lakh one-time relocation assistance', '15 LPA'],
  ['*16 LPA*', '16 LPA'],
  ['13 - 14 LPA', '13 - 14 LPA'],
  ['13 LPA', '13 LPA'],
  [null, ''],
  ['UG: 14.5 LPA (if converted)', '14.5 LPA'],
  ['PG: 12 LPA + 3 lakh joining bonus (if converted)', '12 LPA'],
])('formats only the total while preserving ordinary CTC values: %s', (input, expected) => {
  expect(formatTotalCtc(input)).toBe(expected);
});

it('keeps stipend labels compact without hiding unresolved degree tiers', () => {
  expect(formatCompensationLabel('UG: ₹45,000/month')).toBe('₹45,000/month');
  const unknown = 'PG: 12 LPA · UG: 14.5 LPA';
  expect(formatTotalCtc(unknown)).toBe(unknown);
});
