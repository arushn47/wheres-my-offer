import { expect, it } from 'vitest';
import { deriveEventEndTime } from './event-duration';

it('never derives an end time for a registration cutoff', () => {
  const cutoff = '2026-10-15T04:30:00Z';
  expect(deriveEventEndTime('registration_deadline', 'Registration Deadline', cutoff)).toBeNull();
  expect(deriveEventEndTime('registration_deadline', 'Pre-placement registration deadline', cutoff)).toBeNull();
});
it('preserves fallback durations for actual rounds', () => {
  expect(deriveEventEndTime('online_test', 'Online Test', '2026-10-15T04:30:00Z')?.toISOString()).toBe('2026-10-15T06:30:00.000Z');
  expect(deriveEventEndTime('technical_interview', 'Interview', '2026-10-15T04:30:00Z')?.toISOString()).toBe('2026-10-15T06:00:00.000Z');
});
