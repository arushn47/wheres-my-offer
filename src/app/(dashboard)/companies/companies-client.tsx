'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
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
import { cleanRoleTitle } from '@/lib/sync/events';

export interface CompanyWithDetails {
  id: string;
  appId?: string;
  driveId?: string;
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
  { id: 'not_shortlisted', label: 'Not Shortlisted' },
  { id: 'withdrawn', label: 'Withdrawn' },
  { id: 'not_applied', label: 'Not Applied' },
  { id: 'all', label: 'All' },
];

/**
 * Detects if a placement drive represents an eliminated / rejected application
 * at any stage (interview, test, post-PPT, or screening).
 */
export const isCompanyEliminated = (comp: CompanyWithDetails): boolean => {
  const rawStatus = (comp.application?.status || '').toLowerCase().trim();
  const notes = (comp.application?.notes || '').toLowerCase();

  if (isEliminatedStatus(rawStatus)) return true;
  if (/eliminated|rejected|not\s*shortlisted|screened\s*out/i.test(notes)) return true;

  const eff = getEffectiveStage(
    comp.application?.status || 'applied',
    comp.latestEvent,
    comp.events,
    comp.application?.notes,
    comp.application?.manual_override
  );
  if (eff.eliminatedStage !== -1) return true;
  if (isEliminatedStatus(eff.effectiveStatus)) return true;

  return false;
};

/**
 * Detects if a placement drive currently has an open registration window
 * awaiting the student's application on NeoPAT before the deadline expires.
 */
export const isCompanyRegistrationOpen = (comp: CompanyWithDetails): boolean => {
  const rawStatus = (comp.application?.status || '').toLowerCase().trim();
  const eff = getEffectiveStage(
    rawStatus || 'not_applied',
    comp.latestEvent,
    comp.events,
    comp.application?.notes,
    comp.application?.manual_override
  );
  if (eff.effectiveStatus === 'registration_open') return true;
  if (rawStatus === 'registration_open') return true;
  if (['not_applied', 'unknown', ''].includes(rawStatus) && hasFutureRegistrationDeadline(comp)) {
    return true;
  }
  return false;
};

/**
 * Priority scoring for eliminated drives in "Not Shortlisted":
 * Priority: Eliminated in Interview (4) -> In Test (3) -> Not Shortlisted for Test after PPT (2) -> Screening only / for PPT (1)
 */
