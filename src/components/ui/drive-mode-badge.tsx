import { Globe, Building2, Plane, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export function getDriveModeBadgeConfig(driveMode: string, requiresTravel = false) {
  const isOnline = driveMode === 'Online' || driveMode === 'Own location';
  const isCampus = driveMode.startsWith('VIT ');

  if (isOnline) {
    return {
      cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
      textCls: 'text-emerald-300',
      icon: Globe,
      tooltip: `Recruitment venue: ${driveMode}`,
    };
  }
  if (requiresTravel && driveMode !== 'To be announced') {
    return {
      cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
      textCls: 'text-amber-300',
      icon: Plane,
      tooltip: `Travel required: ${driveMode}`,
    };
  }
  if (isCampus) {
    return {
      cls: 'border-indigo-500/30 bg-indigo-500/15 text-indigo-300',
      textCls: 'text-indigo-300',
      icon: Building2,
      tooltip: `Recruitment venue: ${driveMode}`,
    };
  }
  if (driveMode === 'To be announced') {
    return {
      cls: 'border-zinc-700 bg-zinc-800/40 text-zinc-400',
      textCls: 'text-zinc-400',
      icon: HelpCircle,
      tooltip: 'Recruitment venue has not been announced',
    };
  }
  return {
    cls: 'border-cyan-500/30 bg-cyan-500/15 text-cyan-300',
    textCls: 'text-cyan-300',
    icon: Building2,
    tooltip: `Recruitment venue: ${driveMode}`,
  };
}

export function DriveModeBadge({
  driveMode,
  detail,
  requiresTravel,
  className,
}: {
  driveMode?: string | null;
  detail?: string;
  requiresTravel?: boolean;
  className?: string;
}) {
  if (!driveMode) return null;
  const config = getDriveModeBadgeConfig(driveMode, requiresTravel);
  const Icon = config.icon;

  return (
    <span
      className={cn(
        'flex items-center gap-1.5 shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium border transition-colors',
        config.cls,
        className
      )}
      title={detail ? `${config.tooltip}. ${detail}` : config.tooltip}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span>{driveMode}</span>
    </span>
  );
}
