'use client';

import { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  FileSpreadsheet,
  Mail,
  ChevronDown,
  AlertTriangle,
  CalendarPlus,
  Trash2,
  CheckCircle2,
  ExternalLink,
  Plane,
  Building2,
  Globe,
} from 'lucide-react';
import { cn, timeAgo, getDriveMode } from '@/lib/utils';
import { CategoryBadge, STATUS_META } from '@/components/ui/status-chip';
import { StageStepper, getStageIndex, getEffectiveStage, isEliminatedStatus } from '@/components/companies/stage-stepper';
import { cleanLocationString } from '@/lib/sync/locations';

export interface CompanyDetail {
  id: string;
  name: string;
  legalName: string | null;
  aliases: string[] | null;
  driveNumber?: string | null;
  driveName?: string | null;
  candidateName?: string | null;
  candidateRegId?: string | null;
  application: {
    id: string;
    status: string;
    statusSource: string | null;
    statusConfidence: string | null;
    role: string | null;
    category?: string | null;
    ctc: string | null;
    stipend: string | null;
    location: string | null;
    eligibility: string | null;
    manualOverride: boolean;
    notes: string | null;
    appliedAt: string | null;
    lastUpdated: string;
  } | null;
  events: {
    id: string;
    eventType: string;
    title: string | null;
    startTime: string | null;
    venue: string | null;
    mode: string | null;
  }[];
  emails: {
    id: string;
    subject: string;
    sender: string;
    receivedAt: string;
    snippet: string;
    classification: string;
    threadId?: string | null;
    gmailMessageId?: string | null;
    accountEmail?: string | null;
    attachmentName?: string | null;
  }[];
  candidateMatches: {
    id: string;
    emailId?: string | null;
    matchType: string;
    matchedValue: string | null;
    matchLocation?: string | null;
    neoId?: string | null;
    createdAt: string;
  }[];
}

function parseCandidateMatchDetails(matchedValue: string | null, neoId?: string | null) {
  if (!matchedValue) return null;

  // XLSX match pattern: Matched in <filename> (<sheet>!<cell>) [<col>] [ - <venue>]
  const xlsxRegex = /^Matched in (.+?)\s*\((.+?)!(.+?)\)(?:\s*\[(.+?)\])?(?:\s*-\s*(.+))?$/i;
  const xlsxMatch = matchedValue.match(xlsxRegex);

  if (xlsxMatch) {
    const [, filename, sheet, cell, col, venue] = xlsxMatch;
    return {
      type: 'xlsx' as const,
      filename: filename.trim(),
      location: `${sheet}!${cell}`,
      column: col ? (col.startsWith('Col ') ? col : `Col ${col}`) : 'ID Column',
      venue: venue ? venue.trim() : null,
      identifier: neoId ? `Neo ID: ${neoId}` : 'Neo ID Verified',
    };
  }

  // Google Sheet pattern
  const gsheetRegex = /^Matched in Google Sheet \((.+?)\):\s*(.+)$/i;
  const gsheetMatch = matchedValue.match(gsheetRegex);
  if (gsheetMatch) {
    const [, sheet, rowText] = gsheetMatch;
    return {
      type: 'gsheet' as const,
      filename: `Google Sheet (${sheet.trim()})`,
      location: sheet.trim(),
      column: 'Spreadsheet Row',
      venue: null,
      identifier: rowText.trim(),
    };
  }

  return {
    type: 'general' as const,
    filename: 'Shortlist Roster',
    location: 'Verified Record',
    column: 'Direct Match',
    venue: null,
    identifier: matchedValue,
  };
}

interface CompanyDetailClientProps {
  company: CompanyDetail;
  userCampus?: 'VIT Bhopal' | 'VIT Vellore' | 'VIT Chennai' | 'VIT AP';
  userBranch?: string | null;
  userRegNo?: string | null;
}

const STAGES = ['Applied', 'Shortlisted', 'Test', 'Interview', 'Offer'];