export const getEliminationPriority = (comp: CompanyWithDetails): number => {
  const rawStatus = (comp.application?.status || '').toLowerCase().trim();
  const notes = (comp.application?.notes || '').toLowerCase();
  const eff = getEffectiveStage(
    comp.application?.status || 'applied',
    comp.latestEvent,
    comp.events,
    comp.application?.notes,
    comp.application?.manual_override
  );
  const s = eff.effectiveStatus.toLowerCase();
  const subtitle = (eff.statusSubtitle || '').toLowerCase();

  // Tier 4: Eliminated in Interview Round
  if (
    eff.eliminatedStage === 4 ||
    s === 'rejected_interview' ||
    s === 'interview_eliminated' ||
    rawStatus === 'rejected_interview' ||
    rawStatus === 'interview_eliminated' ||
    subtitle.includes('interviewed') ||
    /eliminated.*interview|interview.*eliminated|interviewed.*not\s*selected|rejected.*interview|interview.*rejected/i.test(notes) ||
    (eff.hasInterview && eff.isInterviewCompleted && (isEliminatedStatus(s) || isEliminatedStatus(rawStatus)))
  ) {
    return 4;
  }

  // Tier 3: Eliminated in Test Round
  if (
    eff.eliminatedStage === 3 ||
    s === 'rejected_test' ||
    s === 'test_eliminated' ||
    rawStatus === 'rejected_test' ||
    rawStatus === 'test_eliminated' ||
    subtitle.includes('test round') ||
    /eliminated.*test|test.*eliminated|rejected.*test|test.*rejected/i.test(notes) ||
    (eff.hasTest && eff.isTestCompleted && (isEliminatedStatus(s) || isEliminatedStatus(rawStatus)))
  ) {
    return 3;
  }

  // Tier 2: Not Shortlisted for Test after PPT
  if (
    subtitle.includes('post-ppt') ||
    /after\s*ppt|post[- ]ppt|ppt.*not\s*shortlisted|not\s*shortlisted.*after\s*ppt/i.test(notes) ||
    (eff.hasPpt && (eff.eliminatedStage === 2 || eff.furthestPassedStage >= 1 || isEliminatedStatus(s) || isEliminatedStatus(rawStatus)))
  ) {
    return 2;
  }

  // Tier 1: Not Shortlisted at screening only / for PPT
  if (
    isCompanyEliminated(comp) ||
    isEliminatedStatus(s) ||
    isEliminatedStatus(rawStatus) ||
    subtitle.includes('eligibility') ||
    subtitle.includes('screened out') ||
    /not\s*shortlisted|screened\s*out|rejected/i.test(notes)
  ) {
    return 1;
  }

  return 0;
};

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
  const isElim = company ? isCompanyEliminated(company) : isEliminatedStatus(s);

  if (filter === 'all') return true;

  if (filter === 'active') {
    // 1. Eliminated drives must NEVER be in Active
    if (isElim) return false;
    // 2. Withdrawn / declined are excluded from Active
    if (s === 'withdrawn' || s === 'declined') return false;
    // 3. Open registration with future deadline is Active
    if (s === 'registration_open') return true;
    if (s === 'not_applied') {
      return Boolean(company && hasFutureRegistrationDeadline(company));
    }
    // 4. All active in-progress rounds: applied, PPT, test, interview, offer
    return !isInactiveStatus(s);
  }

  if (filter === 'not_shortlisted') {
    // All eliminated drives go into "Not Shortlisted"
    return isElim;
  }

  if (filter === 'withdrawn') return ['withdrawn', 'declined'].includes(s);
  if (filter === 'not_applied') return s === 'not_applied' || s === 'registration_open';

  // Legacy compatibility aliases for bookmarks / links
  if (filter === 'test_shortlisted' || filter === 'interview_shortlisted') {
    return !isElim && !isInactiveStatus(s);
  }
  if (filter === 'eliminated') return isElim;

  if (filter === 'shortlisted') {
    return (
      [
        'shortlisted', 'test_scheduled', 'test_ongoing', 'test_completed',
        'interview_scheduled', 'interview_ongoing', 'interview_completed',
        'interview', 'test', 'selected', 'offer', 'offer_received',
      ].includes(s) && !isElim
    );
  }
  if (filter === 'scheduled') {
    if (s.includes('completed') || isElim) return false;
    return [
      'test_scheduled', 'test_ongoing', 'interview_scheduled', 'interview_ongoing',
      'ppt_scheduled', 'ppt_ongoing', 'test', 'ppt', 'interview'
    ].includes(s);
  }
  return true;
};

