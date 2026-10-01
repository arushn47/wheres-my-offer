/** Event types for placement events */
export const EVENT_TYPES = {
  REGISTRATION_DEADLINE: 'registration_deadline',
  PPT: 'ppt',
  GROUP_DISCUSSION: 'group_discussion',
  ONLINE_TEST: 'online_test',
  CODING_TEST: 'coding_test',
  TECHNICAL_INTERVIEW: 'technical_interview',
  HR_INTERVIEW: 'hr_interview',
  FINAL_INTERVIEW: 'final_interview',
  RESULT: 'result',
  JOINING_DATE: 'joining_date',
  OTHER: 'other',
} as const;

export type EventType = typeof EVENT_TYPES[keyof typeof EVENT_TYPES];

/** Human-readable labels for each event type */
export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  registration_deadline: 'Registration Deadline',
  ppt: 'Pre-Placement Talk',
  group_discussion: 'Group Discussion',
  online_test: 'Online Test',
  coding_test: 'Coding Test',
  technical_interview: 'Technical Interview',
  hr_interview: 'HR Interview',
  final_interview: 'Final Interview',
  result: 'Result',
  joining_date: 'Joining Date',
  other: 'Other',
};

/** Color tokens for calendar event markers */
export const EVENT_TYPE_COLORS: Record<EventType, { bg: string; text: string; dot: string }> = {
  registration_deadline: { bg: 'bg-red-500/15',     text: 'text-red-400',     dot: 'bg-red-400' },
  ppt:                   { bg: 'bg-violet-500/15',  text: 'text-violet-400',  dot: 'bg-violet-400' },
  group_discussion:      { bg: 'bg-purple-500/15',  text: 'text-purple-400',  dot: 'bg-purple-400' },
  online_test:           { bg: 'bg-amber-500/15',   text: 'text-amber-400',   dot: 'bg-amber-400' },
  coding_test:           { bg: 'bg-orange-500/15',  text: 'text-orange-400',  dot: 'bg-orange-400' },
  technical_interview:   { bg: 'bg-emerald-500/15', text: 'text-emerald-400', dot: 'bg-emerald-400' },
  hr_interview:          { bg: 'bg-teal-500/15',    text: 'text-teal-400',    dot: 'bg-teal-400' },
  final_interview:       { bg: 'bg-green-500/15',   text: 'text-green-400',   dot: 'bg-green-400' },
  result:                { bg: 'bg-cyan-500/15',    text: 'text-cyan-400',    dot: 'bg-cyan-400' },
  joining_date:          { bg: 'bg-blue-500/15',    text: 'text-blue-400',    dot: 'bg-blue-400' },
  other:                 { bg: 'bg-zinc-500/15',    text: 'text-zinc-400',    dot: 'bg-zinc-400' },
};

/** Icons for each event type (Lucide icon names) */
export const EVENT_TYPE_ICONS: Record<EventType, string> = {
  registration_deadline: 'Clock',
  ppt: 'Presentation',
  group_discussion: 'Users2',
  online_test: 'FileCode',
  coding_test: 'Code',
  technical_interview: 'MessageSquare',
  hr_interview: 'Users',
  final_interview: 'Award',
  result: 'Trophy',
  joining_date: 'CalendarCheck',
  other: 'Circle',
};
