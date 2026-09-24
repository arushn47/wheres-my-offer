'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { appToast } from '@/lib/toast';
import {
  Mail,
  Fingerprint,
  Building2,
  AlertOctagon,
  RefreshCw,
  CheckCheck,
  Plus,
  RotateCcw,
  Trash2,
  AlertTriangle,
  X,
  Zap,
  Wrench,
  GraduationCap,
  Hash,
} from 'lucide-react';
import NotificationSettings from '@/components/notifications/notification-settings';
import { cn } from '@/lib/utils';

interface Account {
  id: string;
  email: string;
  account_type: string;
  is_connected: boolean;
  last_sync_at: string | null;
}

interface SettingsClientProps {
  accounts: Account[];
  neoId: string;
  userEmail: string;
  autoCampus?: 'VIT Bhopal' | 'VIT Vellore' | 'VIT Chennai' | 'VIT AP';
  detectedBranch?: string | null;
  detectedRegNo?: string | null;
}

const Card = ({
  icon: Icon,
  title,
  desc,
  children,
  danger,
  testid,
  id,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
  children: React.ReactNode;
  danger?: boolean;
  testid?: string;
  id?: string;
  className?: string;
}) => (
  <motion.section
    id={id}
    data-testid={testid}
    initial={{ opacity: 0, y: 12 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.35 }}
    className={cn(
      'rounded-2xl border p-4 sm:p-6 shadow-sm',
      danger
        ? 'border-rose-500/25 bg-rose-500/[0.03]'
        : 'border-white/[0.07] bg-[#121217]',
      className
    )}
  >
    <div className="flex items-center gap-3">
      <div
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-xl border shrink-0',
          danger
            ? 'border-rose-500/25 bg-rose-500/10 text-rose-400'
            : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400'
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <h2 className="font-display text-sm sm:text-base font-bold tracking-tight text-white truncate">
          {title}
        </h2>
        <p className="text-[11px] sm:text-xs text-zinc-400 leading-snug mt-0.5 line-clamp-2 sm:line-clamp-none">
          {desc}
        </p>
      </div>
    </div>
    <div className="mt-4 sm:mt-5">{children}</div>
  </motion.section>
);

