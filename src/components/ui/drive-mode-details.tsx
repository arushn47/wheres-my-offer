'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getDriveModeBadgeConfig } from './drive-mode-badge';

export function DriveModeDetails({ label, detail, requiresTravel }: {
  label: string;
  detail?: string;
  requiresTravel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const container = useRef<HTMLDivElement>(null);
  const config = getDriveModeBadgeConfig(label, requiresTravel);
  const Icon = config.icon;
  const rounds = (detail || '').split(';').map(value => value.trim()).filter(Boolean);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [open]);

  return (
    <div
      ref={container}
      className="relative mt-1 w-fit max-w-full"
      onPointerEnter={event => { if (event.pointerType === 'mouse') setOpen(true); }}
      onPointerLeave={event => { if (event.pointerType === 'mouse') setOpen(false); }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); event.stopPropagation(); } }}
    >
      <button
        type="button"
        aria-label={`Drive mode: ${label}. Show venue details`}
        aria-describedby={open ? tooltipId : undefined}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        className={cn('font-tabular flex max-w-full items-center gap-2 rounded-md text-left font-display text-base font-bold outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 focus-visible:ring-offset-4 focus-visible:ring-offset-zinc-950 sm:text-lg', config.textCls)}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{label === 'To be announced' ? 'TBA' : label}</span>
        <Info aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-50" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 w-72 max-w-[calc(100vw-3rem)] pb-3 sm:left-auto sm:right-0">
          <div id={tooltipId} role="tooltip" className="rounded-xl border border-zinc-700/80 bg-zinc-950 p-3.5 text-xs shadow-2xl shadow-black/60">
            <div className="mb-2.5 flex items-center gap-2 border-b border-zinc-800 pb-2.5">
              <Icon aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0', config.textCls)} />
              <span className="font-medium text-zinc-200">{requiresTravel ? 'Travel required' : 'Recruitment venue'}</span>
            </div>
            {rounds.length ? (
              <div className="space-y-2">
                {rounds.map((round, index) => {
                  const separator = round.indexOf(':');
                  return separator > 0 ? (
                    <div key={index} className="flex items-start justify-between gap-4">
                      <span className="shrink-0 text-zinc-500">{round.slice(0, separator)}</span>
                      <span className="text-right font-medium text-zinc-200">{round.slice(separator + 1).trim()}</span>
                    </div>
                  ) : <p key={index} className="text-zinc-200">{round}</p>;
                })}
              </div>
            ) : <p className="text-zinc-200">{config.tooltip}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
