import { expect, it } from 'vitest';
import { cleanLocationString } from './locations';

it('uses a comma for a city and locality separated by a spaced dash', () => {
  expect(cleanLocationString('Bengaluru - Indiranagar')).toBe('Bengaluru, Indiranagar');
  expect(cleanLocationString('Bengaluru – Indiranagar')).toBe('Bengaluru, Indiranagar');
  expect(cleanLocationString('Indiranagar - Bengaluru')).toBe('Indiranagar, Bengaluru');
});
it('preserves the distinction between parallel cities and a hyphenated name', () => {
  expect(cleanLocationString('Bengaluru - Hyderabad')).toBe('Bengaluru / Hyderabad');
  expect(cleanLocationString('Winston-Salem')).toBe('Winston-Salem');
});
