'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getDriveModeBadgeConfig } from './drive-mode-badge';
import { DriveVenueRounds } from './drive-venue-rounds';
import type { DriveMode, DriveModeRound } from '@/lib/drive-venues';

export function DriveModeDetails({ label, requiresTravel, rounds = [] }: {
  label: DriveMode;
  requiresTravel?: boolean;
  rounds?: DriveModeRound[];
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popupId = useId();
  const config = getDriveModeBadgeConfig(label, requiresTravel);
  const Icon = config.icon;

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (container.current?.contains(document.activeElement)) trigger.current?.focus();
      setOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [open]);

  return (
    <div
      ref={container}
      className="relative mt-1"
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') setOpen(true); }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse' && !event.currentTarget.contains(document.activeElement)) setOpen(false);
      }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={`Drive mode: ${label}${requiresTravel ? '. Travel required' : ''}. View round venues`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popupId}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        className={cn('font-tabular flex max-w-full min-w-0 cursor-help items-center gap-2 rounded whitespace-nowrap text-left font-display text-base font-bold outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 sm:text-lg', config.textCls)}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate border-b border-dashed border-current/30">{label}</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 w-72 max-w-[calc(100vw-4rem)] pt-2 sm:left-auto sm:right-0 sm:w-96">
          <div id={popupId} role="dialog" aria-label="Round venues" className="relative max-h-[60vh] overflow-y-auto rounded-xl border border-zinc-700/80 bg-zinc-950 p-3.5 shadow-2xl">
            <button
              type="button"
              aria-label="Close round venues"
              onClick={() => { trigger.current?.focus(); setOpen(false); }}
              className="absolute right-2 top-2 rounded p-1 text-zinc-500 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-emerald-400"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <DriveVenueRounds rounds={rounds} compact />
          </div>
        </div>
      )}
    </div>
  );
}
