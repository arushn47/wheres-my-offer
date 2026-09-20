import React from 'react';
import { Globe, Building2, Plane } from 'lucide-react';
import { cn } from '@/lib/utils';

export function getDriveModeBadgeConfig(driveMode: string) {
  const isOnline = driveMode === 'Online';
  const isHomeLabs = driveMode.endsWith('Labs');
  const isVellore = driveMode === 'VIT Vellore';
  const isChennai = driveMode === 'VIT Chennai';
  const isAp = driveMode === 'VIT AP';

  if (isOnline) {
    return {
      cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
      icon: Globe,
      tooltip: 'Drive Mode: Online (Virtual from hostel)',
    };
  }
  if (isHomeLabs) {
    return {
      cls: 'border-indigo-500/30 bg-indigo-500/15 text-indigo-300',
      icon: Building2,
      tooltip: `Drive Mode: ${driveMode} (On-Campus Labs / Proctored)`,
    };
  }
  if (isVellore) {
    return {
      cls: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
      icon: Plane,
      tooltip: 'Drive Mode: VIT Vellore (Inter-Campus Travel Required)',
    };
  }
  if (isChennai) {
    return {
      cls: 'border-orange-500/30 bg-orange-500/15 text-orange-300',
      icon: Plane,
      tooltip: 'Drive Mode: VIT Chennai (Inter-Campus Travel Required)',
    };
  }
  if (isAp) {
    return {
      cls: 'border-purple-500/30 bg-purple-500/15 text-purple-300',
      icon: Plane,
      tooltip: 'Drive Mode: VIT AP (Inter-Campus Travel Required)',
    };
  }
  return {
    cls: 'border-cyan-500/30 bg-cyan-500/15 text-cyan-300',
    icon: Plane,
    tooltip: `Drive Mode: ${driveMode} (Inter-Campus Travel Required)`,
  };
}

export function DriveModeBadge({
  driveMode,
  className,
}: {
  driveMode?: string | null;
  className?: string;
}) {
  if (!driveMode) return null;
  const config = getDriveModeBadgeConfig(driveMode);
  const Icon = config.icon;

  return (
    <span
      className={cn(
        'flex items-center gap-1.5 shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium border transition-colors',
        config.cls,
        className
      )}
      title={config.tooltip}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span>{driveMode}</span>
    </span>
  );
}
