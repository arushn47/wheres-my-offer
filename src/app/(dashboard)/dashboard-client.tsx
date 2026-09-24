'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  Clock,
  MapPin,
  ArrowUpRight,
  Zap,
  CalendarClock,
  CheckCircle2,
  Calendar,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';
import { StatusChip, CategoryBadge } from '@/components/ui/status-chip';
import { DriveModeBadge } from '@/components/ui/drive-mode-badge';
import { InstallPwaBanner } from '@/components/notifications/install-pwa-banner';
import { formatStipend, cn, getDriveMode } from '@/lib/utils';
import { cleanLocationString } from '@/lib/sync/locations';
import { cleanRoleTitle, cleanEventTitle } from '@/lib/sync/events';
import { isInactiveStatus } from '@/lib/stages';
import type { DashboardStats } from '@/types';

export interface ActiveApplicationItem {
  id: string;
  companyId: string;
  companyName: string;
  companyLogo: string | null;
  status: string;
  statusSubtitle?: string | null;
  role: string | null;
  ctc: string | null;
  stipend: string | null;
  lastUpdated: string | null;
  location?: string | null;
  category?: string | null;
  notes?: string | null;
  driveMode?: string | null;
}

interface DashboardClientProps {
  stats: DashboardStats;
  upcomingEvents: Array<{
    id: string;
    placement_drive_id: string;
    companyName?: string;
    event_type: string;
    title: string | null;
    start_time: string | null;
    end_time: string | null;
    venue: string | null;
    mode: string | null;
  }>;
  activeApplications?: ActiveApplicationItem[];
  hasAccounts: boolean;
  hasPersonalAccount?: boolean;
  hasCollegeAccount?: boolean;
  disconnectedAccounts?: Array<{
    id: string;
    email: string;
    account_type: string;
  }>;
  hasNeoId: boolean;
  neoId: string | null;
  campus?: string | null;
  branch?: string | null;
}

const ACCENTS = {
  indigo: 'border-indigo-500/20 bg-indigo-500/[0.06] text-indigo-300',
  sky: 'border-sky-500/20 bg-sky-500/[0.06] text-sky-300',
  amber: 'border-amber-500/20 bg-amber-500/[0.06] text-amber-300',
  violet: 'border-violet-500/20 bg-violet-500/[0.06] text-violet-300',
  emerald: 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-300',
};

