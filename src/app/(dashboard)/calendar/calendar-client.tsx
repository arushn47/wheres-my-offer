'use client';

import { useMemo, useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { appToast } from '@/components/ui/toast';
import { cleanEventTitle } from '@/lib/sync/events';
import {
  CalendarPlus,
  MapPin,
  Clock,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  X,
  ArrowRight,
  Calendar as CalendarIcon,
} from 'lucide-react';
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  format,
  isToday,
  addMonths,
  subMonths,
} from 'date-fns';

export interface CalendarEvent {
  id: string;
  companyId: string;
  companyName: string;
  eventType: string;
  title: string | null;
  startTime: string | null;
  endTime: string | null;
  venue: string | null;
  mode: string | null;
}

interface CalendarClientProps {
  events: CalendarEvent[];
}

const EVENT_META: Record<string, { label: string; cls: string; dot: string }> = {
  ppt: { label: 'PPT', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', dot: 'bg-sky-400' },
  test: { label: 'Test', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/40', dot: 'bg-amber-400' },
  interview: { label: 'Interview', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/40', dot: 'bg-emerald-400' },
  deadline: { label: 'Deadline', cls: 'bg-rose-500/10 text-rose-300 border-rose-500/30', dot: 'bg-rose-400' },
};

function normalizeEventType(type: string): 'ppt' | 'test' | 'interview' | 'deadline' {
  const t = (type || '').toLowerCase();
  if (t.includes('ppt')) return 'ppt';
  if (t.includes('test') || t.includes('assessment') || t.includes('oa')) return 'test';
  if (t.includes('interview')) return 'interview';
  if (t.includes('deadline') || t.includes('registration')) return 'deadline';
  return 'test';
}

function timeLabel(dateStr: string | null) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffHours = Math.round((d.getTime() - now.getTime()) / (1000 * 60 * 60));
  const diffDays = Math.round((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (diffHours > 0 && diffHours < 24) {
    return `in ${diffHours} hrs · ${format(d, 'h:mm a')}`;
  }
  if (diffDays > 0 && diffDays <= 7) {
    return `in ${diffDays} days · ${format(d, 'h:mm a')}`;
  }
  if (diffDays < 0) {
    return `${Math.abs(diffDays)}d ago`;
  }
  return format(d, 'd MMM · h:mm a');
}

function getGcalUrl(companyName: string, title: string | null, label: string, startTime: string | null, venue: string | null) {
  if (!startTime) return null;
  const startIso = new Date(startTime).toISOString().replace(/-|:|\.\d+/g, '');
  const endIso = new Date(new Date(startTime).getTime() + 3600000).toISOString().replace(/-|:|\.\d+/g, '');
  const cleanTitle = cleanEventTitle(title, companyName, label);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(
    `${companyName} — ${cleanTitle}`
  )}&dates=${startIso}/${endIso}&location=${encodeURIComponent(
    venue || 'VIT Campus / Online'
  )}`;
}

export default function CalendarClient({ events }: CalendarClientProps) {
  const [view, setView] = useState<'month' | 'agenda'>('month');
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [isSyncingGcal, setIsSyncingGcal] = useState(false);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [showPastEvents, setShowPastEvents] = useState(false);
  const scheduleSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedDay(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const days = useMemo(() => {
    const m = startOfMonth(currentMonth);
    return eachDayOfInterval({ start: startOfWeek(m), end: endOfWeek(endOfMonth(m)) });
  }, [currentMonth]);

  const eventsOn = (day: Date) => {
    return events.filter((e) => e.startTime && isSameDay(new Date(e.startTime), day));
  };

  const selectedDayEvents = useMemo(() => {
    if (!selectedDay) return [];
    return eventsOn(selectedDay);
  }, [selectedDay, events]);

  const currentMonthEvents = useMemo(() => {
    return events
      .filter((e) => e.startTime && isSameMonth(new Date(e.startTime), currentMonth))
      .sort((a, b) => {
        const timeA = a.startTime ? new Date(a.startTime).getTime() : 0;
        const timeB = b.startTime ? new Date(b.startTime).getTime() : 0;
        return timeA - timeB;
      });
  }, [events, currentMonth]);

  const activeMonthDisplayEvents = selectedDay ? selectedDayEvents : currentMonthEvents;

  const { upcomingEvents, pastEvents } = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const upcoming: CalendarEvent[] = [];
    const past: CalendarEvent[] = [];

    for (const e of events) {
      if (!e.startTime) {
        past.push(e);
        continue;
      }
      const time = new Date(e.startTime).getTime();
      if (time >= todayStart) {
        upcoming.push(e);
      } else {
        past.push(e);
      }
    }

    // Upcoming sorted chronologically (soonest first)
    upcoming.sort((a, b) => {
      const timeA = a.startTime ? new Date(a.startTime).getTime() : 0;
      const timeB = b.startTime ? new Date(b.startTime).getTime() : 0;
      return timeA - timeB;
    });

    // Past sorted recency-first (most recent past event first)
    past.sort((a, b) => {
      const timeA = a.startTime ? new Date(a.startTime).getTime() : 0;
      const timeB = b.startTime ? new Date(b.startTime).getTime() : 0;
      return timeB - timeA;
    });

    return { upcomingEvents: upcoming, pastEvents: past };
  }, [events]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedDay(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSyncGcal = async () => {
    setIsSyncingGcal(true);
    try {
      const res = await fetch('/api/calendar/push-all', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        if (data.error?.includes('auth') || data.error?.includes('reconnect')) {
          appToast.error('Google Calendar Not Connected', 'Link your Google account in Settings with calendar permissions enabled.');
        } else {
          appToast.error('Calendar Sync Error', data.error || 'Failed to sync events to Google Calendar.');
        }
        return;
      }

      appToast.success('Synced to Google Calendar', `${data.synced || events.length} placement events successfully reconciled.`);
    } catch {
      appToast.error('Network Error', 'Failed to reach calendar sync service.');
    } finally {
      setIsSyncingGcal(false);
    }
  };

  return (
    <div data-testid="calendar-page" className="mx-auto max-w-7xl w-full min-w-0 space-y-3 sm:space-y-3.5">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-4">
        <div>
          <h1 className="font-display text-xl sm:text-2xl font-extrabold tracking-tight text-white">
            Placement Schedule
          </h1>
          <p className="mt-0.5 text-xs text-zinc-400">
            PPTs, tests & interviews — auto-extracted from circulars
          </p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <button
            data-testid="gcal-sync-btn"
            onClick={handleSyncGcal}
            disabled={isSyncingGcal}
            className="flex items-center gap-1.5 sm:gap-2 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 sm:px-3.5 py-1.5 text-xs font-semibold text-sky-300 transition-colors hover:bg-sky-500/20 disabled:opacity-60 cursor-pointer"
          >
            <CalendarPlus className={`h-3.5 w-3.5 ${isSyncingGcal ? 'animate-spin' : ''}`} />
            <span className="hidden xs:inline">{isSyncingGcal ? 'Syncing…' : 'Sync Google Calendar'}</span>
            <span className="xs:hidden">{isSyncingGcal ? 'Syncing…' : 'Sync GCal'}</span>
          </button>
          <div className="flex rounded-full border border-zinc-800 bg-zinc-900/80 p-0.5" data-testid="view-toggle">
            {(['month', 'agenda'] as const).map((v) => (
              <button
                key={v}
                data-testid={`view-${v}-btn`}
                onClick={() => setView(v)}
                className={`rounded-full px-3.5 sm:px-4 py-1 text-xs font-semibold capitalize transition-all duration-200 cursor-pointer ${
                  view === v ? 'bg-zinc-800 text-zinc-100 font-bold shadow-sm' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div
        className="flex flex-wrap gap-3 sm:gap-4 font-mono text-[9px] sm:text-[10px] uppercase tracking-wider text-zinc-400"
        data-testid="calendar-legend"
      >
        {Object.entries(EVENT_META).map(([k, m]) => (
          <span key={k} className="flex items-center gap-1.5 select-none">
            <span className={`h-2 w-2 rounded-full ${m.dot} ring-1.5 ring-zinc-800/80`} /> {m.label}
          </span>
        ))}
      </div>

      {view === 'month' ? (
        <motion.div
          key="month"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="space-y-3"
        >
          {/* Main Month Grid Card */}
          <div
            className="overflow-hidden rounded-2xl border border-zinc-800/80 bg-[#101014] max-w-full shadow-xl"
            data-testid="month-grid"
          >
            {/* Month Header & Controls */}
            <div className="flex flex-col xs:flex-row xs:items-center justify-between border-b border-zinc-800/80 px-3.5 sm:px-5 py-2.5 sm:py-3 gap-2">
              <div className="flex items-center gap-2.5 sm:gap-3">
                <h2 className="font-display text-sm sm:text-base font-bold text-zinc-100">
                  {format(currentMonth, 'MMMM yyyy')}
                </h2>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
                    className="p-1 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors cursor-pointer"
                    title="Previous month"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setCurrentMonth(new Date())}
                    className="px-2 py-0.5 rounded-md font-mono text-[10px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors cursor-pointer"
                  >
                    Today
                  </button>
                  <button
                    onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
                    className="p-1 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors cursor-pointer"
                    title="Next month"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <span className="font-mono text-[9px] sm:text-[10px] uppercase tracking-wider text-zinc-500">
                {currentMonthEvents.length} events · 2027 Placement Season
              </span>
            </div>

            {/* Day Names Row */}
            <div className="grid grid-cols-7 border-b border-zinc-800/80 bg-zinc-950/40">
              {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map((d) => (
                <div key={d} className="px-1 sm:px-2 py-1.5 text-center font-mono text-[8px] sm:text-[9px] font-semibold tracking-widest text-zinc-500 select-none">
                  {d}
                </div>
              ))}
            </div>

            {/* Days Grid */}
            <div className="grid grid-cols-7">
              {days.map((day, i) => {
                const evs = eventsOn(day);
                const inMonth = isSameMonth(day, currentMonth);
                const today = isToday(day);
                const isSelected = selectedDay ? isSameDay(day, selectedDay) : false;
                const hasEvents = evs.length > 0;

                return (
                  <div
                    key={i}
                    data-testid={today ? 'calendar-today-cell' : `calendar-day-${format(day, 'd')}`}
                    onClick={() => {
                      if (selectedDay && isSameDay(selectedDay, day)) {
                        setSelectedDay(null);
                      } else {
                        setSelectedDay(day);
                        if (typeof window !== 'undefined' && window.innerWidth < 640) {
                          setTimeout(() => {
                            scheduleSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                          }, 50);
                        }
                      }
                    }}
                    className={`min-h-[56px] sm:min-h-[70px] lg:min-h-[80px] xl:min-h-[88px] cursor-pointer border-b border-r border-zinc-800/60 p-1 sm:p-1.5 transition-all hover:bg-zinc-800/30 ${
                      !inMonth ? 'opacity-25' : ''
                    } ${
                      isSelected
                        ? 'bg-emerald-500/[0.12] ring-1.5 ring-inset ring-emerald-400/80 z-10'
                        : today
                        ? 'bg-emerald-500/[0.05]'
                        : ''
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`inline-flex h-5 w-5 sm:h-5.5 sm:w-5.5 items-center justify-center rounded-full font-tabular text-[10px] sm:text-[11px] transition-colors ${
                          today
                            ? 'bg-emerald-500 font-bold text-zinc-950 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
                            : isSelected
                            ? 'bg-emerald-400/20 text-emerald-300 font-bold'
                            : 'text-zinc-400'
                        }`}
                      >
                        {format(day, 'd')}
                      </span>
                    </div>

                    {/* Mobile event dots */}
                    {hasEvents && (
                      <div className="flex flex-wrap gap-1 items-center justify-center mt-1 sm:hidden">
                        {evs.slice(0, 3).map((e) => {
                          const norm = normalizeEventType(e.eventType);
                          const meta = EVENT_META[norm];
                          return (
                            <span
                              key={e.id}
                              className={`h-1.5 w-1.5 rounded-full ${meta.dot} shadow-sm`}
                            />
                          );
                        })}
                        {evs.length > 3 && (
                          <span className="text-[7px] font-mono text-zinc-500 leading-none">
                            +{evs.length - 3}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Desktop event pills */}
                    <div className="mt-1 space-y-0.5 hidden sm:block">
                      {evs.slice(0, 2).map((e) => {
                        const norm = normalizeEventType(e.eventType);
                        const meta = EVENT_META[norm];

                        return (
                          <div
                            key={e.id}
                            className={`flex items-center gap-1 truncate rounded border px-1.5 py-0.5 text-[9px] font-medium transition-all hover:brightness-125 ${meta.cls}`}
                            title={`${e.companyName} — ${cleanEventTitle(e.title, e.companyName, meta.label)}`}
                          >
                            <span className={`h-1 w-1 shrink-0 rounded-full ${meta.dot}`} />
                            <span className="truncate">{e.companyName}</span>
                          </div>
                        );
                      })}
                      {evs.length > 2 && (
                        <div className="px-1 font-mono text-[9px] text-zinc-500 hover:text-emerald-400 transition-colors">
                          +{evs.length - 2} more
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Selected Date Event Widget (Appended below calendar ONLY on Mobile when a date is clicked) */}
          <div className="sm:hidden">
            <AnimatePresence>
              {selectedDay && (
                <motion.div
                  ref={scheduleSectionRef}
                  initial={{ opacity: 0, y: -6, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.98 }}
                  transition={{ duration: 0.2 }}
                  className="rounded-2xl border border-white/[0.08] bg-[#12141c] p-3.5 shadow-xl space-y-3"
                >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-white/[0.05] pb-2.5">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-mono text-xs font-bold shrink-0">
                      {format(selectedDay, 'd')}
                    </div>
                    <div>
                      <h3 className="font-display text-xs sm:text-sm font-bold text-zinc-100">
                        {format(selectedDay, 'EEEE, MMMM d, yyyy')}
                      </h3>
                      <p className="font-mono text-[10px] text-zinc-400">
                        {selectedDayEvents.length === 0
                          ? 'No placement events scheduled'
                          : `${selectedDayEvents.length} ${selectedDayEvents.length === 1 ? 'event scheduled' : 'events scheduled'}`}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setSelectedDay(null)}
                    className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition-colors cursor-pointer"
                    title="Close"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* Events list */}
                {selectedDayEvents.length === 0 ? (
                  <div className="py-3 px-1 text-center font-mono text-xs text-zinc-500">
                    No assessments, tests, or interviews scheduled for this date.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {selectedDayEvents.map((e) => {
                      const norm = normalizeEventType(e.eventType);
                      const m = EVENT_META[norm];
                      const gcalUrl = getGcalUrl(e.companyName, e.title, m.label, e.startTime, e.venue);

                      return (
                        <div
                          key={e.id}
                          className="rounded-xl border border-white/[0.06] bg-zinc-900/60 p-3 sm:p-3.5 space-y-2.5"
                        >
                          <div className="flex items-start justify-between gap-2.5">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <h4 className="font-display text-sm font-bold text-zinc-100 truncate">
                                  {e.companyName}
                                </h4>
                                <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider shrink-0 ${m.cls}`}>
                                  {m.label}
                                </span>
                              </div>
                              {(() => {
                                const subtitle = cleanEventTitle(e.title, e.companyName, m.label);
                                if (!subtitle || subtitle.toLowerCase() === m.label.toLowerCase()) return null;
                                return (
                                  <p className="mt-0.5 text-xs text-zinc-400 line-clamp-1">
                                    {subtitle}
                                  </p>
                                );
                              })()}
                            </div>

                            {e.startTime && (
                              <span className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-xs font-bold text-amber-300">
                                {format(new Date(e.startTime), 'h:mm a')}
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-zinc-400">
                            <span className="flex items-center gap-1.5 truncate max-w-[200px]">
                              <MapPin className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                              <span className="truncate">{e.venue || 'VIT Campus / Online'}</span>
                            </span>
                            {e.mode && (
                              <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-zinc-300">
                                {e.mode}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center justify-between border-t border-white/[0.04] pt-2">
                            <Link
                              href={`/companies/${e.companyId}`}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 active:scale-95 transition-all"
                            >
                              <span>Go to Company Drive</span>
                              <ArrowRight className="h-3.5 w-3.5" />
                            </Link>

                            {gcalUrl && (
                              <a
                                href={gcalUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-mono text-zinc-400 hover:text-white transition-colors"
                                title="Add to Google Calendar"
                              >
                                <CalendarPlus className="h-3.5 w-3.5 text-zinc-400" />
                                <span>Add to GCal</span>
                              </a>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
      ) : (
        <motion.div
          key="agenda"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mt-5 space-y-4"
          data-testid="agenda-list"
        >
          {/* Upcoming Events Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between px-1 pb-1">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
                Upcoming Rounds
              </span>
              <span className="font-mono text-[10px] text-zinc-500">
                {upcomingEvents.length} scheduled
              </span>
            </div>

            {upcomingEvents.length === 0 ? (
              <div className="rounded-2xl border border-zinc-800 bg-[#101014] p-8 text-center">
                <CheckCircle2 className="mx-auto h-8 w-8 text-zinc-600 mb-2" />
                <p className="font-display text-sm font-semibold text-zinc-400">No upcoming events right now</p>
                <p className="font-mono text-[11px] text-zinc-600 mt-1">
                  You will see rounds here as soon as new circulars or shortlists land.
                </p>
              </div>
            ) : (
              upcomingEvents.map((e) => {
                const norm = normalizeEventType(e.eventType);
                const m = EVENT_META[norm];

                return (
                  <div
                    key={e.id || `${e.companyId}-${e.startTime || ''}`}
                    onClick={() => {
                      if (e.startTime) {
                        const d = new Date(e.startTime);
                        setSelectedDay(d);
                        setView('month');
                      }
                    }}
                    data-testid={`agenda-event-${e.id}`}
                    className="group flex items-center gap-4 rounded-xl border border-zinc-800 bg-[#101014] px-4 py-3.5 transition-all duration-200 hover:border-zinc-700 cursor-pointer"
                  >
                    <div className={`flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg border ${m.cls}`}>
                      <span className="font-tabular text-sm font-bold leading-none">
                        {e.startTime ? format(new Date(e.startTime), 'd') : '—'}
                      </span>
                      <span className="font-mono text-[8px] uppercase">
                        {e.startTime ? format(new Date(e.startTime), 'MMM') : ''}
                      </span>
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-zinc-100 group-hover:text-emerald-300 transition-colors">
                          {e.companyName} — {cleanEventTitle(e.title, e.companyName, m.label)}
                        </span>
                        <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${m.cls}`}>
                          {m.label}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-zinc-500">
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {e.venue || 'VIT Campus / Online'}
                        </span>
                        <span className="font-mono text-[10px]">{e.mode || 'Online'}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="hidden shrink-0 items-center gap-1.5 font-tabular font-mono text-[11px] text-amber-300 sm:flex">
                        <Clock className="h-3.5 w-3.5" /> {timeLabel(e.startTime)}
                      </span>
                      <Link
                        href={`/companies/${e.companyId}`}
                        onClick={(event) => event.stopPropagation()}
                        className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900/80 px-2 py-1 text-[11px] font-medium text-zinc-400 hover:border-zinc-700 hover:text-emerald-300 transition-colors"
                        title="Direct to Company Drive"
                      >
                        <span>Drive</span>
                        <ArrowRight className="h-3 w-3" />
                      </Link>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Past Events Collapsible Section */}
          {pastEvents.length > 0 && (
            <div className="pt-2">
              <button
                type="button"
                onClick={() => setShowPastEvents((v) => !v)}
                className="flex w-full items-center justify-between rounded-xl border border-zinc-800/80 bg-[#101014]/50 px-4 py-3 text-left transition-colors hover:border-zinc-700 hover:bg-[#101014] cursor-pointer group"
              >
                <div className="flex items-center gap-2.5">
                  <Clock className="h-3.5 w-3.5 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
                  <span className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-400 group-hover:text-zinc-200 transition-colors">
                    Past Events
                  </span>
                  <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-0.5 font-mono text-[10px] text-zinc-500">
                    {pastEvents.length}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-zinc-500 group-hover:text-zinc-300">
                  <span className="font-mono text-[11px]">{showPastEvents ? 'Hide' : 'Show past'}</span>
                  <ChevronDown
                    className={`h-4 w-4 transition-transform duration-200 ${showPastEvents ? 'rotate-180' : ''
                      }`}
                  />
                </div>
              </button>

              {showPastEvents && (
                <div className="mt-2 space-y-2">
                  {pastEvents.map((e) => {
                    const norm = normalizeEventType(e.eventType);
                    const m = EVENT_META[norm];

                    return (
                      <div
                        key={e.id}
                        onClick={() => {
                          if (e.startTime) {
                            const d = new Date(e.startTime);
                            setSelectedDay(d);
                            setView('month');
                          }
                        }}
                        data-testid={`agenda-past-event-${e.id}`}
                        className="group flex items-center gap-4 rounded-xl border border-zinc-800/60 bg-[#101014]/70 px-4 py-3 opacity-60 transition-all duration-200 hover:opacity-100 hover:border-zinc-700 cursor-pointer"
                      >
                        <div className={`flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg border ${m.cls}`}>
                          <span className="font-tabular text-sm font-bold leading-none">
                            {e.startTime ? format(new Date(e.startTime), 'd') : '—'}
                          </span>
                          <span className="font-mono text-[8px] uppercase">
                            {e.startTime ? format(new Date(e.startTime), 'MMM') : ''}
                          </span>
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-semibold text-zinc-200 group-hover:text-emerald-300 transition-colors">
                              {e.companyName} — {cleanEventTitle(e.title, e.companyName, m.label)}
                            </span>
                            <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${m.cls}`}>
                              {m.label}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-zinc-500">
                            <span className="flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {e.venue || 'VIT Campus / Online'}
                            </span>
                            <span className="font-mono text-[10px]">{e.mode || 'Online'}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-3">
                          <span className="hidden shrink-0 items-center gap-1.5 font-tabular font-mono text-[11px] text-zinc-500 sm:flex">
                            <Clock className="h-3.5 w-3.5" /> {timeLabel(e.startTime)}
                          </span>
                          <Link
                            href={`/companies/${e.companyId}`}
                            onClick={(event) => event.stopPropagation()}
                            className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900/80 px-2 py-1 text-[11px] font-medium text-zinc-400 hover:border-zinc-700 hover:text-emerald-300 transition-colors"
                            title="Direct to Company Drive"
                          >
                            <span>Drive</span>
                            <ArrowRight className="h-3 w-3" />
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </motion.div>
      )}

      {/* Day Details Modal (Desktop PC Only - Hidden on Mobile) */}
      <AnimatePresence>
        {selectedDay && (
          <div className="hidden sm:flex fixed inset-0 z-50 items-center justify-center p-4 sm:p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/80 backdrop-blur-sm"
              onClick={() => setSelectedDay(null)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-zinc-800 bg-[#0e1015] shadow-2xl shadow-black/80"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between border-b border-zinc-800/80 px-6 py-5 bg-[#12141c]/50">
                <div className="flex items-center gap-3.5">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 font-mono text-base font-extrabold text-emerald-400">
                    {format(selectedDay, 'd')}
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                      {format(selectedDay, 'EEEE')}
                    </p>
                    <h3 className="font-display text-base sm:text-lg font-bold text-zinc-100">
                      {format(selectedDay, 'MMMM d, yyyy')}
                    </h3>
                  </div>
                </div>
                <div className="flex items-center gap-2.5">
                  {selectedDayEvents.length > 0 && (
                    <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-emerald-400">
                      {selectedDayEvents.length} {selectedDayEvents.length === 1 ? 'event' : 'events'}
                    </span>
                  )}
                  <button
                    onClick={() => setSelectedDay(null)}
                    className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors cursor-pointer"
                    aria-label="Close modal"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Event Cards List */}
              <div className="max-h-[60vh] overflow-y-auto p-5 space-y-3">
                {selectedDayEvents.length === 0 ? (
                  <div className="py-10 text-center">
                    <CalendarIcon className="mx-auto h-8 w-8 text-zinc-700 mb-2" />
                    <p className="font-display text-sm font-semibold text-zinc-400">No events on this date</p>
                    <p className="font-mono text-[11px] text-zinc-600 mt-1">
                      No PPTs, assessments, or interviews scheduled.
                    </p>
                  </div>
                ) : (
                  selectedDayEvents.map((evt) => {
                    const norm = normalizeEventType(evt.eventType);
                    const meta = EVENT_META[norm];
                    const gcalUrl = getGcalUrl(evt.companyName, evt.title, meta.label, evt.startTime, evt.venue);

                    return (
                      <div
                        key={evt.id}
                        className="rounded-xl border border-zinc-800 bg-[#12141a] p-4 transition-colors hover:border-zinc-700"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <h4 className="font-display text-sm font-bold text-zinc-100 truncate">
                                {evt.companyName}
                              </h4>
                              <span
                                className={`rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${meta.cls}`}
                              >
                                {meta.label}
                              </span>
                            </div>
                            {(() => {
                              const subtitle = cleanEventTitle(evt.title, evt.companyName, meta.label);
                              if (!subtitle || subtitle.toLowerCase() === meta.label.toLowerCase()) return null;
                              return (
                                <p className="mt-1 text-xs text-zinc-400 line-clamp-2">
                                  {subtitle}
                                </p>
                              );
                            })()}
                          </div>
                          {evt.startTime && (
                            <span className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-[11px] font-bold text-amber-300">
                              {format(new Date(evt.startTime), 'h:mm a')}
                            </span>
                          )}
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-[11px] text-zinc-500">
                          <span className="flex items-center gap-1.5">
                            <MapPin className="h-3.5 w-3.5 text-zinc-400" />
                            {evt.venue || 'VIT Campus / Online'}
                          </span>
                          {evt.mode && (
                            <span className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">
                              {evt.mode}
                            </span>
                          )}
                        </div>

                        <div className="mt-4 flex items-center justify-between border-t border-zinc-800/70 pt-3">
                          <Link
                            href={`/companies/${evt.companyId}`}
                            onClick={() => setSelectedDay(null)}
                            className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/20 hover:text-emerald-300 cursor-pointer"
                          >
                            <span>Go to Company Drive</span>
                            <ArrowRight className="h-3.5 w-3.5" />
                          </Link>
                          {gcalUrl && (
                            <a
                              href={gcalUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
                              title="Add to Google Calendar"
                            >
                              <CalendarPlus className="h-3.5 w-3.5" />
                              <span>Add to GCal</span>
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
