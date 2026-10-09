import { Globe, Building2, Plane, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DriveMode } from '@/lib/drive-venues';

export function getDriveModeBadgeConfig(driveMode: DriveMode, requiresTravel = false) {
  const isOnline = driveMode === 'Own Location';
  const isCampus = driveMode === 'Home Campus' || driveMode === 'Other Campus';

  if (isOnline) {
    return {
      cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
      textCls: 'text-emerald-300',
      icon: Globe,
      tooltip: 'Drive mode: Own Location — remote attendance',
    };
  }
  if (requiresTravel && driveMode !== 'TBA') {
    return {
      cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
      textCls: 'text-amber-300',
      icon: Plane,
      tooltip: `Drive mode: ${driveMode}. Travel required`,
    };
  }
  if (isCampus) {
    return {
      cls: 'border-indigo-500/30 bg-indigo-500/15 text-indigo-300',
      textCls: 'text-indigo-300',
      icon: Building2,
      tooltip: `Drive mode: ${driveMode} — physical campus attendance`,
    };
  }
  if (driveMode === 'TBA') {
    return {
      cls: 'border-zinc-700 bg-zinc-800/40 text-zinc-400',
      textCls: 'text-zinc-400',
      icon: HelpCircle,
      tooltip: 'Attendance mode or venue has not been confirmed',
    };
  }
  return {
    cls: 'border-cyan-500/30 bg-cyan-500/15 text-cyan-300',
    textCls: 'text-cyan-300',
    icon: Building2,
    tooltip: 'Drive mode: External Venue — physical attendance at a company office or another external venue',
  };
}

export function DriveModeBadge({
  driveMode = 'TBA',
  detail,
  shortVenue,
  requiresTravel,
  className,
}: {
  driveMode?: DriveMode | null;
  detail?: string;
  shortVenue?: string;
  requiresTravel?: boolean;
  className?: string;
}) {
  driveMode = driveMode || 'TBA';
  const config = getDriveModeBadgeConfig(driveMode, requiresTravel);
  const Icon = config.icon;

  return (
    <span
      className={cn(
        'flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium border transition-colors',
        config.cls,
        className
      )}
      title={`${config.tooltip}${shortVenue ? ` · ${shortVenue}` : ''}${detail ? `. ${detail}` : ''}`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="shrink-0">{driveMode}</span>
      {shortVenue && driveMode !== 'Own Location' && driveMode !== 'TBA' && (
        <><span aria-hidden="true">·</span><span className="max-w-36 truncate">{shortVenue}</span></>
      )}
    </span>
  );
}