// Extract numeric part of drive number for descending sort (e.g. pat-PL-2026-1324 -> 1324)
const getDriveNum = (c: CompanyWithDetails): number => {
  const str = c.drive_number || c.drive_name || '';
  const m = str.match(/pat-PL-\d{4}-(\d+)/i) || str.match(/(\d+)$/);
  if (m) return parseInt(m[1], 10);
  const anyDigits = str.match(/\d+/g);
  if (anyDigits && anyDigits.length > 0) {
    return parseInt(anyDigits[anyDigits.length - 1], 10);
  }
  return 0;
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

function formatShortCategory(cat?: string | null): string {
  if (!cat) return '';
  const cleaned = cat
    .replace(/\b(internship|offer|placement|drive)\b/gi, '')
    .replace(/\s*\/\s*/g, ' ')   // collapse " / " separators
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || cat.trim();
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
  // Pure local React state - NO URL search params or router updates to avoid lag, dropped keystrokes, and URL churning
  const [filter, setFilter] = useState<string>('active');
  const [q, setQ] = useState<string>('');

  // Clean any legacy/existing query params from the browser URL on mount without triggering a page reload
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const handleFilterChange = (newFilter: string) => {
    setFilter(newFilter);
  };

  const handleSearchChange = (val: string) => {
    setQ(val);
  };

  const handleClearSearch = () => {
    setQ('');
  };

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
        const getPriorityGroup = (comp: CompanyWithDetails) => {
          // 1. Registration open
          if (isCompanyRegistrationOpen(comp)) return 1;

          const rawStatus = (comp.application?.status || 'applied').toLowerCase();
          const eff = getEffectiveStage(
            rawStatus,
            comp.latestEvent,
            comp.events,
            comp.application?.notes,
            comp.application?.manual_override
          );
          const s = eff.effectiveStatus.toLowerCase();

          // Offer / Selected celebration
          if (['selected', 'offer', 'offer_received'].includes(s)) return 0;

          // 2. Scheduled stuff (interview, test, ppt, ongoing, or future round event)
          const compEvents = comp.events || (comp.latestEvent ? [comp.latestEvent] : []);
          const hasUpcomingRound = compEvents.some((e) => {
            const isRound = /interview|test|coding|assessment|ppt|pre-placement/i.test(
              `${e.event_type || ''} ${e.title || ''}`
            );
            const t = e.start_time ? new Date(e.start_time).getTime() : 0;
            return isRound && t > now;
          });
          const isScheduled =
            s.includes('scheduled') ||
            s.includes('ongoing') ||
            ['interview', 'test', 'ppt'].includes(s) ||
            hasUpcomingRound;
          if (isScheduled) return 2;

          // 3. Completed stuff (interview_completed, test_completed, ppt_completed)
          if (s.includes('completed')) return 3;

          // 4. Applied (applied, shortlisted)
          return 4;
        };

        const groupA = getPriorityGroup(a);
        const groupB = getPriorityGroup(b);

        if (groupA !== groupB) {
          return groupA - groupB;
        }

        // Within Group 1 (Registration Open): soonest deadline first
        if (groupA === 1) {
          const deadA = getFutureRegistrationDeadline(a)?.getTime() ?? Infinity;
          const deadB = getFutureRegistrationDeadline(b)?.getTime() ?? Infinity;
          if (deadA !== deadB) return deadA - deadB;
        }

        // Within Group 2 (Scheduled stuff): soonest upcoming event date first
        if (groupA === 2) {
          const getNextRoundTime = (comp: CompanyWithDetails) => {
            const compEvents = comp.events || (comp.latestEvent ? [comp.latestEvent] : []);
            const upcoming = compEvents
              .filter((e) => {
                const isRound = /interview|test|coding|assessment|ppt|pre-placement/i.test(
                  `${e.event_type || ''} ${e.title || ''}`
                );
                const t = e.start_time ? new Date(e.start_time).getTime() : 0;
                return isRound && t > now;
              })
              .sort((x, y) => new Date(x.start_time!).getTime() - new Date(y.start_time!).getTime());

            return upcoming.length > 0 ? new Date(upcoming[0].start_time!).getTime() : null;
          };

          const nextA = getNextRoundTime(a);
          const nextB = getNextRoundTime(b);

          if (nextA !== null && nextB !== null && nextA !== nextB) return nextA - nextB;
          if (nextA !== null) return -1;
          if (nextB !== null) return 1;

          // Subscore for scheduled rounds: interview > test > ppt
          const getScheduledRank = (comp: CompanyWithDetails) => {
            const eff = getEffectiveStage(comp.application?.status || '', comp.latestEvent, comp.events, comp.application?.notes, comp.application?.manual_override);
            const s = eff.effectiveStatus.toLowerCase();
            if (s.includes('interview')) return 3;
            if (s.includes('test')) return 2;
            return 1;
          };
          const diff = getScheduledRank(b) - getScheduledRank(a);
          if (diff !== 0) return diff;
        }

        // Within Group 3 (Completed stuff): interview_completed > test_completed > ppt_completed
        if (groupA === 3) {
          const getCompletedRank = (comp: CompanyWithDetails) => {
            const eff = getEffectiveStage(comp.application?.status || '', comp.latestEvent, comp.events, comp.application?.notes, comp.application?.manual_override);
            const s = eff.effectiveStatus.toLowerCase();
            if (s.includes('interview')) return 3;
            if (s.includes('test')) return 2;
            return 1;
          };
          const diff = getCompletedRank(b) - getCompletedRank(a);
          if (diff !== 0) return diff;
        }

        // Secondary tie-breaker across all groups: drive number descending, then most recent date
        const numDiff = getDriveNum(b) - getDriveNum(a);
        if (numDiff !== 0) return numDiff;

        const isManualA = a.application?.manual_override && a.application?.last_updated;
        const isManualB = b.application?.manual_override && b.application?.last_updated;
        const dateA = new Date(isManualA ? a.application!.last_updated : a.latestEmailDate || a.application?.applied_at || a.updated_at || 0).getTime();
        const dateB = new Date(isManualB ? b.application!.last_updated : b.latestEmailDate || b.application?.applied_at || b.updated_at || 0).getTime();
        return dateB - dateA;
      });
    }

    if (filter === 'not_shortlisted' || filter === 'eliminated') {
      // Sort by elimination priority:
      // Priority: Eliminated in Interview (4) -> In Test (3) -> Not Shortlisted for Test after PPT (2) -> Screening only / for PPT (1)
      return [...list].sort((a, b) => {
        const pA = getEliminationPriority(a);
        const pB = getEliminationPriority(b);
        if (pB !== pA) return pB - pA;

        const numDiff = getDriveNum(b) - getDriveNum(a);
        if (numDiff !== 0) return numDiff;

        const dateA = new Date(a.latestEmailDate || a.updated_at || 0).getTime();
        const dateB = new Date(b.latestEmailDate || b.updated_at || 0).getTime();
        return dateB - dateA;
      });
    }

    if (filter === 'not_applied' || filter === 'all') {
      return [...list].sort((a, b) => {
        // Registration Open drives always float to the top
        const regA = isCompanyRegistrationOpen(a);
        const regB = isCompanyRegistrationOpen(b);
        if (regA && !regB) return -1;
        if (!regA && regB) return 1;
        if (regA && regB) {
          const deadA = getFutureRegistrationDeadline(a)?.getTime() ?? Infinity;
          const deadB = getFutureRegistrationDeadline(b)?.getTime() ?? Infinity;
          if (deadA !== deadB) return deadA - deadB;
        }

        const numDiff = getDriveNum(b) - getDriveNum(a);
        if (numDiff !== 0) return numDiff;
        const dateA = new Date(a.latestEmailDate || a.updated_at || 0).getTime();
        const dateB = new Date(b.latestEmailDate || b.updated_at || 0).getTime();
        return dateB - dateA;
      });
    }

    // Default for 'withdrawn':
    // Sort according to descending order of drive numbers (highest drive number first, e.g. 1324 > 1320...)
    return [...list].sort((a, b) => {
      const numDiff = getDriveNum(b) - getDriveNum(a);
      if (numDiff !== 0) return numDiff;
      const dateA = new Date(a.latestEmailDate || a.updated_at || 0).getTime();
      const dateB = new Date(b.latestEmailDate || b.updated_at || 0).getTime();
      return dateB - dateA;
    });
  }, [companies, filter, q]);

  const filterCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: companies.length,
      active: 0,
      not_shortlisted: 0,
      withdrawn: 0,
      not_applied: 0,
    };
    for (const c of companies) {
      const rawStatus = c.application?.status || 'applied';
      const eff = getEffectiveStage(rawStatus, c.latestEvent, c.events, c.application?.notes, c.application?.manual_override);
      const st = eff.effectiveStatus;
      if (matchFilter(st, 'active', c)) counts.active++;
      if (matchFilter(st, 'not_shortlisted', c)) counts.not_shortlisted++;
      if (matchFilter(st, 'withdrawn', c)) counts.withdrawn++;
      if (matchFilter(st, 'not_applied', c)) counts.not_applied++;
    }
    return counts;
  }, [companies]);

  const companyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of companies) {
      const key = c.name.toLowerCase().trim();
      counts.set(key, (counts.get(key) || 0) + 1);
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
          const potentialEvs = [
            ...(c.latestEvent ? [c.latestEvent] : []),
            ...(c.events || [])
          ];
          const nextEv = potentialEvs.find(
            (e) => e.start_time && new Date(e.start_time).getTime() >= Date.now() && e.event_type !== 'registration_deadline'
          );
          const rawStatus = c.application?.status || 'applied';
          const effectiveResult = getEffectiveStage(rawStatus, nextEv, c.events, c.application?.notes, c.application?.manual_override);
          const status = effectiveResult.effectiveStatus;
          const futureDeadline = getFutureRegistrationDeadline(c);
          const stageIndex = effectiveResult.stageIndex;
          const cleanedRole = cleanRoleTitle(c.application?.role);
          const role = cleanedRole || 'Campus Placement Drive';
          const rawCategory = c.application?.category || (/1[0-9]\s*lpa|[2-9][0-9]\s*lpa/i.test(c.application?.ctc || '') ? 'Super Dream' : 'Dream');
          const shortCategory = formatShortCategory(rawCategory);
          const initials = c.name.slice(0, 2).toUpperCase();
          const hue = getHue(c.name);
          const isMultiDrive = (companyCounts.get(c.name.toLowerCase().trim()) || 0) > 1;

          const driveMode = getDriveMode(c.application?.notes, userCampus);

          const stipendFormatted = formatStipend(c.application?.stipend);
          const ctcDisplay = c.application?.ctc
            ? c.application.ctc.replace(/\*/g, '').trim()
            : stipendFormatted || 'TBA';

          return (
            <motion.div
              key={`${c.id}-${c.appId || ''}-${c.driveId || ''}`}
              data-testid={`company-card-${c.id}`}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03, duration: 0.3 }}
              className="w-full min-w-0 max-w-full h-full"
            >
              <Link
                href={c.driveId ? `/companies/${c.id}?driveId=${c.driveId}` : `/companies/${c.id}`}
                className={cn(`group flex flex-col justify-between h-full w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-zinc-800 bg-bg-surface p-3.5 sm:p-4 text-left transition-colors duration-200 hover:border-zinc-600 ${status === 'selected' || status === 'offer'
                  ? 'border-emerald-500/30 shadow-[0_0_40px_rgba(16,185,129,0.08)]'
                  : ''
                  }`)}
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
                          {isMultiDrive && (
                            <span
                              title={`Placement Drive Number: ${c.drive_number || 'Drive'}`}
                              className="ml-2 rounded-md bg-zinc-800/90 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-400 border border-emerald-500/20 cursor-help"
                            >
                              {(() => {
                                const m = c.drive_number?.match(/\d+$/);
                                return m ? `#${m[0]}` : (c.drive_number || 'Drive');
                              })()}
                            </span>
                          )}
                        </h3>
                        <StatusChip
                          status={status}
                          className="shrink-0"
                        />
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 min-w-0 text-xs text-zinc-400">
                        <span className="truncate max-w-[200px] sm:max-w-[280px]" title={role}>{role}</span>
                        {shortCategory && (
                          <>
                            <span className="text-zinc-600 shrink-0">·</span>
                            <span className="shrink-0 text-zinc-500 font-medium">{shortCategory}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Compensation, Location (plain text with icon), Drive Mode, and Recency */}
                  <div className="mt-3 flex flex-wrap items-center gap-x-2.5 sm:gap-x-3.5 gap-y-1.5 text-[11px] text-zinc-500 min-w-0">
                    <span className="font-tabular font-mono text-xs sm:text-sm font-bold text-zinc-100 shrink-0">
                      {ctcDisplay}
                    </span>
                    {(() => {
                      const loc = cleanLocationString(c.application?.location);
                      if (!loc || loc === 'Not Specified') return null;
                      return (
                        <span
                          className="flex items-center gap-1 sm:gap-1.5 min-w-0 max-w-[150px] sm:max-w-[210px] truncate shrink-0 text-zinc-400"
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
                          className="ml-auto font-mono text-[10px] sm:text-[10.5px] text-zinc-500 shrink-0 cursor-default"
                        >
                          {displayDate ? timeAgo(displayDate) : 'Active'}
                        </span>
                      );
                    })()}
                  </div>

                  {/* Recruitment Stage Stepper */}
                  <div className="mt-3.5 pt-3 border-t border-zinc-800/80">
                    {(() => {
                      const hasUpcomingEvent = Boolean(
                        nextEv?.start_time &&
                        effectiveResult.eliminatedStage === -1 &&
                        !['not_shortlisted', 'rejected', 'withdrawn', 'declined', 'not_applied', 'registration_open'].includes(status)
                      );

                      return (
                        <div className="mb-2 flex items-center justify-between min-w-0 gap-2">
                          <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-500 shrink-0">
                            {status === 'registration_open'
                              ? 'Registration'
                              : ['withdrawn', 'declined', 'not_applied'].includes(status)
                                ? 'Participation Status'
                                : 'Recruitment Stage'}
                          </span>
                          <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                            {hasUpcomingEvent && (
                              <span
                                suppressHydrationWarning
                                className={cn(
                                  'font-mono text-[10px] flex items-center gap-1 font-semibold px-1.5 py-0.5 rounded border shrink-0',
                                  NEXT_EVENT_CLS[nextEv!.event_type] || NEXT_EVENT_CLS.test
                                )}
                                title={nextEv!.title || nextEv!.event_type}
                              >
                                <Clock className="h-2.5 w-2.5 shrink-0" />
                                <span>{formatEventTime(nextEv!.start_time)}</span>
                              </span>
                            )}
                            {status !== 'registration_open' && (
                              <span
                                className={cn(
                                  'font-mono text-[10px] truncate',
                                  hasUpcomingEvent ? 'hidden sm:inline' : 'inline',
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
                                Awaiting Registration
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                    <StageStepper
                      status={rawStatus}
                      latestEvent={nextEv}
                      events={c.events}
                      notes={c.application?.notes}
                      manualOverride={c.application?.manual_override}
                      compact
                    />
                  </div>
                </div>

                {/* Bottom Section: Minimal Open timeline action (Desktop only to prevent mobile clutter & FAB overlap) */}
                <div className="mt-2.5 hidden sm:flex items-center justify-end">
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
