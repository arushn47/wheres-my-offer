/**
 * Canonical event duration fallbacks.
 *
 * When an email does not state an explicit end time, the end time is derived
 * from the start time using a single source of truth so that the database,
 * sync engine, reprocess engine and UI all agree.
 */

export type EventDurationKind = 'ppt' | 'test' | 'interview' | 'registration' | 'other';

export function classifyEventDurationKind(
  eventType?: string | null,
  title?: string | null
): EventDurationKind {
  const value = `${eventType || ''} ${title || ''}`.toLowerCase();
  if (/ppt|pre[\s-]*placement/.test(value)) return 'ppt';
  if (/registration|deadline/.test(value)) return 'registration';
  if (
    /online_test|coding_test|assessment|coding|test|exam|hackerearth|mettl|shl/.test(value)
  ) {
    return 'test';
  }
  if (/interview|f2f|face\s*to\s*face|panel|discussion/.test(value)) return 'interview';
  return 'other';
}

/** Fallback durations in milliseconds. */
export const EVENT_DURATION_MS: Record<EventDurationKind, number> = {
  ppt: 90 * 60 * 1000, // 1.5 hours
  test: 120 * 60 * 1000, // 2 hours
  interview: 90 * 60 * 1000, // 1.5 hours
  registration: 60 * 60 * 1000, // 1 hour
  other: 60 * 60 * 1000, // 1 hour
};

/**
 * Returns the canonical fallback end time for an event that has no explicit
 * end time. Returns null when the start time is missing or invalid.
 */
export function deriveEventEndTime(
  eventType: string | null | undefined,
  title: string | null | undefined,
  startTime: Date | string | null | undefined
): Date | null {
  if (!startTime) return null;
  const start = startTime instanceof Date ? startTime : new Date(startTime);
  if (Number.isNaN(start.getTime())) return null;
  const kind = classifyEventDurationKind(eventType, title);
  return new Date(start.getTime() + (EVENT_DURATION_MS[kind] ?? EVENT_DURATION_MS.other));
}
