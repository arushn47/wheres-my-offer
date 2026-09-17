'use client';

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  TrendingUp,
  Award,
  Zap,
  CheckCircle2,
  FileSpreadsheet,
  Mail,
  Building2,
  Calendar,
  PieChart,
  ShieldCheck,
  ChevronRight,
} from 'lucide-react';
import Link from 'next/link';
import { StatusChip } from '@/components/ui/status-chip';

export interface AnalyticsApplication {
  id: string;
  company_id: string;
  status: string;
  notes?: string | null;
  ctc: string | null;
  stipend?: string | null;
  category?: string | null;
  applied_at: string | null;
  last_updated: string | null;
}

export interface AnalyticsEvent {
  id: string;
  company_id: string;
  event_type: string;
  start_time: string | null;
}

interface AnalyticsClientProps {
  applications: AnalyticsApplication[];
  events: AnalyticsEvent[];
  companiesCount: number;
  emailsCount: number;
  matchesCount: number;
  uniqueMatchesCount?: number;
  neoId?: string | null;
  campus?: string | null;
  branch?: string | null;
}

export default function AnalyticsClient({
  applications,
  events,
  companiesCount,
  emailsCount,
  matchesCount,
  uniqueMatchesCount,
  neoId,
  campus,
  branch,
}: AnalyticsClientProps) {
  // 1. Calculate Funnel Data
  const {
    appliedCount,
    shortlistedCount,
    clearedAssessmentCount,
    interviewCount,
    offerCount,
    optedOutCount,
    rejectedCount,
    superDreamCount,
    dreamCount,
    regularCount,
    unknownCtcCount,
    highestCtcNum,
    highestCtcFormatted,
    avgAppliedCtc,
    appliedCtcCount,
  } = useMemo(() => {
    let applied = 0;
    let shortlisted = 0;
    let clearedAssessment = 0;
    let interviewed = 0;
    let selected = 0;
    let optedOut = 0;
    let rejected = 0;

    let superDream = 0;
    let dream = 0;
    let regular = 0;
    let unknownCtc = 0;

    const appliedCtcs: number[] = [];
    let maxCtc = 0;
    let maxCtcStr = 'TBA';

    // Index events by company_id to verify stage participation
    const eventsByCompany = new Map<string, AnalyticsEvent[]>();
    events.forEach((ev) => {
      const list = eventsByCompany.get(ev.company_id) || [];
      list.push(ev);
      eventsByCompany.set(ev.company_id, list);
    });

    applications.forEach((app) => {
      const s = (app.status || '').toLowerCase();
      if (['withdrawn', 'declined', 'not_applied'].includes(s)) {
        optedOut++;
        return;
      }
      applied++;

      const compEvents = eventsByCompany.get(app.company_id) || [];
      const hasTestEvent = compEvents.some((e) =>
        /test|coding|assessment|hackerearth|mettl|shl/i.test(`${e.event_type || ''}`)
      );
      const hasInterviewEvent = compEvents.some((e) =>
        /interview/i.test(`${e.event_type || ''}`)
      );

      // Shortlisted for OA / Test:
      // Even if a candidate wrote a test and failed, they were still shortlisted for OA!
      const isShortlistedForOA =
        [
          'shortlisted',
          'test',
          'test_scheduled',
          'test_completed',
          'interview',
          'interview_scheduled',
          'interview_completed',
          'selected',
          'offer',
          'offer_received',
        ].includes(s) ||
        hasTestEvent ||
        (s === 'rejected' && (hasTestEvent || /test|assessment|interview/i.test(app.notes || '')));

      // Assessments Cleared:
      // Candidate ONLY clears an assessment if they successfully advanced to the next round (Interviews or Offers)!
      // "Test Completed · Awaiting Results" is NOT cleared yet!
      const isAssessmentCleared =
        [
          'interview',
          'interview_scheduled',
          'interview_completed',
          'selected',
          'offer',
          'offer_received',
        ].includes(s) ||
        (s === 'rejected' && (hasInterviewEvent || /interview/i.test(app.notes || '')));

      // Interviews Reached:
      const isInterviewed =
        [
          'interview',
          'interview_scheduled',
          'interview_completed',
          'selected',
          'offer',
          'offer_received',
        ].includes(s) ||
        (s === 'rejected' && (hasInterviewEvent || /interview/i.test(app.notes || '')));

      // Offers Won:
      const isSelected = ['selected', 'offer', 'offer_received'].includes(s);

      if (isShortlistedForOA) shortlisted++;
      if (isAssessmentCleared) clearedAssessment++;
      if (isInterviewed) interviewed++;
      if (isSelected) selected++;
      if (s === 'rejected' || s === 'not_shortlisted') rejected++;

      // CTC extraction: handles both fixed ("14 LPA") and ranged ("6.25 - 21 LPA")
      const ctcStr = app.ctc || '';
      const rangeMatch = ctcStr.match(
        /(\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(\d+(?:\.\d+)?)\s*(?:lpa|lac|lakh)?/i
      );
      const singleMatch = ctcStr.match(/(\d+(?:\.\d+)?)\s*(?:lpa|lac|lakh)/i);

      if (rangeMatch) {
        const minVal = parseFloat(rangeMatch[1]);
        const maxVal = parseFloat(rangeMatch[2]);
        // Use balanced midpoint for average calculation
        appliedCtcs.push((minVal + maxVal) / 2);
        // Track absolute ceiling for peak CTC
        if (maxVal > maxCtc) {
          maxCtc = maxVal;
          maxCtcStr = `₹${maxVal} LPA`;
        }
        // Classify tier by ceiling
        if (maxVal >= 10) superDream++;
        else if (maxVal >= 6) dream++;
        else regular++;
      } else if (singleMatch) {
        const val = parseFloat(singleMatch[1]);
        appliedCtcs.push(val);
        if (val > maxCtc) {
          maxCtc = val;
          maxCtcStr = `₹${val} LPA`;
        }
        if (val >= 10) superDream++;
        else if (val >= 6) dream++;
        else regular++;
      } else {
        const cat = (app.category || '').toLowerCase();
        if (cat.includes('super')) superDream++;
        else if (cat.includes('dream')) dream++;
        else if (cat.includes('regular') || cat.includes('core')) regular++;
        else unknownCtc++;
      }
    });

    const avgApplied =
      appliedCtcs.length > 0
        ? (appliedCtcs.reduce((a, b) => a + b, 0) / appliedCtcs.length).toFixed(1)
        : null;

    return {
      appliedCount: applied,
      shortlistedCount: shortlisted,
      clearedAssessmentCount: clearedAssessment,
      interviewCount: interviewed,
      offerCount: selected,
      optedOutCount: optedOut,
      rejectedCount: rejected,
      superDreamCount: superDream,
      dreamCount: dream,
      regularCount: regular,
      unknownCtcCount: unknownCtc,
      highestCtcNum: maxCtc,
      highestCtcFormatted: maxCtc > 0 ? maxCtcStr : '—',
      avgAppliedCtc: avgApplied ? `₹${avgApplied} LPA` : '—',
      appliedCtcCount: appliedCtcs.length,
    };
  }, [applications, events]);

  const shortlistRate = appliedCount > 0 ? Math.round((shortlistedCount / appliedCount) * 100) : 0;
  const interviewRate = shortlistedCount > 0 ? Math.round((interviewCount / shortlistedCount) * 100) : 0;

  const funnelSteps = [
    { label: 'Applied Drives', count: appliedCount, pct: 100, color: 'bg-indigo-500' },
    {
      label: 'Shortlisted for OA',
      count: shortlistedCount,
      pct: appliedCount > 0 ? Math.round((shortlistedCount / appliedCount) * 100) : 0,
      color: 'bg-violet-500',
    },
    {
      label: 'Assessments Cleared',
      count: clearedAssessmentCount,
      pct: appliedCount > 0 ? Math.round((clearedAssessmentCount / appliedCount) * 100) : 0,
      color: 'bg-amber-500',
    },
    {
      label: 'Interviews Reached',
      count: interviewCount,
      pct: appliedCount > 0 ? Math.round((interviewCount / appliedCount) * 100) : 0,
      color: 'bg-cyan-500',
    },
    {
      label: 'Offers Won 🎉',
      count: offerCount,
      pct: appliedCount > 0 ? Math.round((offerCount / appliedCount) * 100) : 0,
      color: 'bg-emerald-500',
    },
  ];

  const totalCategorized = superDreamCount + dreamCount + regularCount + unknownCtcCount || 1;

  return (
    <div data-testid="analytics-page" className="mx-auto max-w-7xl space-y-5 sm:space-y-6 w-full min-w-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 sm:gap-4">
        <div>
          <div className="flex items-center gap-2.5 sm:gap-3">
            <h1 className="font-display text-xl sm:text-3xl font-extrabold tracking-tight text-white">
              Placement Radar Analytics
            </h1>
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-xs font-bold text-emerald-300">
              LIVE
            </span>
          </div>
          <p className="mt-1 text-xs sm:text-sm text-zinc-500">
            2027 Placement Season
            {neoId && (
              <>
                {' '}· <span className="font-mono text-zinc-400">{neoId}</span>
              </>
            )}
            {campus && (
              <>
                {' '}· <span className="text-zinc-400">{campus}{branch ? ` (${branch})` : ''}</span>
              </>
            )}
          </p>
        </div>

        <Link
          href="/companies"
          className="flex items-center gap-1.5 text-xs font-semibold text-zinc-500 hover:text-emerald-400 transition-colors"
        >
          View all drives in directory <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {/* 4 Funnel Metric Cards (Emergent Card Design) */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 sm:grid-cols-4">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="rounded-2xl border border-indigo-500/20 bg-indigo-500/[0.05] p-3.5 sm:p-5 min-w-0"
        >
          <div className="font-mono text-[9px] sm:text-[10px] uppercase tracking-widest text-indigo-300 truncate">
            Drives Synced
          </div>
          <div className="font-tabular mt-1.5 sm:mt-2 font-display text-2xl sm:text-3xl font-extrabold text-white">
            {companiesCount || applications.length}
          </div>
          <div className="mt-1 font-mono text-[10px] sm:text-[11px] text-zinc-500 truncate">
            {appliedCount} applied · {Math.max(0, (companiesCount || applications.length) - appliedCount)} opted out
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.05 }}
          className="rounded-2xl border border-violet-500/20 bg-violet-500/[0.05] p-3.5 sm:p-5 min-w-0"
        >
          <div className="font-mono text-[9px] sm:text-[10px] uppercase tracking-widest text-violet-300 truncate">
            Shortlist Rate
          </div>
          <div className="font-tabular mt-1.5 sm:mt-2 font-display text-2xl sm:text-3xl font-extrabold text-white">
            {shortlistRate}%
          </div>
          <div className="mt-1 font-mono text-[10px] sm:text-[11px] text-zinc-500 truncate">
            {shortlistedCount} of {appliedCount} applied drives
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.05] p-3.5 sm:p-5 min-w-0"
        >
          <div className="font-mono text-[9px] sm:text-[10px] uppercase tracking-widest text-emerald-300 truncate">
            Peak Applied CTC
          </div>
          <div className="font-tabular mt-1.5 sm:mt-2 font-display text-2xl sm:text-3xl font-extrabold text-emerald-300">
            {highestCtcFormatted}
          </div>
          <div className="mt-1 font-mono text-[10px] sm:text-[11px] text-zinc-500 truncate">
            Highest among applied drives
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.15 }}
          className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.05] p-3.5 sm:p-5 min-w-0"
        >
          <div className="font-mono text-[9px] sm:text-[10px] uppercase tracking-widest text-amber-300 truncate">
            Avg Applied CTC
          </div>
          <div className="font-tabular mt-1.5 sm:mt-2 font-display text-2xl sm:text-3xl font-extrabold text-white">
            {avgAppliedCtc}
          </div>
          <div className="mt-1 font-mono text-[10px] sm:text-[11px] text-zinc-500 truncate">
            Across {appliedCtcCount} applied drives with CTC
          </div>
        </motion.div>
      </div>

      {/* Section 1: Conversion Funnel Card */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.2 }}
        className="rounded-2xl border border-zinc-800 bg-[#101014] p-6"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-base font-bold text-white">
              Recruitment Progression Funnel
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Stage-by-stage progression from application to final offer
            </p>
          </div>
          <span className="font-mono text-[10px] text-zinc-500">
            {appliedCount} Total In Pipeline
          </span>
        </div>

        <div className="mt-6 space-y-4">
          {funnelSteps.map((s, idx) => (
            <div key={s.label} className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-zinc-200">{s.label}</span>
                <div className="flex items-center gap-3 font-mono text-[11px]">
                  <span className="font-bold text-zinc-300 font-tabular">{s.count} drives</span>
                  <span className="text-zinc-500">{s.pct}%</span>
                </div>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-900 border border-zinc-800">
                <div
                  className={`h-full rounded-full ${s.color} transition-all duration-500`}
                  style={{ width: `${s.pct}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Section 2: Compensation Tier Distribution */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full min-w-0 max-w-full">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.25 }}
          className="rounded-2xl border border-zinc-800 bg-[#101014] p-4 sm:p-6 flex flex-col justify-between h-full"
        >
          <div>
            <div className="flex items-center gap-2">
              <Award className="h-4 w-4 text-violet-400" />
              <h2 className="font-display text-base font-bold text-white">
                Applied CTC Distribution
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-zinc-500">
              Hiring tier breakdown across your {appliedCount} applied drives (excluding opted out)
            </p>
          </div>

          <div className="mt-5 space-y-3">
            {/* Super Dream */}
            <div className="rounded-xl border border-violet-500/25 bg-violet-500/[0.05] p-3">
              <div className="flex items-center justify-between">
                <span className="rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-bold text-violet-300 uppercase tracking-wider">
                  Super Dream (≥ ₹10 LPA)
                </span>
                <span className="font-tabular font-mono text-sm font-bold text-white">
                  {superDreamCount} drives
                </span>
              </div>
              <div className="mt-2 text-xs text-zinc-400">
                {Math.round((superDreamCount / totalCategorized) * 100)}% of your applied drives
              </div>
            </div>

            {/* Dream */}
            <div className="rounded-xl border border-sky-500/25 bg-sky-500/[0.05] p-3">
              <div className="flex items-center justify-between">
                <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold text-sky-300 uppercase tracking-wider">
                  Dream (₹6 – ₹10 LPA)
                </span>
                <span className="font-tabular font-mono text-sm font-bold text-white">
                  {dreamCount} drives
                </span>
              </div>
              <div className="mt-2 text-xs text-zinc-400">
                {Math.round((dreamCount / totalCategorized) * 100)}% of your applied drives
              </div>
            </div>

            {/* Regular */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
              <div className="flex items-center justify-between">
                <span className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                  Regular / Core (&lt; ₹6 LPA)
                </span>
                <span className="font-tabular font-mono text-sm font-bold text-white">
                  {regularCount} drives
                </span>
              </div>
              <div className="mt-2 text-xs text-zinc-400">
                {Math.round((regularCount / totalCategorized) * 100)}% of your applied drives
              </div>
            </div>

            {/* Unknown */}
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-3">
              <div className="flex items-center justify-between">
                <span className="rounded-md border border-zinc-700/50 bg-zinc-800/50 px-2 py-0.5 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                  Unknown / TBA
                </span>
                <span className="font-tabular font-mono text-sm font-bold text-zinc-300">
                  {unknownCtcCount} drives
                </span>
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                {Math.round((unknownCtcCount / totalCategorized) * 100)}% of your applied drives
              </div>
            </div>
          </div>
        </motion.div>

        {/* Section 3: Telemetry & Radar Health */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.3 }}
          className="rounded-2xl border border-zinc-800 bg-[#101014] p-4 sm:p-6 flex flex-col justify-between h-full"
        >
          <div>
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-emerald-400" />
              <h2 className="font-display text-base font-bold text-white">
                Engine Telemetry
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-zinc-500">
              Live background scanner and parsing metrics
            </p>

            <div className="mt-5 sm:mt-6 space-y-3">
              <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Building2 className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span className="text-xs text-zinc-300 font-medium truncate">Tracked Drives</span>
                </div>
                <span className="font-mono text-xs font-bold text-zinc-100 shrink-0 whitespace-nowrap">{(companiesCount || 0).toLocaleString()}</span>
              </div>

              <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Mail className="h-4 w-4 text-sky-400 shrink-0" />
                  <span className="text-xs text-zinc-300 font-medium truncate">Emails & Circulars</span>
                </div>
                <span className="font-mono text-xs font-bold text-zinc-100 shrink-0 whitespace-nowrap">{(emailsCount || 0).toLocaleString()}</span>
              </div>

              <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
                <div className="flex items-center gap-2.5 min-w-0">
                  <FileSpreadsheet className="h-4 w-4 text-violet-400 shrink-0" />
                  <div className="min-w-0">
                    <span className="text-xs text-zinc-300 font-medium block truncate">Shortlist Matches</span>
                    <span className="text-[10px] font-mono text-zinc-500 block truncate">
                      {matchesCount || 0} detections across {uniqueMatchesCount || 0} drives
                    </span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <span className="font-mono text-xs font-bold text-violet-300">{uniqueMatchesCount || matchesCount} Drives</span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
                <div className="flex items-center gap-2.5 min-w-0">
                  <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span className="text-xs text-zinc-300 font-medium truncate">Sync Frequency</span>
                </div>
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[11px] font-bold text-emerald-300 shrink-0 whitespace-nowrap">
                  Every 15 mins
                </span>
              </div>
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3 sm:p-3.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              <span className="text-xs font-semibold text-emerald-300 truncate">Dual Inbox Watch Active</span>
            </div>
            <span className="font-mono text-[10px] text-zinc-500 shrink-0 whitespace-nowrap">AES-256 Vault</span>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