const NEXT_EVENT_CLS: Record<string, string> = {
  online_test: 'border-amber-500/30 bg-amber-500/[0.07] text-amber-300',
  coding_test: 'border-amber-500/30 bg-amber-500/[0.07] text-amber-300',
  technical_interview: 'border-cyan-500/30 bg-cyan-500/[0.07] text-cyan-300',
  hr_interview: 'border-cyan-500/30 bg-cyan-500/[0.07] text-cyan-300',
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

  if (diffHours > 0 && diffHours < 24) return `in ${diffHours} hrs · ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  if (diffDays > 0 && diffDays <= 7) return `in ${diffDays} days`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function DashboardClient({
  stats,
  upcomingEvents,
  activeApplications = [],
  hasPersonalAccount = true,
  hasCollegeAccount = true,
  hasNeoId = true,
  neoId,
  campus,
  branch,
}: DashboardClientProps) {
  // Top 4 active drives: Scheduled rounds first, then Completed rounds, then Applied drives
  const spotlightDrives = useMemo(() => {
    const active = activeApplications.filter(
      (a) => !isInactiveStatus(a.status)
    );

    const now = Date.now();

    // Check if an item has a confirmed upcoming round or deadline
    const getNextEventTime = (item: ActiveApplicationItem): number | null => {
      const ev = upcomingEvents.find(
        (e) =>
          (e.placement_drive_id === item.id || e.placement_drive_id === item.companyId) &&
          e.start_time &&
          new Date(e.start_time).getTime() > now
      );
      return ev?.start_time ? new Date(ev.start_time).getTime() : null;
    };

    const getStageTierAndScore = (item: ActiveApplicationItem) => {
      const s = (item.status || '').toLowerCase();

      // Offers / Selected - top celebration
      if (['selected', 'offer', 'offer_received'].includes(s)) {
        return { tier: 4, subScore: 100 };
      }

      // TIER 3: SCHEDULED & ONGOING ROUNDS (Requires candidate participation)
      const hasUpcomingEvt = getNextEventTime(item) !== null;
      const isLive = s.includes('ongoing');
      const isScheduled =
        s.includes('scheduled') ||
        ['interview', 'test', 'ppt'].includes(s) ||
        hasUpcomingEvt;

      if (isLive || isScheduled) {
        let subScore = 50;
        if (s.includes('interview')) subScore = 90;
        else if (s.includes('test')) subScore = 80;
        else if (s.includes('ppt')) subScore = 70;
        else subScore = 60;
        return { tier: 3, subScore };
      }

      // TIER 2: COMPLETED ROUNDS (Test completed, PPT completed, awaiting results)
      const isCompleted = s.includes('completed');
      if (isCompleted) {
        let subScore = 50;
        if (s.includes('interview_completed')) subScore = 90;
        else if (s.includes('test_completed')) subScore = 80;
        else if (s.includes('ppt_completed')) subScore = 70;
        return { tier: 2, subScore };
      }

      // TIER 1: APPLIED / SHORTLISTED (Awaiting initial test shortlist or schedule)
      let subScore = 10;
      if (s === 'shortlisted') subScore = 30;
      else if (s === 'registration_open') return { tier: 1, subScore: 20 };
      return { tier: 1, subScore };
    };

    return [...active]
      .sort((a, b) => {
        const aRank = getStageTierAndScore(a);
        const bRank = getStageTierAndScore(b);

        // 1. Primary sort: Tier (Scheduled [3] > Completed [2] > Applied [1])
        if (bRank.tier !== aRank.tier) {
          return bRank.tier - aRank.tier;
        }

        // 2. If both are Scheduled: soonest upcoming event time first
        if (aRank.tier === 3 && bRank.tier === 3) {
          const nextA = getNextEventTime(a);
          const nextB = getNextEventTime(b);
          if (nextA !== null && nextB !== null && nextA !== nextB) {
            return nextA - nextB;
          }
          if (nextA !== null) return -1;
          if (nextB !== null) return 1;
        }

        // 3. Subscore within the tier (e.g. Interview > Test > PPT)
        if (bRank.subScore !== aRank.subScore) {
          return bRank.subScore - aRank.subScore;
        }

        // 4. Secondary sort: recency of update
        return new Date(b.lastUpdated || 0).getTime() - new Date(a.lastUpdated || 0).getTime();
      })
      .slice(0, 4);
  }, [activeApplications, upcomingEvents]);

  const next24hEvents = useMemo(() => {
    const now = Date.now();
    const limit = now + 24 * 60 * 60 * 1000;
    return upcomingEvents.filter((e) => {
      if (!e.start_time) return false;
      const t = new Date(e.start_time).getTime();
      return t >= now - 60 * 60 * 1000 && t <= limit;
    });
  }, [upcomingEvents]);

  const appliedCount = stats.total_applied ?? stats.applied;
  const funnelCards = [
    {
      id: 'total',
      label: 'Applied Drives',
      value: appliedCount,
      sub: `out of ${stats.total_companies} placement drives`,
      title: `${appliedCount} applied drives out of ${stats.total_companies} total eligible drives`,
      accent: 'indigo' as const,
      href: '/companies?filter=all',
    },
    {
      id: 'active',
      label: 'Active',
      value: stats.active_applications,
      sub: 'still in contention',
      title: `${stats.active_applications} applications currently active in contention`,
      accent: 'sky' as const,
      href: '/companies?filter=active',
    },
    {
      id: 'tests',
      label: 'Upcoming Rounds',
      value: stats.upcoming_tests + stats.upcoming_interviews,
      sub: upcomingEvents.find(e => e.event_type !== 'registration_deadline') ? `next ${formatEventTime(upcomingEvents.find(e => e.event_type !== 'registration_deadline')!.start_time)}` : 'all caught up',
      title: `${stats.upcoming_tests + stats.upcoming_interviews} upcoming scheduled test and interview rounds`,
      accent: 'amber' as const,
      href: '/companies?filter=scheduled',
    },
    {
      id: 'test-shortlists',
      label: 'Test Shortlists',
      value: stats.test_shortlists,
      sub: stats.test_shortlists > 0 ? 'reached a test shortlist' : 'waiting for shortlist results',
      title: `${stats.test_shortlists} placement drives where you reached a test or assessment shortlist, including completed or eliminated rounds`,
      accent: 'violet' as const,
      href: '/companies?filter=active',
    },
    {
      id: 'interview-shortlists',
      label: 'Interview Shortlists',
      value: stats.interview_shortlists,
      sub: stats.interview_shortlists > 0 ? 'cleared for interviews' : 'no interview shortlist yet',
      title: `${stats.interview_shortlists} placement drives where you cleared an interview shortlist`,
      accent: 'emerald' as const,
      href: '/companies?filter=active',
    },
  ];

  return (
    <div data-testid="dashboard-page" className="mx-auto max-w-7xl space-y-5 sm:space-y-6 w-full min-w-0">
      {/* Onboarding Alert Banner if missing requirements */}
      {(!hasCollegeAccount || !hasNeoId) && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-3.5 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4">
          <div className="flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <h4 className="text-xs sm:text-sm font-semibold text-zinc-200">
                {!hasCollegeAccount ? 'Link your College Gmail to unlock test circulars' : 'Add your Registration ID'}
              </h4>
              <p className="text-[11px] sm:text-xs text-zinc-400 mt-0.5">
                {!hasCollegeAccount
                  ? 'Connect your @vitstudent.ac.in account in Settings so the engine can parse shortlists and test links.'
                  : "Add your roll number in Settings so Where's My Offer? can match your name in shortlist Excel files."}
              </p>
            </div>
          </div>
          <Link
            href="/settings"
            className="rounded-full bg-amber-500 px-4 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400 transition-colors whitespace-nowrap self-end sm:self-auto"
          >
            Go to Settings →
          </Link>
        </div>
      )}

      {/* PWA Mobile Install & Instant Notifications Banner */}
      <InstallPwaBanner />

      {/* Page Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div>
          <h1 className="font-display text-xl sm:text-3xl font-extrabold tracking-tight text-zinc-100">
            Placement Pipeline
          </h1>
        <p className="flex flex-wrap items-center gap-1.5 mt-1 text-xs sm:text-sm text-zinc-500">
          <span>2027 Placement Season</span>
          {neoId && (
            <>
              <span>·</span>
              <span className="font-mono text-zinc-400">{neoId}</span>
            </>
          )}
          {campus && (
            <>
              <span>·</span>
              <span className="text-zinc-400">{campus}{branch ? ` (${branch})` : ''}</span>
            </>
          )}
        </p>
        </div>
        <Link
          href="/companies?filter=all"
          className={cn(
            'inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors',
            stats.selected > 0
              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300 hover:border-emerald-400/50 hover:bg-emerald-500/15'
              : 'border-zinc-800 bg-zinc-900/60 text-zinc-500 hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-300'
          )}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {stats.selected > 0
            ? `${stats.selected} ${stats.selected === 1 ? 'offer' : 'offers'} secured`
            : 'Offers secured: 0'}
        </Link>
      </div>

      {/* Funnel Metrics Grid */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {funnelCards.map((f, i) => (
          <motion.div
            key={f.id}
            data-testid={`metric-card-${f.id}`}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: i * 0.06 }}
            className={cn(
              "group rounded-xl border min-w-0 transition-all duration-200 hover:border-zinc-700/80 hover:bg-zinc-900/60 hover:shadow-lg hover:shadow-black/20",
              ACCENTS[f.accent],
              i === 4 && "col-span-2 sm:col-span-1"
            )}
          >
            <Link href={f.href} className="block p-3 sm:p-4 min-w-0">
              <div className="font-tabular font-display text-2xl sm:text-3xl font-extrabold tracking-tight group-hover:scale-[1.02] transition-transform origin-left">{f.value}</div>
              <div className="mt-1 text-[11px] sm:text-xs font-semibold text-zinc-300 truncate group-hover:text-zinc-100 transition-colors">{f.label}</div>
              <div className="mt-0.5 font-mono text-[9px] sm:text-[10px] text-zinc-500 truncate" title={f.title || f.sub}>{f.sub}</div>
            </Link>
          </motion.div>
        ))}
      </div>

      {/* Upcoming Strip (Next 24 hrs) */}
      {next24hEvents.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="flex items-center gap-2.5 sm:gap-3 overflow-x-auto rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 sm:px-4 py-2.5 sm:py-3 scrollbar-none max-w-full min-w-0"
          data-testid="upcoming-strip"
        >
          <CalendarClock className="h-4 w-4 shrink-0 text-amber-400" />
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-amber-300">Next 24 hrs</span>
          {next24hEvents.slice(0, 5).map((e) => (
            <span
              key={e.id}
              className="flex shrink-0 items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/70 px-2.5 sm:px-3 py-1 text-[10px] sm:text-[11px] text-zinc-300"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 pulse-dot shrink-0" />
              <span className="truncate max-w-37.5 sm:max-w-none">
                {e.companyName || 'Company'} — {cleanEventTitle(e.title, e.companyName, e.event_type.replace(/_/g, ' '))}
              </span>
              <span className="font-tabular font-mono text-amber-300 shrink-0">{formatEventTime(e.start_time)}</span>
            </span>
          ))}
        </motion.div>
      )}

      {/* Section 1: Upcoming Schedule & Assessment Agenda */}
      <div className="space-y-4 pt-2">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Calendar className="h-4 w-4 text-emerald-400 shrink-0" />
            <h2 className="font-display text-sm sm:text-base md:text-lg font-bold tracking-tight text-zinc-100 truncate">
              Upcoming Assessment Schedule
            </h2>
          </div>
          <Link
            href="/calendar"
            className="flex items-center gap-1 text-xs font-semibold text-zinc-400 hover:text-emerald-400 transition-colors shrink-0 whitespace-nowrap"
          >
            Full Calendar <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        {upcomingEvents.length === 0 ? (
          <div className="relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-linear-to-b from-[#121218] to-[#0a0a0e] p-6 sm:p-8 text-center shadow-lg">
            {/* Ambient subtle glow background */}
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--tw-gradient-stops))] from-emerald-500/10 via-transparent to-transparent pointer-events-none" />

            {/* Layered Icon Badge with Radar / Calendar aura */}
            <div className="relative mx-auto mb-3.5 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/25 bg-emerald-500/10 shadow-[0_0_24px_rgba(16,185,129,0.15)]">
              <Calendar className="h-6 w-6 text-emerald-400" />
              <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-[#0a0a0e] border border-emerald-500/40 shadow-sm">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              </span>
            </div>

            <h3 className="font-display text-sm sm:text-base font-bold text-zinc-100 tracking-tight">
              All Caught Up on Assessments
            </h3>
            <p className="mt-1.5 text-xs text-zinc-400 max-w-md mx-auto leading-relaxed">
              No imminent online tests or interviews scheduled right now. The live inbox radar scans 24/7 for new CDC circulars and will notify you immediately.
            </p>

            {/* Quick Status & Action Pills */}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2 pt-1">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/80 px-3 py-1 text-[11px] font-mono text-zinc-400 select-none">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </span>
                <span>Active Radar · {stats.active_applications} drives tracked</span>
              </div>
              <Link
                href="/calendar"
                className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700/60 bg-zinc-800/60 hover:bg-zinc-800 px-3 py-1 text-[11px] font-medium text-zinc-300 hover:text-white transition-all group"
              >
                <span>Browse calendar</span>
                <ArrowRight className="h-3 w-3 text-zinc-400 group-hover:translate-x-0.5 transition-transform" />
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 w-full min-w-0 max-w-full">
            {upcomingEvents.slice(0, 6).map((ev) => (
              <Link
                key={ev.id}
                href={`/companies/${ev.placement_drive_id}`}
                className="group flex flex-col justify-between rounded-xl border border-zinc-800 bg-bg-surface p-4 transition-all duration-200 hover:border-zinc-600 hover:shadow-lg"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-sm font-bold text-zinc-100 group-hover:text-emerald-300 transition-colors truncate">
                      {ev.companyName || 'Company'}
                    </span>
                    <span className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${NEXT_EVENT_CLS[ev.event_type] || 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>
                      {ev.event_type.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <h4 className="mt-2 text-xs font-semibold text-zinc-300 line-clamp-1">
                    {cleanEventTitle(ev.title, ev.companyName, 'Recruitment Assessment')}
                  </h4>
                  <div className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-zinc-400">
                    <Clock className="h-3 w-3 text-amber-400" />
                    <span>{formatEventTime(ev.start_time)}</span>
                  </div>
                  {ev.venue && (
                    <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-zinc-500 truncate">
                      <MapPin className="h-3 w-3" />
                      <span>{ev.venue}</span>
                    </div>
                  )}
                </div>
                <div className="mt-4 flex items-center justify-end gap-1 text-[11px] font-semibold text-zinc-500 group-hover:text-emerald-400 transition-colors">
                  View Drive <ArrowUpRight className="h-3.5 w-3.5" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Section 2: Active Pipeline Spotlight */}
      <div className="space-y-3 sm:space-y-4 pt-2 sm:pt-4">
        <div className="flex flex-col xs:flex-row xs:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-emerald-400 shrink-0" />
            <h2 className="font-display text-base sm:text-lg font-bold tracking-tight text-zinc-100">
              Active Drives Spotlight
            </h2>
          </div>
          <Link
            href="/companies?filter=active"
            className="flex items-center gap-1.5 text-xs font-bold text-emerald-400 hover:text-emerald-300 transition-colors shrink-0 whitespace-nowrap"
          >
            View all {stats.active_applications} active drives <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        {spotlightDrives.length === 0 ? (
          <div className="relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-linear-to-b from-[#121218] to-[#0a0a0e] p-6 sm:p-8 text-center shadow-lg">
            <Zap className="mx-auto h-8 w-8 text-zinc-600 mb-2" />
            <p className="font-display text-sm font-bold text-zinc-300">No active applications in the spotlight</p>
            <p className="mt-1 font-mono text-xs text-zinc-500">Apply to campus circulars or explore all tracked drives.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 w-full min-w-0 max-w-full">
            {spotlightDrives.map((c) => {
              const rawCategory = c.category || (/1[0-9]\s*lpa|[2-9][0-9]\s*lpa/i.test(c.ctc || '') ? 'Super Dream' : 'Dream');
              const category = rawCategory.replace(/\b(internship|offer|placement|drive)\b/gi, '').replace(/\s*\/\s*/g, ' ').replace(/\s+/g, ' ').trim() || rawCategory.trim();
              const initials = c.companyName.slice(0, 2).toUpperCase();
              const hue = getHue(c.companyName);
              const driveMode = c.driveMode || getDriveMode(c.notes, campus);

              return (
                <Link
                  key={c.id}
                  href={`/companies/${c.companyId}`}
                  className="group block w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-zinc-800 bg-bg-surface p-3.5 sm:p-4 transition-all duration-200 hover:border-zinc-600"
                >
                  <div className="flex items-start gap-2.5 sm:gap-3 min-w-0">
                    <div className={`flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-lg border font-display text-xs sm:text-sm font-bold ${hue}`}>
                      {initials}
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <h3 className="truncate min-w-0 flex-1 font-display text-sm sm:text-base font-bold tracking-tight text-zinc-100 group-hover:text-emerald-300 transition-colors">
                          {c.companyName}
                        </h3>
                        <StatusChip status={c.status} className="shrink-0" />
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 min-w-0 text-[11px] sm:text-xs text-zinc-400">
                        <span className="truncate">{cleanRoleTitle(c.role) || 'Campus Placement Drive'}</span>
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
                      {c.ctc || formatStipend(c.stipend) || 'TBA'}
                    </span>
                    {/* Work Location: Neutral/Gray Pin + Text (Only show if specified) */}
                    {(() => {
                      const loc = cleanLocationString(c.location);
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
                    {/* Travel Mode Badge */}
                    <DriveModeBadge driveMode={driveMode} />
                    <span className="ml-auto font-mono text-[10px] text-zinc-600 shrink-0 transition-colors duration-200 group-hover:text-emerald-400">
                      Open drive details ↗
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
