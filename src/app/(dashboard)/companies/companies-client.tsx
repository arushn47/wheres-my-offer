'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  Search,
  Clock,
  MapPin,
  Building2,
  Plane,
  Globe,
  ArrowUpRight,
  ChevronDown,
  Check,
  ArrowUpDown,
  X,
  Tag,
  Zap,
  CheckCircle2,
  AlertCircle,
  Calendar,
} from 'lucide-react';
import { cn, timeAgo, formatDate, formatStipend, getDriveMode } from '@/lib/utils';
import { StatusChip, CategoryBadge } from '@/components/ui/status-chip';
import { DriveModeBadge } from '@/components/ui/drive-mode-badge';
import {
  StageStepper,
  getStageIndex,
  getEffectiveStage,
  isEliminatedStatus,
  isInactiveStatus,
} from '@/components/companies/stage-stepper';
import { cleanLocationString } from '@/lib/sync/locations';

export interface CompanyWithDetails {
  id: string;
  name: string;
  legal_name: string | null;
  aliases: string[] | null;
  drive_number?: string | null;
  drive_name?: string | null;
  updated_at: string;
  latestEmailDate?: string;
  application: {
    id: string;
    status: string;
    role: string | null;
    category?: string | null;
    ctc: string | null;
    stipend: string | null;
    location: string | null;
    notes?: string | null;
    manual_override: boolean;
    applied_at: string | null;
    last_updated: string;
    registration_deadline?: string | null;
  } | null;
  latestEvent: {
    id: string;
    event_type: string;
    title: string | null;
    start_time: string | null;
    venue: string | null;
    mode: string | null;
  } | null;
  events?: Array<{
    id: string;
    event_type: string;
    title: string;
    start_time: string | null;
    venue?: string | null;
    mode?: string | null;
  }>;
  neoIdMatched: boolean;
  emailCount: number;
}

interface CompaniesClientProps {
  companies: CompanyWithDetails[];
  userCampus?: 'VIT Bhopal' | 'VIT Vellore' | 'VIT Chennai' | 'VIT AP';
}

const FILTERS = [
  { id: 'active', label: 'Active' },
  { id: 'shortlisted', label: 'Shortlisted' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'not_shortlisted', label: 'Not Shortlisted' },
  { id: 'withdrawn', label: 'Withdrawn' },
  { id: 'not_applied', label: 'Not Applied' },
  { id: 'all', label: 'All' },
];

const getFutureRegistrationDeadline = (company: CompanyWithDetails): Date | null => {
  const now = Date.now();
  const evt = (company.events || []).find(
    (event) =>
      event.event_type === 'registration_deadline' &&
      Boolean(event.start_time) &&
      new Date(event.start_time!).getTime() > now
  );
  if (evt?.start_time) return new Date(evt.start_time);
  if (company.application?.registration_deadline) {
    const d = new Date(company.application.registration_deadline);
    if (d.getTime() > now) return d;
  }
  return null;
};

const hasFutureRegistrationDeadline = (company: CompanyWithDetails) =>
  Boolean(getFutureRegistrationDeadline(company));