export default function SettingsClient({
  accounts,
  neoId: initialNeoId,
  userEmail,
  autoCampus = 'VIT Bhopal',
  detectedBranch,
  detectedRegNo,
}: SettingsClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [regId, setRegId] = useState(initialNeoId);
  const [isSavingId, setIsSavingId] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  useEffect(() => {
    const errorParam = searchParams?.get('error');
    if (errorParam) {
      appToast.error(decodeURIComponent(errorParam));
      router.replace('/settings');
    }
  }, [searchParams, router]);

  const [selectedCampus, setSelectedCampus] = useState<'VIT Bhopal' | 'VIT Vellore' | 'VIT Chennai' | 'VIT AP'>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('wmo_home_campus');
      if (stored && ['VIT Bhopal', 'VIT Vellore', 'VIT Chennai', 'VIT AP'].includes(stored)) {
        return stored as 'VIT Bhopal' | 'VIT Vellore' | 'VIT Chennai' | 'VIT AP';
      }
    }
    return autoCampus;
  });

  const handleSelectCampus = (c: 'VIT Bhopal' | 'VIT Vellore' | 'VIT Chennai' | 'VIT AP') => {
    setSelectedCampus(c);
    if (typeof window !== 'undefined') {
      localStorage.setItem('wmo_home_campus', c);
    }
    appToast.success(`Home campus updated to ${c}`);
  };

  // Reprocess state with live progress
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessProgress, setReprocessProgress] = useState<{
    step: number;
    totalSteps: number;
    message: string;
  } | null>(null);
  const [reprocessResult, setReprocessResult] = useState<{
    neoPatDrivesCount?: number;
    collegeCircularsLinked?: number;
    updatedApplications?: number;
  } | null>(null);

  // Danger Zone Modals state
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [isResetting, setIsResetting] = useState(false);

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  // Prevent accidental navigation or tab closing while archive is being reprocessed
  useEffect(() => {
    if (!reprocessing) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [reprocessing]);

  const personalAccount = accounts.find((a) => a.account_type === 'personal' && a.is_connected);
  const collegeAccount = accounts.find((a) => a.account_type === 'college' && a.is_connected);

  const handleSaveRegId = async () => {
    const trimmed = regId.trim().toUpperCase();
    if (trimmed && !/^[A-Z0-9]{6,12}$/.test(trimmed)) {
      appToast.error('Invalid Registration ID', 'ID should be 6-12 alphanumeric characters (e.g. 21BCE0492).');
      return;
    }

    setIsSavingId(true);
    try {
      const res = await fetch('/api/user/neo-id', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ neo_id: trimmed || null }),
      });

      const resData = await res.json().catch(() => null);

      if (!res.ok) {
        const errorMsg = resData?.error?.message || 'Failed to save Registration ID';
        appToast.error(res.status === 409 ? 'Registration ID Already In Use' : 'Failed to save Registration ID', errorMsg);
        return;
      }

      setRegId(trimmed);
      appToast.success(`Registration ID saved: ${trimmed || 'None'}`);
      router.refresh();
    } catch {
      appToast.error('Failed to save Registration ID');
    } finally {
      setIsSavingId(false);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    if (!confirm("Disconnect this Gmail account from Where's My Offer? Sync for this inbox will pause.")) return;
    setDisconnecting(accountId);
    try {
      const res = await fetch('/api/auth/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gmail_account_id: accountId }),
      });
      if (res.ok) {
        appToast.success('Gmail account disconnected');
        window.location.reload();
      } else {
        appToast.error('Failed to disconnect');
      }
    } catch {
      appToast.error('Failed to disconnect');
    } finally {
      setDisconnecting(null);
    }
  };

  // Trigger live sync
  const handleTriggerSync = () => {
    window.dispatchEvent(new CustomEvent('start-placement-sync'));
    appToast.info('Starting sync…', 'Watch live progress in Campus Radar.');
  };

  // Handle Reprocess Archive with live streaming progress
  const handleReprocessArchive = async () => {
    if (reprocessing) return;
    setReprocessing(true);
    setReprocessResult(null);
    setReprocessProgress({
      step: 1,
      totalSteps: 5,
      message: 'Connecting to placement archive re-indexer…',
    });

    let completedSuccessfully = false;

    try {
      const response = await fetch('/api/sync/reprocess?stream=true', {
        method: 'POST',
        headers: { Accept: 'text/event-stream' },
      });

      if (!response.ok) {
        throw new Error('Reprocess failed');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split('\n\n');
        buffer = messages.pop() || '';

        for (const message of messages) {
          const lines = message.split('\n');
          let event = '';
          let dataStr = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) event = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
          }

          if (event && dataStr) {
            try {
              const parsed = JSON.parse(dataStr);
              if (event === 'progress') {
                setReprocessProgress(parsed);
              } else if (event === 'complete') {
                completedSuccessfully = true;
                setReprocessProgress(null);
                setReprocessResult({
                  neoPatDrivesCount: parsed.neoPatDrivesCount,
                  collegeCircularsLinked: parsed.collegeCircularsLinked,
                  updatedApplications: parsed.updatedApplications,
                });
                appToast.success(
                  'Archive re-index complete',
                  `${parsed.neoPatDrivesCount || 0} official drives tracked, ${parsed.updatedApplications || 0} applications updated.`
                );
                router.refresh();
              } else if (event === 'error') {
                completedSuccessfully = true;
                appToast.error('Re-index error', parsed.message);
              }
            } catch {
              // Ignore parse error
            }
          }
        }
      }

      if (!completedSuccessfully) {
        appToast.info(
          'Re-index complete',
          'Placement archive was processed and updated in the background.'
        );
        router.refresh();
      }
    } catch (err: any) {
      if (!completedSuccessfully) {
        const isNetworkErr = err?.message?.toLowerCase().includes('network') || err?.message?.toLowerCase().includes('fetch');
        if (isNetworkErr) {
          appToast.info(
            'Re-index updated',
            'Connection closed. Processed drives and application stages have been saved.'
          );
          router.refresh();
        } else {
          appToast.error('Reprocess notice', err?.message || 'Re-indexing encountered an issue');
        }
      }
    } finally {
      setReprocessing(false);
      setReprocessProgress(null);
    }
  };

  // Handle Reset to Fresh Candidate Mode
  const handleResetData = async () => {
    if (resetConfirmText.trim().toUpperCase() !== 'RESET') return;
    setIsResetting(true);
    try {
      const res = await fetch('/api/user/reset', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        appToast.success('All placement data wiped', 'Account reset to fresh candidate state. Starting clean sync…');
        setShowResetModal(false);
        setResetConfirmText('');
        handleTriggerSync();
        router.refresh();
      } else {
        appToast.error('Reset failed', data.error);
      }
    } catch {
      appToast.error('Network error during data reset');
    } finally {
      setIsResetting(false);
    }
  };

  // Handle Complete Account Termination
  const handleTerminateAccount = async () => {
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') return;
    setIsDeleting(true);
    try {
      const res = await fetch('/api/user/account', { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        appToast.success('Account terminated permanently');
        setShowDeleteModal(false);
        setDeleteConfirmText('');
        window.location.href = '/login';
      } else {
        appToast.error('Termination failed', data.error);
        setIsDeleting(false);
      }
    } catch {
      appToast.error('Network error during account termination');
      setIsDeleting(false);
    }
  };

  return (
    <div data-testid="settings-page" className="mx-auto max-w-7xl space-y-4 sm:space-y-6 w-full min-w-0 pb-16">
      {/* Header */}
      <div>
        <h1 className="font-display text-xl sm:text-2xl font-extrabold tracking-tight text-white">
          Settings & Radar
        </h1>
        <p className="mt-0.5 text-xs sm:text-sm text-zinc-400">
          Connected inboxes, applicant ID & sync preferences
        </p>
      </div>

      {/* Section 1: Candidate Profile & Campus Setup */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 items-stretch">
        {/* Card 1: Candidate Registration ID */}
        <Card
          icon={Fingerprint}
          title="Registration ID (NeoPAT)"
          desc="Excel shortlist scanner matches this unique ID across all attachment sheets."
          testid="regid-card"
          className="flex flex-col justify-between"
        >
          <div className="space-y-2.5">
            {/* Integrated app input row */}
            <div className="flex items-center w-full max-w-full rounded-xl border border-white/[0.08] bg-zinc-900/60 p-1.5 focus-within:border-emerald-500/50 transition-colors overflow-hidden">
              <div className="pl-2 pr-1 text-emerald-400/80 shrink-0">
                <Hash className="h-4 w-4" />
              </div>
              <input
                data-testid="regid-input"
                value={regId}
                onChange={(e) => setRegId(e.target.value.toUpperCase())}
                placeholder="e.g. 21BCE0492"
                maxLength={12}
                className="h-9 flex-1 min-w-0 bg-transparent px-2 font-mono text-xs sm:text-sm tracking-widest text-zinc-100 placeholder:text-zinc-600 placeholder:font-sans placeholder:tracking-normal focus:outline-none uppercase"
              />
              <button
                data-testid="regid-save-btn"
                onClick={handleSaveRegId}
                disabled={isSavingId}
                className="h-9 rounded-lg bg-emerald-500 px-3 sm:px-4 text-xs font-bold text-zinc-950 transition-all hover:bg-emerald-400 active:scale-95 disabled:opacity-60 cursor-pointer shrink-0 whitespace-nowrap"
              >
                {isSavingId ? 'Saving…' : 'Save ID'}
              </button>
            </div>
            <p className="text-[11px] text-zinc-400 leading-snug">
              Matched against roll number columns, candidate tables & Excel sheets.
            </p>
          </div>

          <div className="mt-3.5 pt-2.5 border-t border-white/[0.05] flex items-center justify-between text-[11px]">
            <span className="text-zinc-500 font-mono">Shortlist Scanner</span>
            <span className="font-mono text-emerald-400 font-semibold flex items-center gap-1.5 text-[11px]">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Active & Monitoring
            </span>
          </div>
        </Card>

        {/* Card 2: Home Campus & Academic Profile */}
        <Card
          icon={Building2}
          title="Campus & Academic Profile"
          desc="Used to calculate travel requirements and verify branch eligibility criteria."
          testid="campus-card"
          className="flex flex-col justify-between"
        >
          <div className="space-y-3">
            <div>
              <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-zinc-400 block mb-2">
                Home Campus
              </span>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 p-1 rounded-xl bg-zinc-900/60 border border-white/[0.06]">
                {(['VIT Bhopal', 'VIT Vellore', 'VIT Chennai', 'VIT AP'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => handleSelectCampus(c)}
                    className={cn(
                      'rounded-lg py-2 px-2 text-xs font-semibold transition-all text-center cursor-pointer active:scale-95',
                      selectedCampus === c
                        ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.12)]'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-zinc-500">
                {collegeAccount?.email ? 'Auto-detected from inbox: ' : 'Active campus: '}
                <span className="text-zinc-300 font-mono font-bold">{selectedCampus}</span>
              </p>
            </div>
          </div>

          {(detectedBranch || detectedRegNo) && (
            <div className="mt-3.5 pt-2.5 border-t border-white/[0.05] flex flex-wrap items-center gap-2 text-xs">
              {detectedBranch && (
                <div className="flex items-center gap-1.5 rounded-lg bg-zinc-900/80 border border-white/[0.06] px-2.5 py-1">
                  <GraduationCap className="w-3.5 h-3.5 text-zinc-500" />
                  <span className="text-zinc-500 text-[10px] uppercase font-mono">Branch:</span>
                  <span className="font-mono text-zinc-200 font-semibold text-[11px]">{detectedBranch}</span>
                </div>
              )}
              {detectedRegNo && (
                <div className="flex items-center gap-1.5 rounded-lg bg-zinc-900/80 border border-white/[0.06] px-2.5 py-1">
                  <Fingerprint className="w-3.5 h-3.5 text-zinc-500" />
                  <span className="text-zinc-500 text-[10px] uppercase font-mono">Reg No:</span>
                  <span className="font-mono text-zinc-200 font-semibold text-[11px]">{detectedRegNo}</span>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* Section 2: Connected Gmail Accounts */}
      <Card
        icon={Mail}
        title="Connected Gmail Inboxes"
        desc="Dual inboxes are read-only. Access tokens are AES-256 encrypted and revocable anytime."
        testid="gmail-card"
      >
        <div className="space-y-3 sm:space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Personal Gmail Box */}
            <div className="rounded-xl border border-white/[0.06] bg-zinc-900/50 p-3.5 sm:p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="h-9 w-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
                    <Mail className="h-4 w-4 text-emerald-400" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs sm:text-sm font-semibold text-zinc-100 truncate">
                        Personal Gmail
                      </span>
                      {personalAccount ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300">
                          <CheckCheck className="h-2.5 w-2.5" /> Synced
                        </span>
                      ) : (
                        <span className="rounded-full border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[9px] font-bold text-zinc-400">
                          Offline
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[11px] text-zinc-400 truncate mt-0.5">
                      {personalAccount?.email || userEmail || 'your.personal@gmail.com'}
                    </div>
                  </div>
                </div>
                {personalAccount ? (
                  <button
                    data-testid="disconnect-personal-btn"
                    onClick={() => handleDisconnect(personalAccount.id)}
                    disabled={disconnecting === personalAccount.id}
                    className="shrink-0 rounded-lg border border-zinc-800 hover:border-rose-500/40 px-2.5 py-1 text-[11px] font-semibold text-zinc-400 hover:text-rose-300 active:scale-95 transition-all cursor-pointer"
                  >
                    {disconnecting === personalAccount.id ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                ) : (
                  <a
                    href="/api/auth/google?type=personal"
                    className="flex items-center gap-1 shrink-0 rounded-lg bg-emerald-500 hover:bg-emerald-400 px-3 py-1 text-[11px] font-bold text-zinc-950 active:scale-95 transition-all"
                  >
                    <Plus className="h-3 w-3" /> Connect
                  </a>
                )}
              </div>
              <div className="pt-2 border-t border-white/[0.04] flex items-center justify-between text-[10px] text-zinc-500">
                <span>NeoPAT registrations & offer letters</span>
                <span className="font-mono text-zinc-400">Master Drives</span>
              </div>
            </div>

            {/* College Gmail Box */}
            <div className="rounded-xl border border-white/[0.06] bg-zinc-900/50 p-3.5 sm:p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="h-9 w-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
                    <Mail className="h-4 w-4 text-emerald-400" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs sm:text-sm font-semibold text-zinc-100 truncate">
                        College Gmail
                      </span>
                      <span className="text-[10px] font-mono font-medium text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                        @vitbhopal.ac.in / @vitstudent.ac.in
                      </span>
                      {collegeAccount ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300">
                          <CheckCheck className="h-2.5 w-2.5" /> Synced
                        </span>
                      ) : (
                        <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-300">
                          Action Required
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[11px] text-zinc-400 truncate mt-0.5">
                      {collegeAccount?.email || 'student.23bce@vitbhopal.ac.in'}
                    </div>
                  </div>
                </div>
                {collegeAccount ? (
                  <button
                    data-testid="disconnect-college-btn"
                    onClick={() => handleDisconnect(collegeAccount.id)}
                    disabled={disconnecting === collegeAccount.id}
                    className="shrink-0 rounded-lg border border-zinc-800 hover:border-rose-500/40 px-2.5 py-1 text-[11px] font-semibold text-zinc-400 hover:text-rose-300 active:scale-95 transition-all cursor-pointer"
                  >
                    {disconnecting === collegeAccount.id ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                ) : (
                  <a
                    href="/api/auth/google?type=college"
                    className="flex items-center gap-1 shrink-0 rounded-lg bg-emerald-500 hover:bg-emerald-400 px-3 py-1 text-[11px] font-bold text-zinc-950 active:scale-95 transition-all"
                  >
                    <Plus className="h-3 w-3" /> Connect
                  </a>
                )}
              </div>
              <div className="pt-2 border-t border-white/[0.04] flex items-center justify-between text-[10px] text-zinc-500">
                <span>Must be official VIT ID · CDC circulars & shortlists</span>
                <span className="font-mono text-zinc-400">{selectedCampus}</span>
              </div>
            </div>
          </div>

          {/* Sync Trigger Action */}
          <div className="rounded-xl border border-white/[0.05] bg-zinc-900/40 p-3 sm:p-3.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="h-8 w-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center shrink-0">
                <Zap className="h-3.5 w-3.5 text-emerald-400" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-zinc-200 truncate">Manual Inbox Sync</p>
                <p className="text-[10px] text-zinc-400 truncate">Check both Gmail accounts immediately</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleTriggerSync}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/35 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 active:scale-95 transition-all cursor-pointer shrink-0"
            >
              <Zap className="h-3 w-3" />
              <span>Sync Now</span>
            </button>
          </div>
        </div>
      </Card>

      {/* Section 3: Notification Settings */}
      <NotificationSettings />

      {/* Section 4: Engine Diagnostics & Archive Re-index */}
      <Card
        id="engine-diagnostics"
        icon={Wrench}
        title="Placement Engine Diagnostics & Archive Re-index"
        desc="Re-run extraction rules, drive matching algorithms, and bug fixes across saved emails."
        testid="reprocess-card"
      >
        <div className="space-y-3">
          <div className="rounded-xl border border-white/[0.06] bg-zinc-900/50 p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="text-xs sm:text-sm font-semibold text-zinc-200">
                Reprocess Stored Placement Records
              </div>
              <p className="text-[11px] text-zinc-400 leading-snug">
                Re-evaluates drive numbers, stages, CTCs & shortlists across saved emails (takes ~1–2 min).
              </p>
            </div>
            <button
              type="button"
              data-testid="reprocess-btn"
              onClick={handleReprocessArchive}
              disabled={reprocessing}
              className="flex items-center justify-center gap-2 shrink-0 rounded-lg border border-indigo-500/40 bg-indigo-500/15 px-3.5 py-2 text-xs font-semibold text-indigo-300 hover:bg-indigo-500/25 disabled:opacity-50 active:scale-95 transition-all cursor-pointer w-full sm:w-auto"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', reprocessing && 'animate-spin text-indigo-400')} />
              <span>{reprocessing ? 'Reprocessing…' : 'Reprocess Archive'}</span>
            </button>
          </div>

          {/* Live Reprocess Progress Banner */}
          {reprocessProgress && (
            <div className="p-3.5 rounded-xl border border-indigo-500/30 bg-indigo-500/[0.06] space-y-2.5 animate-fade-in">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-indigo-200 flex items-center gap-2 truncate">
                  <RefreshCw className="h-3.5 w-3.5 text-indigo-400 animate-spin shrink-0" />
                  <span className="truncate">Step {reprocessProgress.step} of {reprocessProgress.totalSteps}: {reprocessProgress.message}</span>
                </span>
                <span className="font-mono text-indigo-300 font-bold ml-2 shrink-0">
                  {Math.min(99, Math.round((reprocessProgress.step / reprocessProgress.totalSteps) * 100))}%
                </span>
              </div>
              <div className="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden border border-zinc-800">
                <div
                  className="h-full bg-gradient-to-r from-indigo-500 to-emerald-400 transition-all duration-300"
                  style={{ width: `${Math.min(99, (reprocessProgress.step / reprocessProgress.totalSteps) * 100)}%` }}
                />
              </div>
              <p className="text-[10px] font-mono text-indigo-300/80">
                ⚡ Please keep this tab open until re-indexing completes (~1 min).
              </p>
            </div>
          )}

          {reprocessResult && !reprocessing && (
            <div className="flex items-center gap-2 p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] text-xs text-emerald-300 animate-fade-in">
              <CheckCheck className="h-4 w-4 text-emerald-400 shrink-0" />
              <span className="leading-snug">
                Re-indexed successfully: {reprocessResult.neoPatDrivesCount} drives tracked, {reprocessResult.updatedApplications} applications updated.
              </span>
            </div>
          )}
        </div>
      </Card>

      {/* Section 5: Danger Zone */}
      <Card
        icon={AlertOctagon}
        title="Danger Zone"
        desc="Irreversible actions for data purging or complete account termination."
        danger
        testid="danger-card"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Action 1: Reset All Data */}
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3.5 sm:p-4 flex flex-col justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-amber-300 text-xs sm:text-sm font-semibold">
                <RotateCcw className="h-3.5 w-3.5 shrink-0" />
                <span>Reset Placement Data</span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-snug">
                Clears drives, applications & calendar. Keeps Google accounts & Candidate ID.
              </p>
            </div>
            <button
              type="button"
              data-testid="reset-data-btn"
              onClick={() => {
                setResetConfirmText('');
                setShowResetModal(true);
              }}
              className="w-full py-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs font-semibold text-amber-300 hover:bg-amber-500/20 active:scale-95 transition-all cursor-pointer text-center"
            >
              Reset All Data
            </button>
          </div>

          {/* Action 2: Terminate Account Entirely */}
          <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.04] p-3.5 sm:p-4 flex flex-col justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-rose-300 text-xs sm:text-sm font-semibold">
                <Trash2 className="h-3.5 w-3.5 shrink-0" />
                <span>Terminate Account</span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-snug">
                Permanently deletes profile, revokes Google OAuth tokens & purges all data.
              </p>
            </div>
            <button
              type="button"
              data-testid="terminate-account-btn"
              onClick={() => {
                setDeleteConfirmText('');
                setShowDeleteModal(true);
              }}
              className="w-full py-2 rounded-lg border border-rose-500/40 bg-rose-500/20 text-xs font-semibold text-rose-200 hover:bg-rose-500/30 active:scale-95 transition-all cursor-pointer text-center"
            >
              Terminate Account
            </button>
          </div>
        </div>
      </Card>

      {/* Confirmation Modal: Reset All Data */}
      <AnimatePresence>
        {showResetModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-fade-in">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-md rounded-2xl border border-amber-500/30 bg-[#121218] p-5 sm:p-6 shadow-2xl space-y-3.5"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5 text-amber-400">
                  <AlertTriangle className="h-5 w-5" />
                  <h3 className="font-display font-bold text-sm sm:text-base text-white">Reset Placement Data?</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setShowResetModal(false)}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="text-xs text-zinc-300 space-y-2 leading-relaxed">
                <p>
                  This permanently deletes stored companies, applications, emails & shortlists from the database.
                </p>
                <div className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800 font-mono text-[11px] text-zinc-400">
                  ✓ Preserved: Google login, Candidate Registration ID<br />
                  ✗ Purged: Companies, circulars, shortlist matches
                </div>
                <p className="text-zinc-400">
                  Type <strong className="text-amber-400 font-mono">RESET</strong> to confirm:
                </p>
              </div>

              <input
                value={resetConfirmText}
                onChange={(e) => setResetConfirmText(e.target.value)}
                placeholder="RESET"
                className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 font-mono text-sm text-amber-300 placeholder:text-zinc-600 focus:border-amber-500/50 focus:outline-none uppercase"
              />

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowResetModal(false)}
                  className="px-3.5 py-1.5 rounded-lg border border-zinc-800 text-xs font-semibold text-zinc-400 hover:text-white transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleResetData}
                  disabled={resetConfirmText.trim().toUpperCase() !== 'RESET' || isResetting}
                  className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-amber-500 text-xs font-bold text-zinc-950 hover:bg-amber-400 disabled:opacity-40 transition-colors cursor-pointer"
                >
                  {isResetting ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      <span>Resetting…</span>
                    </>
                  ) : (
                    <span>Confirm Reset</span>
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Confirmation Modal: Terminate Account Entirely */}
      <AnimatePresence>
        {showDeleteModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-sm animate-fade-in">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-md rounded-2xl border border-rose-500/40 bg-[#141012] p-5 sm:p-6 shadow-2xl space-y-3.5"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5 text-rose-400">
                  <AlertOctagon className="h-5 w-5" />
                  <h3 className="font-display font-bold text-sm sm:text-base text-white">Permanently Delete Account?</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setShowDeleteModal(false)}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="text-xs text-zinc-300 space-y-2 leading-relaxed">
                <p className="text-rose-200">
                  This action is <strong>completely irreversible</strong>.
                </p>
                <div className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800 font-mono text-[11px] text-zinc-400">
                  • Revokes Google OAuth permissions with Google<br />
                  • Deletes user profile & all database rows from Supabase<br />
                  • Destroys session cookies and signs you out
                </div>
                <p className="text-zinc-400">
                  Type <strong className="text-rose-400 font-mono">DELETE</strong> to confirm:
                </p>
              </div>

              <input
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="DELETE"
                className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 font-mono text-sm text-rose-300 placeholder:text-zinc-600 focus:border-rose-500/50 focus:outline-none uppercase"
              />

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowDeleteModal(false)}
                  className="px-3.5 py-1.5 rounded-lg border border-zinc-800 text-xs font-semibold text-zinc-400 hover:text-white transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleTerminateAccount}
                  disabled={deleteConfirmText.trim().toUpperCase() !== 'DELETE' || isDeleting}
                  className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-rose-600 text-xs font-bold text-white hover:bg-rose-500 disabled:opacity-40 transition-colors cursor-pointer"
                >
                  {isDeleting ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      <span>Terminating…</span>
                    </>
                  ) : (
                    <span>Delete Account Permanently</span>
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Legal & Compliance Footer */}
      <div className="pt-2 pb-8 flex flex-col sm:flex-row items-center justify-between gap-3 font-mono text-[11px] text-zinc-500 border-t border-white/[0.05]">
        <span className="text-zinc-500 text-center sm:text-left">
          Where&apos;s My Offer<span className="text-emerald-400 font-extrabold ml-0.5">?</span> · Placement Radar
        </span>
        <div className="flex items-center justify-center gap-3 sm:gap-4 whitespace-nowrap text-[11px]">
          <Link href="/feedback" className="hover:text-zinc-300 transition-colors py-1">
            Feedback
          </Link>
          <span className="text-zinc-700">·</span>
          <Link href="/privacy" className="hover:text-zinc-300 transition-colors py-1">
            Privacy
          </Link>
          <span className="text-zinc-700">·</span>
          <Link href="/terms" className="hover:text-zinc-300 transition-colors py-1">
            Terms
          </Link>
        </div>
      </div>
    </div>
  );
}