const ALL_STATUSES = [
  { value: 'applied', label: 'Applied' },
  { value: 'ppt_scheduled', label: 'PPT Scheduled' },
  { value: 'shortlisted', label: 'Shortlisted for Test' },
  { value: 'test_scheduled', label: 'Test Scheduled' },
  { value: 'test_completed', label: 'Test Completed (Awaiting Results)' },
  { value: 'interview_scheduled', label: 'Interview Scheduled' },
  { value: 'selected', label: 'Selected / Offer 🎉' },
  { value: 'not_shortlisted', label: 'Not Shortlisted for Test (Screening)' },
  { value: 'rejected_test', label: 'Eliminated in Test Round (Post-Test)' },
  { value: 'rejected_interview', label: 'Interviewed · Not Selected (Post-Interview)' },
  { value: 'declined', label: 'Declined / Opted Out' },
  { value: 'withdrawn', label: 'Withdrawn' },
  { value: 'not_applied', label: 'Not Applied' },
];

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

const Stepper = ({ stage, status }: { stage: number; status: string }) => (
  <StageStepper stage={stage} status={status} />
);

function getCleanEmailSummary(
  rawSnippet: string | null | undefined,
  subject: string,
  classification: string,
  companyName: string
): string {
  if (!rawSnippet || rawSnippet.trim().length === 0) {
    if (classification === 'shortlist' || subject.toLowerCase().includes('shortlist')) {
      return `Registrations screened and shortlist confirmed for ${companyName}. Candidate matches verified in attachment.`;
    }
    if (classification === 'test' || subject.toLowerCase().includes('test') || subject.toLowerCase().includes('assessment')) {
      return `Online assessment and technical test details released for ${companyName}. Review schedule and test window.`;
    }
    if (classification === 'interview' || subject.toLowerCase().includes('interview')) {
      return `Technical interview schedule and reporting instructions released for ${companyName}.`;
    }
    return `Official recruitment circular and process announcement released for ${companyName}.`;
  }

  // Strip disclaimers, common email headers, signatures
  let clean = rawSnippet
    .replace(/<[^>]+>/g, ' ')
    .replace(/(?:this email|disclaimer|confidentiality notice|the information contained in this transmission|forwarded message|greetings from|dear student|dear candidate|warm regards|thanks & regards|placement office|vit vellore|vit bhopal|vit chennai)[\s\S]*/i, '')
    .replace(/^(?:from|to|sent|subject|date):[^\n\r]+/gim, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (clean.length < 20) {
    clean = rawSnippet.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Pick the first 1-2 clean sentences (max 180 chars)
  const sentences = clean.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length > 0) {
    let result = sentences[0].trim();
    if (result.length < 85 && sentences.length > 1) {
      result += ' ' + sentences[1].trim();
    }
    if (result.length > 180) {
      result = result.slice(0, 175).trim() + '…';
    }
    return result;
  }

  if (clean.length > 180) {
    return clean.slice(0, 175).trim() + '…';
  }

  return clean;
}

function getGmailLink(email: {
  threadId?: string | null;
  gmailMessageId?: string | null;
  subject?: string | null;
  accountEmail?: string | null;
}) {
  const authParam = email.accountEmail ? `?authuser=${encodeURIComponent(email.accountEmail)}` : '';
  if (email.threadId) {
    return `https://mail.google.com/mail/u/${authParam}#all/${email.threadId}`;
  }
  if (email.gmailMessageId) {
    return `https://mail.google.com/mail/u/${authParam}#search/rfc822msgid:${email.gmailMessageId}`;
  }
  if (email.subject) {
    return `https://mail.google.com/mail/u/${authParam}#search/${encodeURIComponent(email.subject)}`;
  }
  return `https://mail.google.com/mail/u/0/#inbox`;
}

export default function CompanyDetailClient({
  company,
  userCampus = 'VIT Bhopal',
  userBranch,
  userRegNo,
}: CompanyDetailClientProps) {
  const router = useRouter();
  const rawStatus = company.application?.status || 'applied';
  const notesStr = company.application?.notes || '';
  const isManual = company.application?.manualOverride ?? false;

  const initialDropdownStatus = useMemo(() => {
    if (rawStatus === 'rejected') {
      // Use the same note patterns that getEffectiveStage uses
      if (/eliminated.*interview|interview.*eliminated|interviewed.*not\s*selected|rejected.*interview/i.test(notesStr)) return 'rejected_interview';
      if (/eliminated.*test|test.*eliminated|rejected.*test|test.*rejected/i.test(notesStr)) return 'rejected_test';
      return 'not_shortlisted';
    }
    return rawStatus;
  }, [rawStatus, notesStr]);

  const [status, setStatus] = useState(initialDropdownStatus);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [openAccordion, setOpenAccordion] = useState<number | null>(0);
  const [isDeleting, setIsDeleting] = useState(false);

  // Keep state in sync if server props update
  useEffect(() => {
    setStatus(initialDropdownStatus);
  }, [initialDropdownStatus]);

  const effective = useMemo(
    () => getEffectiveStage(status, null, company.events, notesStr, isManual),
    [status, company.events, notesStr, isManual]
  );

  // The canonical status string to display in the chip — always use the effective
  // status so the detail page matches exactly what the company card shows.
  const displayStatus = effective.effectiveStatus;

  const stage = effective.stageIndex;
  const isWithdrawn =
    displayStatus === 'withdrawn' ||
    displayStatus === 'declined' ||
    status === 'withdrawn' ||
    status === 'declined';
  const isEliminated =
    isEliminatedStatus(displayStatus) ||
    isEliminatedStatus(status) ||
    effective.eliminatedStage !== -1;
  const terminal = isWithdrawn || isEliminated;
  const hue = useMemo(() => getHue(company.name), [company.name]);
  const initials = company.name.slice(0, 2).toUpperCase();

  const handleStatusChange = async (newStatus: string) => {
    setIsUpdating(true);
    setShowStatusMenu(false);

    let patchStatus = newStatus;
    let patchNotes: string | null = null;

    if (newStatus === 'rejected_test') {
      patchStatus = 'rejected';
      patchNotes = 'Eliminated in Test Round';
    } else if (newStatus === 'rejected_interview') {
      patchStatus = 'rejected';
      patchNotes = 'Interviewed · Not Selected';
    } else if (newStatus === 'not_shortlisted') {
      patchStatus = 'not_shortlisted';
      patchNotes = 'Not Shortlisted for Test';
    } else {
      // Switching to non-rejection status: clear previous rejection notes
      patchNotes = null;
    }

    try {
      const res = await fetch(`/api/companies/${company.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: patchStatus, notes: patchNotes }),
      });
      if (res.ok) {
        setStatus(newStatus);
        if (company.application) {
          company.application.status = patchStatus;
          company.application.notes = patchNotes;
          company.application.manualOverride = true;
        } else {
          company.application = {
            id: '',
            status: patchStatus,
            statusSource: 'manual_override',
            statusConfidence: 'manual',
            role: null,
            ctc: null,
            stipend: null,
            location: null,
            eligibility: null,
            manualOverride: true,
            notes: patchNotes,
            appliedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
          };
        }
        router.refresh();
      }
    } catch (err) {
      console.error('Failed to update status:', err);
    } finally {
      setIsUpdating(false);
    }
  };

  // Clean location
  const displayLocation = cleanLocationString(company.application?.location);

  // Drive Mode & Travel: Standardized to operational venues:
  // 'Online', 'VIT Vellore', 'VIT Chennai', 'VIT AP', or home campus labs ('Vellore Labs', 'Bhopal Labs', etc.)
  const driveModeDisplay = getDriveMode(notesStr, userCampus);

  // Role display
  const displayRole = (() => {
    const r = company.application?.role;
    if (
      !r ||
      /\byou\s*(?:are|have|re)\b|dear\s|greetings|eligible|registr/i.test(r) ||
      /^(?:super\s+dream|dream|regular)(?:\s+(?:internship|offer|placement|drive))?$/i.test(r.trim())
    ) {
      return company.application?.category ? 'Campus Placement Drive' : 'Software Engineering Profile';
    }
    return r;
  })();

  const category = company.application?.category || (/1[0-9]\s*lpa|[2-9][0-9]\s*lpa/i.test(company.application?.ctc || '') ? 'Super Dream' : 'Dream');

  const nextUpcomingEvent = company.events.find((e) => e.startTime && new Date(e.startTime).getTime() > Date.now());

  // Derive 4 CTC cards like Emergent: Total CTC, Fixed, Bonus, ESOPs
  const rawCtc = company.application?.ctc || '';
  const cleanCtc = rawCtc.replace(/\*/g, '').trim() || 'TBA';
  const stipend = company.application?.stipend?.replace(/\*/g, '').trim() || null;
  const cleanStipend = useMemo(() => {
    if (!stipend) return null;
    let s = stipend.trim();
    s = s.replace(/\/month\/mo$/i, '/month').replace(/\/mo\/mo$/i, '/mo');
    if (/^\d+$/.test(s)) {
      s = `₹${Number(s).toLocaleString('en-IN')}/month`;
    }
    return s;
  }, [stipend]);

  // Eligibility pills
  const eligibilityList = useMemo(() => {
    const raw = company.application?.eligibility || company.application?.notes || '';
    const pills: string[] = [];
    const cgpaMatch = raw.match(/cgpa\s*(?:>=|:|of|above)?\s*(\d+(?:\.\d+)?)/i);
    if (cgpaMatch) pills.push(`CGPA >= ${cgpaMatch[1]}`);
    else pills.push('CGPA >= 7.0');

    if (/no\s*(?:standing)?\s*arrears|0\s*arrear/i.test(raw)) pills.push('No standing arrears');
    if (/cse|it|ece|circuital/i.test(raw)) pills.push('CSE / IT / ECE');
    else pills.push('All Eligible Branches');

    return pills;
  }, [company.application?.eligibility, company.application?.notes]);

  return (
    <div data-testid="company-detail-page" className="mx-auto max-w-4xl space-y-4 w-full min-w-0 my-3">
      {/* Back button */}
      <button
        data-testid="back-to-pipeline-btn"
        onClick={() => router.back()}
        className="flex items-center gap-2 text-xs font-semibold text-zinc-500 transition-colors hover:text-zinc-200 cursor-pointer"
      >
        <ArrowLeft className="h-4 w-4" /> Back to pipeline
      </button>

      {/* Header Card */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45 }}
        className="rounded-2xl border border-zinc-800 bg-bg-surface p-4 sm:p-6"
      >
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
          <div className="flex items-start gap-3 sm:gap-4 min-w-0 flex-1">
            <div className={`flex h-12 w-12 sm:h-14 sm:w-14 shrink-0 items-center justify-center rounded-xl border font-display text-base sm:text-lg font-bold ${hue}`}>
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-xl sm:text-2xl font-extrabold tracking-tight text-white truncate">{company.name}</h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <span className="text-xs sm:text-sm text-zinc-300 font-medium truncate">{displayRole}</span>
                <CategoryBadge category={category} />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-2.5 self-start sm:self-auto shrink-0">
            {/* Status override dropdown — single unified pill with cursor-pointer */}
            <div className="relative">
              {(() => {
                // Use effectiveStatus (same as the company card) so both show identical labels
                const normStatus = (displayStatus || 'not_applied').toLowerCase();
                const m = STATUS_META[normStatus] || STATUS_META.not_applied;
                return (
                  <button
                    onClick={() => setShowStatusMenu(!showStatusMenu)}
                    disabled={isUpdating}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-all cursor-pointer select-none hover:brightness-110 active:scale-95',
                      m.cls
                    )}
                    title="Click to manually update hiring status"
                  >
                    <span className={cn('h-2 w-2 rounded-full shrink-0', m.dot, m.isPulse ? 'pulse-dot' : '')} />
                    <span>{m.label}</span>
                    <ChevronDown className="h-3.5 w-3.5 opacity-60 transition-transform" />
                  </button>
                );
              })()}

              {showStatusMenu && (
                <>
                  <div
                    className="fixed inset-0 z-40 cursor-default"
                    onClick={() => setShowStatusMenu(false)}
                  />
                  <div className="absolute right-0 top-full mt-2 w-52 p-1.5 bg-[#12121c] border border-zinc-800 rounded-xl shadow-2xl z-50 animate-fade-in divide-y divide-zinc-800/60 max-h-72 overflow-y-auto">
                    <div className="px-3 py-1.5 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                      Override Status
                    </div>
                    <div className="space-y-0.5 pt-1">
                      {ALL_STATUSES.map((s) => (
                        <button
                          key={s.value}
                          onClick={() => handleStatusChange(s.value)}
                          className={cn(
                            'flex items-center justify-between w-full px-3 py-2 text-xs rounded-lg transition-colors text-left cursor-pointer',
                            status === s.value
                              ? 'bg-emerald-500/10 text-emerald-400 font-bold'
                              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
                          )}
                        >
                          <span>{s.label}</span>
                          {status === s.value && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Delete button */}
            <button
              onClick={async () => {
                if (!confirm(`Delete "${company.name}" and all its events, status, and linked data? This cannot be undone.`)) return;
                setIsDeleting(true);
                try {
                  const res = await fetch(`/api/companies/${company.id}`, { method: 'DELETE' });
                  if (res.ok) {
                    router.push('/companies');
                  } else {
                    alert('Failed to delete company');
                  }
                } catch {
                  alert('Failed to delete company');
                } finally {
                  setIsDeleting(false);
                }
              }}
              disabled={isDeleting}
              className="p-2 rounded-lg border border-zinc-800 bg-zinc-900/60 text-zinc-500 hover:text-rose-400 hover:border-rose-500/30 transition-colors cursor-pointer"
              title="Delete company"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 4 Info Cards (CTC, Stipend, Drive Mode, Work Location) */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div data-testid="ctc-total" className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3.5 py-3">
            <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">Total CTC</div>
            <div className="font-tabular mt-1 font-display text-lg font-bold text-emerald-300 truncate" title={cleanCtc}>
              {cleanCtc}
            </div>
          </div>

          <div data-testid="ctc-stipend" className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3.5 py-3">
            <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">Stipend</div>
            <div className="font-tabular mt-1 font-display text-lg font-bold text-zinc-200 truncate" title={cleanStipend || 'TBA'}>
              {cleanStipend || (cleanCtc !== 'TBA' ? 'Included in CTC' : 'TBA')}
            </div>
          </div>

          <div data-testid="ctc-drive-mode" className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3.5 py-3">
            <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">Drive Mode</div>
            {(() => {
              const driveColor =
                driveModeDisplay === 'Online'
                  ? 'text-emerald-300'
                  : driveModeDisplay.endsWith('Labs')
                  ? 'text-indigo-300'
                  : driveModeDisplay === 'VIT Vellore'
                  ? 'text-amber-300'
                  : driveModeDisplay === 'VIT Chennai'
                  ? 'text-orange-300'
                  : driveModeDisplay === 'VIT AP'
                  ? 'text-purple-300'
                  : 'text-cyan-300';
              return (
                <div className={cn("font-tabular mt-1 font-display text-lg font-bold truncate", driveColor)} title={driveModeDisplay}>
                  {driveModeDisplay}
                </div>
              );
            })()}
          </div>

          <div data-testid="ctc-location" className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3.5 py-3">
            <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">Work Location</div>
            <div
              className={cn(
                "font-tabular mt-1 font-display text-lg font-bold truncate",
                (!displayLocation || displayLocation === 'Not Specified') ? "text-zinc-500 font-medium text-base" : "text-zinc-200"
              )}
              title={displayLocation && displayLocation !== 'Not Specified' ? displayLocation : 'To be announced'}
            >
              {displayLocation && displayLocation !== 'Not Specified' ? displayLocation : 'TBA'}
            </div>
          </div>
        </div>

        {/* Eligibility Pills */}
        <div className="mt-4 flex flex-wrap gap-2">
          {eligibilityList.map((e) => (
            <span
              key={e}
              className="rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 font-mono text-[10px] text-zinc-400"
            >
              {e}
            </span>
          ))}
        </div>

        {/* Venue / Instructions Banner */}
        {nextUpcomingEvent && (
          <div
            data-testid="venue-banner"
            className="mt-4 flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/6 px-4 py-3 text-xs text-amber-200/90"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div>
              <span className="font-semibold">{nextUpcomingEvent.title || 'Assessment Instructions'}:</span>{' '}
              {new Date(nextUpcomingEvent.startTime!).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
              {nextUpcomingEvent.venue && ` · Venue: ${nextUpcomingEvent.venue}`}
              {nextUpcomingEvent.mode && ` (${nextUpcomingEvent.mode})`}
            </div>
          </div>
        )}

        {/* Terminal state banner */}
        {terminal && (
          <div
            data-testid="terminal-banner"
            className="mt-4 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-xs text-zinc-400"
          >
            {isWithdrawn
              ? 'You opted out or withdrew from this drive. Archived from the active pipeline.'
              : displayStatus === 'rejected_test' || status === 'rejected_test' || effective.eliminatedStage === 3
              ? 'Eliminated in the test round. This drive is archived — the radar stays on the next ones.'
              : displayStatus === 'rejected_interview' || status === 'rejected_interview' || effective.eliminatedStage === 4
              ? 'Interview completed · Not selected. This drive is archived — the radar stays on the next ones.'
              : displayStatus === 'not_shortlisted' || status === 'not_shortlisted' || effective.eliminatedStage === 2
              ? "Your ID wasn't in the shortlist. This drive is archived — the radar stays on the next ones."
              : "Your ID wasn't in the final selection sheet. This drive is archived — the radar stays on the next ones."}
          </div>
        )}
      </motion.div>

      {/* Recruitment Stage Stepper */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.1 }}
        className="rounded-2xl border border-zinc-800 bg-bg-surface p-6"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">Recruitment Stage</h2>
          <span
            className={cn(
              'font-mono text-[10px]',
              effective.eliminatedStage !== -1 ? 'text-rose-400 font-semibold' : 'text-zinc-500'
            )}
          >
            {effective.statusSubtitle}
          </span>
        </div>
        <StageStepper status={status} events={company.events} notes={notesStr} manualOverride={isManual} />
      </motion.div>

      {/* Circular & Email Timeline */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.2 }}
        className="rounded-2xl border border-zinc-800 bg-bg-surface p-4 sm:p-6 w-full min-w-0 overflow-hidden"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
            Circular & Email Timeline
          </h2>
          <span className="font-mono text-[10px] text-zinc-600">
            {company.emails.length} events
          </span>
        </div>

        {company.emails.length === 0 ? (
          <div className="py-8 text-center text-xs text-zinc-500 font-mono">
            No emails or circulars linked to this company yet.
          </div>
        ) : (
          <div className="relative space-y-2.5 before:absolute before:bottom-2 before:left-3.75 before:top-2 before:w-px before:bg-zinc-800 w-full min-w-0">
            {company.emails.map((email, idx) => {
              const isShortlist = email.classification === 'shortlist' || email.subject.toLowerCase().includes('shortlist');
              const isTest = email.classification === 'test' || email.subject.toLowerCase().includes('test') || email.subject.toLowerCase().includes('assessment');
              const isInterview = email.classification === 'interview' || email.subject.toLowerCase().includes('interview');
              const isOffer = email.classification === 'selected' || email.subject.toLowerCase().includes('offer') || email.subject.toLowerCase().includes('congratulations');

              const Icon = isOffer ? FileSpreadsheet : isInterview ? CalendarPlus : isTest ? AlertTriangle : isShortlist ? FileSpreadsheet : Mail;
              const iconCls = isOffer
                ? 'border-emerald-500/50 bg-[#121218] text-emerald-400'
                : isInterview
                ? 'border-cyan-500/50 bg-[#121218] text-cyan-400'
                : isTest
                ? 'border-amber-500/50 bg-[#121218] text-amber-400'
                : isShortlist
                ? 'border-violet-500/50 bg-[#121218] text-violet-400'
                : 'border-sky-500/40 bg-[#121218] text-sky-400';

              const isOpen = openAccordion === idx;
              const isPersonal = email.sender.includes('noreply.cdcinfo');
              const matchedCandidate = company.candidateMatches.find((cm) => cm.emailId === email.id);

              return (
                <div key={email.id} data-testid={`timeline-item-${idx}`} className="relative flex items-start gap-3 sm:gap-4 w-full min-w-0">
                  <div className={cn('z-10 mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border shadow-sm ring-4 ring-bg-surface', iconCls)}>
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                  </div>

                  <div className="mb-1 flex-1 min-w-0 rounded-xl border border-zinc-800/80 bg-zinc-900/40 transition-colors overflow-hidden">
                    <button
                      data-testid={`timeline-toggle-${idx}`}
                      onClick={() => setOpenAccordion(isOpen ? null : idx)}
                      className="flex w-full items-center justify-between gap-3 px-3.5 sm:px-4 py-3 text-left min-w-0 hover:bg-zinc-900/60 transition-colors cursor-pointer"
                    >
                      <div className="flex-1 min-w-0 overflow-hidden">
                        <div className="text-xs sm:text-sm font-semibold text-zinc-200 line-clamp-2 leading-snug wrap-break-word" title={email.subject}>
                          {email.subject}
                        </div>
                        <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-zinc-500">
                          <span suppressHydrationWarning>{timeAgo(email.receivedAt)}</span>
                          <span>·</span>
                          <span>{isPersonal ? 'personal gmail' : 'college gmail'}</span>
                        </div>
                      </div>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200 ${
                          isOpen ? 'rotate-180 text-zinc-300' : ''
                        }`}
                      />
                    </button>

                    <AnimatePresence>
                      {isOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden"
                        >
                          <div className="border-t border-zinc-800/80 px-4 py-3">
                            {/* Short, clean 1-2 line summary just like the reference designs */}
                            <p className="text-xs leading-relaxed text-zinc-300">
                              {getCleanEmailSummary(email.snippet, email.subject, email.classification, company.name)}
                            </p>

                            {/* Candidate Match Evidence ONLY if verified on THIS specific email */}
                            {matchedCandidate && (() => {
                              const matchInfo = parseCandidateMatchDetails(matchedCandidate.matchedValue, matchedCandidate.neoId || company.candidateRegId);
                              if (!matchInfo) return null;

                              return (
                                <div
                                  data-testid={`excel-evidence-${idx}`}
                                  className="mt-3 overflow-hidden rounded-lg border border-violet-500/25 bg-[#0e0e14]"
                                >
                                  <div className="flex items-center justify-between border-b border-zinc-800 bg-violet-500/[0.07] px-3 py-2">
                                    <span className="flex items-center gap-2 font-mono text-[10px] text-violet-300 font-medium truncate" title={matchInfo.filename}>
                                      <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                                      <span className="truncate">{matchInfo.filename}</span>
                                    </span>
                                    <span className="font-mono text-[9px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded shrink-0">
                                      shortlist verified
                                    </span>
                                  </div>
                                  <div className="overflow-x-auto">
                                    <div className="min-w-75 grid grid-cols-4 gap-px bg-zinc-800/70 font-mono text-[10px]">
                                      <div className="bg-[#0b0d11] px-2.5 sm:px-3 py-2 text-violet-300 truncate font-semibold">
                                        {matchInfo.identifier}
                                      </div>
                                      <div className="bg-[#0b0d11] px-2.5 sm:px-3 py-2 text-zinc-300 truncate">
                                        {matchInfo.location}
                                      </div>
                                      <div className="bg-[#0b0d11] px-2.5 sm:px-3 py-2 text-zinc-400 truncate">
                                        {matchInfo.column}
                                      </div>
                                      <div className="bg-[#0b0d11] px-2.5 sm:px-3 py-2 font-bold text-emerald-300 whitespace-nowrap text-center">
                                        MATCH ✓
                                      </div>
                                    </div>
                                  </div>
                                  {matchInfo.venue && (
                                    <div className="border-t border-zinc-800/60 bg-zinc-900/40 px-3 py-1.5 text-[10px] font-mono text-zinc-400">
                                      Venue / Reporting: <span className="text-zinc-200">{matchInfo.venue}</span>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}

                            {/* Action links row: Direct link to original Gmail thread */}
                            <div className="mt-3.5 flex flex-col xs:flex-row xs:items-center justify-between gap-2 pt-2.5 border-t border-zinc-800/60">
                              <a
                                href={getGmailLink(email)}
                                target="_blank"
                                rel="noopener noreferrer"
                                data-testid={`open-email-${idx}`}
                                className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300 transition-colors shrink-0 py-0.5"
                              >
                                <span>Open original email</span>
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                              <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500 min-w-0 max-w-full">
                                <span className="text-zinc-600 shrink-0">From:</span>
                                <span className="truncate" title={email.sender}>
                                  {email.sender}
                                </span>
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </motion.div>
    </div>
  );
}