const formatDeadlineCountdown = (d: Date): string => {
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return 'Closed';
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const mins = Math.round((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (hours >= 24) {
    const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
    return `${days}d`;
  }
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
};

const matchFilter = (status: string, filter: string, company?: CompanyWithDetails) => {
  const s = status.toLowerCase();
  if (filter === 'all') return true;
  if (filter === 'active') {
    // Active = everything currently in progress (applied, scheduled, completed, shortlisted, offers, registration_open)
    // Terminal rejections across ANY stage, non-registrations, and withdrawals are excluded
    if (s === 'registration_open') return true;
    return !isInactiveStatus(s) || (s === 'not_applied' && Boolean(company && hasFutureRegistrationDeadline(company)));
  }
  if (filter === 'shortlisted') {
    // Only active shortlists for upcoming rounds, selections, or offers (NOT completed rounds awaiting results, and NOT eliminated)
    if (s.includes('completed') || isEliminatedStatus(s)) return false;
    return [
      'shortlisted',
      'test_scheduled',
      'test_ongoing',
      'interview_scheduled',
      'interview_ongoing',
      'interview',
      'test',
      'selected',
      'offer',
      'offer_received',
    ].includes(s);
  }
  if (filter === 'scheduled') {
    // Only upcoming scheduled events (NOT completed events, NOT eliminated)
    if (s.includes('completed') || isEliminatedStatus(s)) return false;
    return [
      'test_scheduled',
      'test_ongoing',
      'interview_scheduled',
      'interview_ongoing',
      'ppt_scheduled',
      'ppt_ongoing',
      'test',
      'ppt',
      'interview',
    ].includes(s);
  }
  if (filter === 'not_shortlisted') {
    // All forms of elimination across all rounds (screening, test round, or interview round)
    return isEliminatedStatus(s);
  }
  if (filter === 'withdrawn') return ['withdrawn', 'declined'].includes(s);
  if (filter === 'not_applied') return s === 'not_applied' || s === 'registration_open';
  return true;
};

const NEXT_EVENT_CLS: Record<string, string> = {
  online_test: 'border-amber-500/30 bg-amber-500/[0.07] text-amber-300',
  coding_test: 'border-amber-500/30 bg-amber-500/[0.07] text-amber-300',
  technical_interview: 'border-cyan-500/30 bg-cyan-500/[0.07] text-cyan-300',
  hr_interview: 'border-cyan-500/30 bg-cyan-500/[0.07] text-cyan-300',
  interview: 'border-cyan-500/30 bg-cyan-500/[0.07] text-cyan-300',
  ppt: 'border-sky-500/30 bg-sky-500/[0.07] text-sky-300',
  test: 'border-amber-500/30 bg-amber-500/[0.07] text-amber-300',
  deadline: 'border-rose-500/30 bg-rose-500/[0.07] text-rose-300',
};

const HUES = [
  'border-amber-500/30 bg-amber-500/10 text-amber-300',
  'border-sky-500/30 bg-sky-500/10 text-sky-300',
  'border-rose-500/30 bg-rose-500/10 text-rose-300',
  'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  'border-violet-500/30 bg-violet-500/10 text-violet-300',
];

function getHue(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return HUES[hash % HUES.length];
}

function formatEventTime(dateStr: string | null) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffHours = Math.round(diffMs / (1000 * 60 * 60));
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const dateStrShort = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const hasSpecificTime = !(date.getHours() === 0 && date.getMinutes() === 0);

  if (diffHours > 0 && diffHours < 24) {
    return hasSpecificTime ? `in ${diffHours}h · ${timeStr}` : 'Today';
  }
  if (diffDays === 1) {
    return hasSpecificTime ? `Tomorrow · ${timeStr}` : 'Tomorrow';
  }
  if (diffDays > 1 && diffDays <= 7) {
    return hasSpecificTime ? `${dateStrShort} · ${timeStr}` : `in ${diffDays}d (${dateStrShort})`;
  }
  return hasSpecificTime ? `${dateStrShort} · ${timeStr}` : dateStrShort;
}

export default function CompaniesClient({
  companies,
  userCampus = 'VIT Bhopal',
}: CompaniesClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(searchParams.get('q') || searchParams.get('search') || '');
  const urlFilter = searchParams.get('filter');
  const [filter, setFilter] = useState(urlFilter || 'active');

  const updateUrl = (newFilter: string, newQ?: string) => {
    const params = new URLSearchParams();
    if (newFilter) {
      params.set('filter', newFilter);
    }
    const currentQ = newQ !== undefined ? newQ : q;
    if (currentQ.trim()) {
      params.set('q', currentQ.trim());
    }
    const qs = params.toString();
    router.replace(qs ? `/companies?${qs}` : '/companies', { scroll: false });
  };

  const handleFilterChange = (newFilter: string) => {
    setFilter(newFilter);
    updateUrl(newFilter, q);
  };

  const handleSearchChange = (val: string) => {
    setQ(val);
    updateUrl(filter, val);
  };

  const handleClearSearch = () => {
    setQ('');
    updateUrl(filter, '');
  };

  useEffect(() => {
    const currentParam = searchParams.get('filter') || 'active';
    if (currentParam !== filter) {
      setFilter(currentParam);
    }
    const currentQ = searchParams.get('q') || searchParams.get('search') || '';
    if (currentQ !== q) {
      setQ(currentQ);
    }
  }, [searchParams]);

  const filteredCompanies = useMemo(() => {
    const list = companies
      .filter((c) => {
        const rawStatus = c.application?.status || 'applied';
        const { effectiveStatus } = getEffectiveStage(rawStatus, c.latestEvent, c.events, c.application?.notes, c.application?.manual_override);
        return matchFilter(effectiveStatus, filter, c);
      })
      .filter((c) => {
        if (!q.trim()) return true;
        const haystack = `${c.name} ${c.application?.role || ''} ${c.application?.ctc || ''} ${c.application?.location || ''}`.toLowerCase();
        return haystack.includes(q.toLowerCase().trim());
      });

    if (filter === 'active') {
      const now = Date.now();
      return [...list].sort((a, b) => {
        // 1. Any open registration deadline or confirmed upcoming round (Interview, Test, PPT) sorted by soonest date first
        const getNextRoundTime = (comp: CompanyWithDetails) => {
          const regDeadline = getFutureRegistrationDeadline(comp);
          const compEvents = comp.events || (comp.latestEvent ? [comp.latestEvent] : []);
          const upcoming = compEvents
            .filter((e) => {
              const isRound = /interview|test|coding|assessment|ppt|pre-placement|registration_deadline/i.test(
                `${e.event_type || ''} ${e.title || ''}`
              );
              const t = e.start_time ? new Date(e.start_time).getTime() : 0;
              return isRound && t > now;
            })
            .sort((x, y) => new Date(x.start_time!).getTime() - new Date(y.start_time!).getTime());

          const nextEvtTime = upcoming.length > 0 ? new Date(upcoming[0].start_time!).getTime() : null;
          if (regDeadline && nextEvtTime) return Math.min(regDeadline.getTime(), nextEvtTime);
          if (regDeadline) return regDeadline.getTime();
          return nextEvtTime;
        };

        const nextA = getNextRoundTime(a);
        const nextB = getNextRoundTime(b);

        // If both have upcoming rounds/deadlines, earliest date/time takes top priority
        if (nextA !== null && nextB !== null) return nextA - nextB;
        // If one has an upcoming round/deadline, it floats above non-scheduled drives
        if (nextA !== null) return -1;
        if (nextB !== null) return 1;

        // 2. Funnel Progression Rank (Deepest in recruitment pipeline first)
        const getRank = (comp: CompanyWithDetails) => {
          const rawStatus = comp.application?.status || 'applied';
          const eff = getEffectiveStage(rawStatus, comp.latestEvent, comp.events, comp.application?.notes, comp.application?.manual_override);
          const s = eff.effectiveStatus.toLowerCase();
          if (s === 'selected' || s === 'offer' || s === 'offer_received') return 100;
          if (s === 'interview_completed') return 90;
          if (s === 'interview_scheduled' || s === 'interview') return 80;
          if (s === 'test_completed') return 70; // e.g. Goldman Sachs, EY GDS, Cummins
          if (s === 'test_scheduled' || s === 'test') return 60; // e.g. Playsimple Games
          if (s === 'ppt_completed') return 50; // e.g. Unilever, EY SAP
          if (s === 'ppt_scheduled' || s === 'ppt') return 40;
          if (s === 'registration_open') return 35;
          return 10; // applied
        };

        const rankA = getRank(a);
        const rankB = getRank(b);
        if (rankB !== rankA) return rankB - rankA;

        // 3. Secondary sort: prioritize manual/bot updates, else latest email circular / applied_at
        const isManualA = a.application?.manual_override && a.application?.last_updated;
        const isManualB = b.application?.manual_override && b.application?.last_updated;
        const dateA = new Date(isManualA ? a.application!.last_updated : a.latestEmailDate || a.application?.applied_at || a.updated_at || 0).getTime();
        const dateB = new Date(isManualB ? b.application!.last_updated : b.latestEmailDate || b.application?.applied_at || b.updated_at || 0).getTime();
        return dateB - dateA;
      });
    }

    if (filter === 'not_shortlisted') {
      return [...list].sort((a, b) => {
        const getRank = (comp: CompanyWithDetails) => {
          const rawStatus = comp.application?.status || 'applied';
          const eff = getEffectiveStage(rawStatus, comp.latestEvent, comp.events, comp.application?.notes, comp.application?.manual_override);
          if (eff.eliminatedStage === 3) return 4; // Interview round eliminated
          if (eff.effectiveStatus === 'rejected' && eff.eliminatedStage === 2) return 3; // Eliminated in test round
          if (eff.eliminatedStage === 2) return 2; // Not shortlisted for test (after PPT)
          return 1; // Screened out in initial screening (stage 0)
        };

        const rankA = getRank(a);
        const rankB = getRank(b);
        if (rankB !== rankA) {
          return rankB - rankA; // Higher progression first (test/interview eliminated at top)
        }

        // Secondary sort: most recent email/update first
        const dateA = new Date(a.latestEmailDate || a.updated_at || 0).getTime();
        const dateB = new Date(b.latestEmailDate || b.updated_at || 0).getTime();
        return dateB - dateA;
      });
    }

    return list;
  }, [companies, filter, q]);

  const filterCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: companies.length,
      active: 0,
      shortlisted: 0,
      scheduled: 0,
      not_shortlisted: 0,
      withdrawn: 0,
      not_applied: 0,
    };
    for (const c of companies) {
      const rawStatus = c.application?.status || 'applied';
      const eff = getEffectiveStage(rawStatus, c.latestEvent, c.events, c.application?.notes, c.application?.manual_override);
      const st = eff.effectiveStatus;
      if (matchFilter(st, 'active', c)) counts.active++;
      if (matchFilter(st, 'shortlisted')) counts.shortlisted++;
      if (matchFilter(st, 'scheduled')) counts.scheduled++;
      if (matchFilter(st, 'not_shortlisted')) counts.not_shortlisted++;
      if (matchFilter(st, 'withdrawn')) counts.withdrawn++;
      if (matchFilter(st, 'not_applied')) counts.not_applied++;
    }
    return counts;
  }, [companies]);

  return (
    <div data-testid="companies-page" className="mx-auto max-w-7xl w-full min-w-0">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 sm:gap-4">
        <div>
          <div className="flex items-center gap-2.5 sm:gap-3">
            <h1 className="font-display text-xl sm:text-3xl font-extrabold tracking-tight text-zinc-100">
              Placement Drives
            </h1>
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-xs font-bold text-emerald-300">
              {companies.length}
            </span>
          </div>
          <p className="mt-1 text-xs sm:text-sm text-zinc-500">
            Track and monitor all campus hiring opportunities synced from CDC and official circulars.
          </p>
        </div>

        {/* Search Input */}
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            data-testid="companies-search-input"
            value={q}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search drives, roles, CTCs…"
            className="h-9 sm:h-10 w-full rounded-xl border border-zinc-800 bg-zinc-900/60 pl-9 pr-8 text-xs sm:text-sm text-zinc-200 placeholder:text-zinc-500 focus:border-emerald-500/40 focus:outline-none"
          />
          {q && (
            <button
              onClick={handleClearSearch}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Filter Chips Bar with inline badge counts */}
      <div className="mt-4 sm:mt-6 flex items-center gap-2 sm:gap-2.5 overflow-x-auto pb-1 scrollbar-none max-w-full min-w-0" data-testid="filter-bar">
        {FILTERS.map((f) => {
          const count = filterCounts[f.id] ?? 0;
          return (
            <button
              key={f.id}
              data-testid={`filter-chip-${f.id}`}
              onClick={() => handleFilterChange(f.id)}
              className={`group flex items-center gap-1.5 shrink-0 rounded-full border px-3.5 sm:px-4 py-1.5 sm:py-2 text-xs font-semibold transition-colors duration-200 cursor-pointer ${filter === f.id
                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                : 'border-zinc-800 bg-zinc-900/50 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
                }`}
            >
              <span>{f.label}</span>
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none transition-colors',
                  filter === f.id
                    ? 'bg-emerald-500/30 text-emerald-200'
                    : 'bg-zinc-800 text-zinc-400 group-hover:bg-zinc-700 group-hover:text-zinc-300'
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* 2-Column Company Cards Grid (Emergent Style) */}
      <div className="mt-4 sm:mt-5 grid grid-cols-1 lg:grid-cols-2 gap-3.5 sm:gap-4.5 w-full min-w-0 max-w-full">
        {filteredCompanies.map((c, i) => {
          const nextEv =
            c.latestEvent ||
            (c.events || []).find((e) => e.start_time && new Date(e.start_time).getTime() >= Date.now());
          const rawStatus = c.application?.status || 'applied';
          const effectiveResult = getEffectiveStage(rawStatus, nextEv, c.events, c.application?.notes, c.application?.manual_override);
          const status = effectiveResult.effectiveStatus;
          const futureDeadline = getFutureRegistrationDeadline(c);
          const stageIndex = effectiveResult.stageIndex;
          const role = c.application?.role || 'Campus Placement Drive';
          const category = c.application?.category || (/1[0-9]\s*lpa|[2-9][0-9]\s*lpa/i.test(c.application?.ctc || '') ? 'Super Dream' : 'Dream');
          const initials = c.name.slice(0, 2).toUpperCase();
          const hue = getHue(c.name);

          const driveMode = getDriveMode(c.application?.notes, userCampus);

          const stipendFormatted = formatStipend(c.application?.stipend);
          const ctcDisplay = c.application?.ctc
            ? c.application.ctc.replace(/\*/g, '').trim()
            : stipendFormatted || 'TBA';

          return (
            <motion.div
              key={c.id}
              data-testid={`company-card-${c.id}`}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: Math.min(i * 0.04, 0.4) }}
              whileHover={{ y: -3 }}
              className="w-full min-w-0 max-w-full h-full"
            >
              <Link
                href={`/companies/${c.id}`}
                className={`group flex flex-col justify-between h-full w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-zinc-800 bg-bg-surface p-3.5 sm:p-4 text-left transition-colors duration-200 hover:border-zinc-600 ${status === 'selected' || status === 'offer'
                  ? 'border-emerald-500/30 shadow-[0_0_40px_rgba(16,185,129,0.08)]'
                  : ''
                  }`}
              >
                {/* Top Content Area */}
                <div className="flex-1 flex flex-col min-w-0">
                  <div className="flex items-start gap-2.5 sm:gap-3 min-w-0">
                    <div
                      className={`flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-lg border font-display text-xs sm:text-sm font-bold ${hue}`}
                    >
                      {initials}
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <h3 className="truncate min-w-0 flex-1 font-display text-sm sm:text-base font-bold tracking-tight text-zinc-100 group-hover:text-emerald-300 transition-colors">
                          {c.name}
                        </h3>
                        <StatusChip
                          status={status}
                          className="shrink-0"
                        />
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 min-w-0 text-xs text-zinc-400">
                        <span className="truncate">{role}</span>
                        {category && (
                          <>
                            <span className="text-zinc-600 shrink-0">·</span>
                            <span className="shrink-0 text-zinc-500">{category}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-x-3 sm:gap-x-4 gap-y-1 text-[11px] text-zinc-500 min-w-0">
                    <span className="font-tabular font-mono text-xs sm:text-sm font-bold text-zinc-200 shrink-0">
                      {ctcDisplay}
                    </span>
                    {/* Work Location: Neutral/Gray Pin + Text (Only show if specified) */}
                    {(() => {
                      const loc = cleanLocationString(c.application?.location);
                      if (!loc || loc === 'Not Specified') return null;
                      return (
                        <span
                          className="flex items-center gap-1 min-w-0 max-w-33.75 sm:max-w-none truncate shrink-0 text-zinc-400"
                          title={`Work Location: ${loc}`}
                        >
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                          <span className="truncate">{loc}</span>
                        </span>
                      );
                    })()}
                    <DriveModeBadge driveMode={driveMode} />
                    {(() => {
                      const isManual = Boolean(c.application?.manual_override && c.application?.last_updated);
                      const displayDate = isManual
                        ? c.application!.last_updated
                        : c.latestEmailDate || c.application?.applied_at || c.application?.last_updated;
                      const titleText = isManual
                        ? `Manually updated via Placement Assistant: ${formatDate(c.application!.last_updated)}`
                        : c.latestEmailDate
                          ? `Latest circular/email: ${formatDate(c.latestEmailDate)}`
                          : c.application?.applied_at
                            ? `Applied: ${formatDate(c.application.applied_at)}`
                            : undefined;

                      return (
                        <span
                          suppressHydrationWarning
                          title={titleText}
                          className="ml-auto font-mono text-[10px] text-zinc-600 shrink-0 cursor-default"
                        >
                          {displayDate ? timeAgo(displayDate) : 'Active'}
                        </span>
                      );
                    })()}
                  </div>

                  {/* Recruitment Stage Stepper */}
                  <div className="mt-3.5 pt-3 border-t border-zinc-800/80">
                    <div className="mb-2 flex items-center justify-between min-w-0 gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-500 shrink-0">
                        {status === 'registration_open'
                          ? 'Registration'
                          : ['withdrawn', 'declined', 'not_applied'].includes(status)
                            ? 'Participation Status'
                            : 'Recruitment Stage'}
                      </span>
                      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                        {nextEv?.start_time &&
                          effectiveResult.eliminatedStage === -1 &&
                          !['not_shortlisted', 'rejected', 'withdrawn', 'declined', 'not_applied', 'registration_open'].includes(status) && (
                            <span
                              suppressHydrationWarning
                              className={cn(
                                'font-mono text-[10px] flex items-center gap-1 font-semibold px-1.5 py-0.5 rounded border shrink-0',
                                NEXT_EVENT_CLS[nextEv.event_type] || NEXT_EVENT_CLS.test
                              )}
                              title={nextEv.title || nextEv.event_type}
                            >
                              <Clock className="h-2.5 w-2.5 shrink-0" />
                              <span>{formatEventTime(nextEv.start_time)}</span>
                            </span>
                          )}
                        {status !== 'registration_open' && (
                          <span
                            className={cn(
                              'font-mono text-[10px] truncate',
                              effectiveResult.eliminatedStage !== -1
                                ? 'text-rose-400 font-semibold'
                                : 'text-zinc-500'
                            )}
                          >
                            {effectiveResult.statusSubtitle}
                          </span>
                        )}
                        {status === 'registration_open' && (
                          <span className="font-mono text-[10px] truncate text-zinc-500">
                            Not Applied • Awaiting Registration
                          </span>
                        )}
                      </div>
                    </div>
                    <StageStepper
                      status={rawStatus}
                      latestEvent={nextEv}
                      events={c.events}
                      compact
                    />
                  </div>
                </div>

                {/* Bottom Section: Minimal Open timeline action */}
                <div className="mt-2.5 flex items-center justify-end">
                  <div className="flex items-center gap-1 text-[11px] font-semibold text-zinc-500 transition-colors group-hover:text-emerald-400">
                    <span>Open timeline</span> <ArrowUpRight className="h-3.5 w-3.5" />
                  </div>
                </div>
              </Link>
            </motion.div>
          );
        })}
      </div>

      {filteredCompanies.length === 0 && (
        <div data-testid="empty-state" className="mt-16 text-center">
          <p className="font-mono text-sm text-zinc-500">No drives match this filter.</p>
        </div>
      )}
    </div>
  );
}
