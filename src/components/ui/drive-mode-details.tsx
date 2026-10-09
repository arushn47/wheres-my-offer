import { cn } from '@/lib/utils';
import { getDriveModeBadgeConfig } from './drive-mode-badge';
import type { DriveMode } from '@/lib/drive-venues';

export function DriveModeDetails({ label, requiresTravel }: {
  label: DriveMode;
  requiresTravel?: boolean;
}) {
  const config = getDriveModeBadgeConfig(label, requiresTravel);
  const Icon = config.icon;

  return (
    <div
      aria-label={`Drive mode: ${label}${requiresTravel ? '. Travel required' : ''}`}
      className={cn('font-tabular mt-1 flex min-w-0 items-center gap-2 whitespace-nowrap font-display text-base font-bold sm:text-lg', config.textCls)}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}
