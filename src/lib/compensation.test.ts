import { expect, it } from 'vitest';
import { formatTotalCtc } from './compensation';

it.each([
  ['13 LPA + up to ₹3 lakh one-time relocation assistance', '16 LPA'],
  ['13 LPA + up to 3 LPA relocation allowance', '16 LPA'],
  ['12.5 LPA + up to ₹2.5 lakh one-time relocation assistance', '15 LPA'],
  ['*16 LPA*', '16 LPA'],
  ['13 - 14 LPA', '13 - 14 LPA'],
  ['13 LPA', '13 LPA'],
  [null, ''],
])('formats only the total while preserving ordinary CTC values: %s', (input, expected) => {
  expect(formatTotalCtc(input)).toBe(expected);
});
