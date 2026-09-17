import React from 'react';

export const STATUS_META: Record<string, { label: string; cls: string; dot: string; isPulse?: boolean }> = {
  not_applied: { label: 'Not Applied', cls: 'bg-zinc-800/40 text-zinc-400 border-zinc-700/40', dot: 'bg-zinc-500' },
  registration_open: { label: 'Registration Open', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30', dot: 'bg-amber-400', isPulse: true },
  applied: { label: 'Applied', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25', dot: 'bg-emerald-400' },
  shortlisted: { label: 'Shortlisted', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', dot: 'bg-sky-400' },
  test: { label: 'Test Scheduled', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', dot: 'bg-sky-400', isPulse: true },
  test_scheduled: { label: 'Test Scheduled', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', dot: 'bg-sky-400', isPulse: true },
  test_ongoing: { label: 'Test Live', cls: 'bg-amber-500/15 text-amber-200 border-amber-500/40 shadow-sm shadow-amber-500/10', dot: 'bg-amber-400', isPulse: true },
  test_completed: { label: 'Test Completed', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', dot: 'bg-emerald-400' },
  ppt: { label: 'PPT Scheduled', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', dot: 'bg-sky-400', isPulse: true },
  ppt_scheduled: { label: 'PPT Scheduled', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', dot: 'bg-sky-400', isPulse: true },
  ppt_ongoing: { label: 'PPT Live', cls: 'bg-amber-500/15 text-amber-200 border-amber-500/40 shadow-sm shadow-amber-500/10', dot: 'bg-amber-400', isPulse: true },
  ppt_completed: { label: 'PPT Completed', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', dot: 'bg-emerald-400' },
  interview: { label: 'Interview Scheduled', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', dot: 'bg-sky-400', isPulse: true },
  interview_scheduled: { label: 'Interview Scheduled', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', dot: 'bg-sky-400', isPulse: true },
  interview_ongoing: { label: 'Interview Live', cls: 'bg-amber-500/15 text-amber-200 border-amber-500/40 shadow-sm shadow-amber-500/10', dot: 'bg-amber-400', isPulse: true },
  interview_completed: { label: 'Interview Completed', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', dot: 'bg-emerald-400' },
  offer: { label: 'Offer Received', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35 shadow-sm shadow-emerald-500/20', dot: 'bg-emerald-400' },
  offer_received: { label: 'Offer Received', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35 shadow-sm shadow-emerald-500/20', dot: 'bg-emerald-400' },
  selected: { label: 'Selected / Offer', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35 shadow-sm shadow-emerald-500/20', dot: 'bg-emerald-400' },
  rejected: { label: 'Eliminated', cls: 'bg-rose-500/10 text-rose-400 border-rose-500/25', dot: 'bg-rose-400' },
  rejected_test: { label: 'Eliminated in Test', cls: 'bg-rose-500/10 text-rose-400 border-rose-500/25', dot: 'bg-rose-400' },
  test_eliminated: { label: 'Eliminated in Test', cls: 'bg-rose-500/10 text-rose-400 border-rose-500/25', dot: 'bg-rose-400' },
  rejected_interview: { label: 'Interviewed · Not Selected', cls: 'bg-rose-500/10 text-rose-400 border-rose-500/25', dot: 'bg-rose-400' },
  interview_eliminated: { label: 'Interviewed · Not Selected', cls: 'bg-rose-500/10 text-rose-400 border-rose-500/25', dot: 'bg-rose-400' },
  not_shortlisted: { label: 'Not Shortlisted', cls: 'bg-rose-500/10 text-rose-400 border-rose-500/25', dot: 'bg-rose-400' },
  withdrawn: { label: 'Withdrawn', cls: 'bg-zinc-800/40 text-zinc-400 border-zinc-700/40', dot: 'bg-zinc-500' },
  declined: { label: 'Declined', cls: 'bg-zinc-800/40 text-zinc-400 border-zinc-700/40', dot: 'bg-zinc-500' },
};

export const EVENT_META: Record<string, { label: string; cls: string; dot: string }> = {
  ppt: { label: 'PPT', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', dot: 'bg-sky-400' },
  test: { label: 'Test', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', dot: 'bg-sky-400' },
  interview: { label: 'Interview', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', dot: 'bg-sky-400' },
  deadline: { label: 'Deadline', cls: 'bg-rose-500/10 text-rose-400 border-rose-500/25', dot: 'bg-rose-400' },
  offer: { label: 'Offer', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35', dot: 'bg-emerald-400' },
};

interface StatusChipProps {
  status: string;
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
}

export const StatusChip: React.FC<StatusChipProps> = ({ status, label, size = 'sm', className = '' }) => {
  const normStatus = (status || 'not_applied').toLowerCase();
  const m = STATUS_META[normStatus] || STATUS_META.not_applied;

  return (
    <span
      data-testid={`status-chip-${normStatus}`}
      className={`inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap rounded-full border font-medium ${m.cls} ${size === 'sm' ? 'px-2.5 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'
        } ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${m.dot} ${m.isPulse ? 'pulse-dot' : ''}`} />
      {label || m.label}
    </span>
  );
};

export const CategoryBadge: React.FC<{ category?: string | null; className?: string }> = ({ category, className = '' }) => {
  if (!category) return null;
  const isSuperDream = /super\s*dream/i.test(category);
  const isDream = /dream/i.test(category) && !isSuperDream;
  const displayCategory = isSuperDream ? 'Super Dream' : isDream ? 'Dream' : category;

  const cls = isSuperDream
    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
    : isDream
      ? 'bg-zinc-800/60 text-zinc-300 border-zinc-700/50'
      : 'bg-zinc-900/40 text-zinc-400 border-zinc-800';

  return (
    <span
      data-testid={`category-badge-${displayCategory.replace(/\s/g, '-').toLowerCase()}`}
      className={`inline-flex items-center shrink-0 whitespace-nowrap rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls} ${className}`}
    >
      {displayCategory}
    </span>
  );
};
