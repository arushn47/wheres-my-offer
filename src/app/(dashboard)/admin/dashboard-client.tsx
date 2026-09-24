'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Building2,
  Users,
  Layers,
  Activity,
  RefreshCw,
  Clock,
  ExternalLink,
  Shield,
  ArrowRight,
  Filter,
  CheckCircle2,
  AlertCircle,
  Mail,
  Loader2,
} from 'lucide-react';
import { timeAgo, cn } from '@/lib/utils';
import ReprocessProgressToast, { ReprocessProgressState } from '@/components/admin/reprocess-progress-toast';

interface AdminDrive {
  driveKey: string;
  driveNumber: string | null;
  companyName: string;
  role: string | null;
  category: string | null;
  ctc: string | null;
  stipend: string | null;
  location: string | null;
  totalEmails: number;
  totalApplications: number;
  totalUsers: number;
  latestEmailAt: string | null;
}

interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  role: 'user' | 'admin';
  accounts: { account_type: string; is_connected: boolean; email: string }[];
  emailCount: number;
  syncState: { is_syncing: boolean; updated_at: string } | null;
}

interface CanonicalStats {
  totalCanonical: number;
  completeCanonical: number;
  totalLinkedReceipts: number;
  unlinkedCollegeReceipts: number;
}

export default function DashboardClient() {
  const [drives, setDrives] = useState<AdminDrive[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [stats, setStats] = useState<CanonicalStats | null>(null);
  const [aliasCount, setAliasCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reprocessingAll, setReprocessingAll] = useState(false);
  const [showConfirmReprocessAll, setShowConfirmReprocessAll] = useState(false);
  const [reprocessProgress, setReprocessProgress] = useState<ReprocessProgressState | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      const [drivesRes, usersRes, statsRes, aliasesRes] = await Promise.all([
        fetch('/api/admin/drives'),
        fetch('/api/admin/users'),
        fetch('/api/admin/canonical/stats'),
        fetch('/api/admin/aliases'),
      ]);

      if (drivesRes.ok) {
        const data = await drivesRes.json();
        setDrives(data.drives || []);
      }
      if (usersRes.ok) {
        const data = await usersRes.json();
        setUsers(data.users || []);
      }
      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data.stats || null);
      }
      if (aliasesRes.ok) {
        const data = await aliasesRes.json();
        setAliasCount(data.aliases?.length || 0);
      }
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message || 'Failed to load dashboard data' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const handleReprocessAll = async () => {
    setShowConfirmReprocessAll(false);
    setReprocessingAll(true);
    setFeedbackMessage(null);
    setReprocessProgress({
      isActive: true,
      mode: 'all',
      currentUser: 'Initializing…',
      currentUserIndex: 1,
      totalUsers: users.length,
      step: 1,
      totalSteps: 5,
      stageMessage: 'Starting global placement reprocess across students…',
      totalApplicationsUpdated: 0,
      recentLogs: [],
    });

    try {
      const res = await fetch('/api/admin/reprocess/all?stream=true', {
        method: 'POST',
        headers: { Accept: 'text/event-stream' },
      });

      if (!res.ok) throw new Error('Reprocess all failed');

      const reader = res.body?.getReader();
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
              const data = JSON.parse(dataStr);
              if (event === 'start') {
                setReprocessProgress((prev) =>
                  prev
                    ? {
                        ...prev,
                        totalUsers: data.totalUsers,
                        stageMessage: data.message,
                      }
                    : null
                );
              } else if (event === 'user_start') {
                setReprocessProgress((prev) =>
                  prev
                    ? {
                        ...prev,
                        currentUser: data.userName,
                        currentUserIndex: data.userIndex,
                        totalUsers: data.totalUsers,
                        step: 1,
                        stageMessage: `Analyzing circulars for ${data.userName}…`,
                      }
                    : null
                );
              } else if (event === 'stage') {
                setReprocessProgress((prev) =>
                  prev
                    ? {
                        ...prev,
                        currentUser: data.userName,
                        currentUserIndex: data.userIndex,
                        totalUsers: data.totalUsers,
                        step: data.step,
                        totalSteps: data.totalSteps,
                        stageMessage: data.message,
                      }
                    : null
                );
              } else if (event === 'user_complete') {
                setReprocessProgress((prev) =>
                  prev
                    ? {
                        ...prev,
                        totalApplicationsUpdated:
                          (prev.totalApplicationsUpdated || 0) + (data.updatedApplications || 0),
                        recentLogs: [
                          ...(prev.recentLogs || []),
                          `${data.userName}: ${data.updatedApplications} applications updated`,
                        ],
                      }
                    : null
                );
              } else if (event === 'complete') {
                const totalStudents = data.totalUsersProcessed || data.usersProcessed || 0;
                const totalApps = data.totalApplicationsUpdated || data.applicationsUpdated || 0;

                setReprocessProgress((prev) =>
                  prev
                    ? {
                        ...prev,
                        completed: true,
                        isActive: false,
                        stageMessage: `Global reprocess complete! ${totalStudents} students evaluated, ${totalApps} applications updated.`,
                        totalApplicationsUpdated: totalApps,
                      }
                    : null
                );

                setFeedbackMessage({
                  type: 'success',
                  text: `Global reprocess complete: ${totalStudents} students evaluated, ${totalApps} application stage(s) re-evaluated.`,
                });
              } else if (event === 'error') {
                throw new Error(data.message || 'Global reprocess failed');
              }
            } catch {
              // Ignore parse error
            }
          }
        }
      }
      fetchDashboardData();
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message || 'Reprocess all failed' });
      setReprocessProgress(null);
    } finally {
      setReprocessingAll(false);
    }
  };

  return (
    <div className="space-y-8 max-w-7xl mx-auto pb-16">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-zinc-800/80 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/20">
              <Shield className="w-3.5 h-3.5" />
              RBAC Protected
            </span>
            <span className="text-xs text-zinc-500 font-mono">Server-Enforced</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mt-2">
            Admin Dashboard
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            System-wide placement telemetry, active recruitment campaigns, and multi-tenant health.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setShowConfirmReprocessAll(true)}
            disabled={reprocessingAll}
            className="inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg shadow-sm transition-colors cursor-pointer flex-1 sm:flex-initial"
            title="Re-evaluate placement stages and circulars for all registered students"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', reprocessingAll && 'animate-spin')} />
            <span>{reprocessingAll ? 'Reprocessing…' : 'Reprocess All Users'}</span>
          </button>

          <a
            href="https://console.cron-job.org/jobs/8265126"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-lg transition-colors flex-1 sm:flex-initial"
          >
            <Clock className="w-3.5 h-3.5 text-emerald-400" />
            cron-job.org
            <ExternalLink className="w-3 h-3 text-zinc-500" />
          </a>

          <button
            onClick={fetchDashboardData}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-zinc-200 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg border border-zinc-700/60 transition-colors cursor-pointer"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      {/* Feedback Toast */}
      {feedbackMessage && (
        <div
          className={cn(
            'p-4 rounded-xl text-sm border flex items-center justify-between gap-3 animate-fade-in',
            feedbackMessage.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
              : 'bg-red-500/10 border-red-500/20 text-red-400'
          )}
        >
          <div className="flex items-center gap-3">
            {feedbackMessage.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 shrink-0" />
            ) : (
              <AlertCircle className="w-5 h-5 shrink-0" />
            )}
            <span>{feedbackMessage.text}</span>
          </div>
          <button
            onClick={() => setFeedbackMessage(null)}
            className="text-xs opacity-70 hover:opacity-100 font-mono"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 4 Core KPI Cards with Direct Links */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Placement Drives Card */}
        <Link
          href="/admin/drives"
          className="bg-zinc-900/60 hover:bg-zinc-800/40 border border-zinc-800/80 hover:border-amber-500/40 rounded-xl p-5 backdrop-blur-sm shadow-sm transition-all group cursor-pointer block"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Placement Drives</span>
            <Building2 className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold text-white mt-3 flex items-baseline justify-between">
            <span>{loading ? '—' : drives.length}</span>
            <span className="text-xs text-amber-400 font-medium group-hover:translate-x-0.5 transition-transform flex items-center gap-1">
              Manage <ArrowRight className="w-3 h-3" />
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-1">Aggregated recruitment campaigns</p>
        </Link>

        {/* Total Users Card */}
        <Link
          href="/admin/users"
          className="bg-zinc-900/60 hover:bg-zinc-800/40 border border-zinc-800/80 hover:border-indigo-500/40 rounded-xl p-5 backdrop-blur-sm shadow-sm transition-all group cursor-pointer block"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Total Users</span>
            <Users className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="text-2xl font-bold text-white mt-3 flex items-baseline justify-between">
            <span>{loading ? '—' : users.length}</span>
            <span className="text-xs text-indigo-400 font-medium group-hover:translate-x-0.5 transition-transform flex items-center gap-1">
              Directory <ArrowRight className="w-3 h-3" />
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-1">Multi-tenant student accounts</p>
        </Link>

        {/* Canonical Broadcasts Card */}
        <Link
          href="/admin/system"
          className="bg-zinc-900/60 hover:bg-zinc-800/40 border border-zinc-800/80 hover:border-emerald-500/40 rounded-xl p-5 backdrop-blur-sm shadow-sm transition-all group cursor-pointer block"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Canonical Broadcasts</span>
            <Layers className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-white mt-3 flex items-baseline justify-between">
            <span>{stats?.totalCanonical ?? (loading ? '—' : 0)}</span>
            <span className="text-xs text-emerald-400 font-medium group-hover:translate-x-0.5 transition-transform flex items-center gap-1">
              Storage <ArrowRight className="w-3 h-3" />
            </span>
          </div>
          <p className="text-xs text-zinc-500 mt-1">{stats?.totalLinkedReceipts ?? 0} linked student receipts</p>
        </Link>

        {/* Daily Safety Net Card */}
        <a
          href="https://console.cron-job.org/jobs/8265126"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-zinc-900/60 hover:bg-zinc-800/40 border border-zinc-800/80 hover:border-purple-500/40 rounded-xl p-5 backdrop-blur-sm shadow-sm transition-all group cursor-pointer block"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Daily Safety Net</span>
            <Activity className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-2xl font-bold text-emerald-400 mt-3 flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
            Daily (00:00)
          </div>
          <p className="text-xs text-zinc-500 mt-1">Watch renewal & safety net via cron-job.org</p>
        </a>
      </div>

      {/* Grid of Sections */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Recent Placement Drives (2 cols) */}
        <div className="lg:col-span-2 bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-6 backdrop-blur-sm shadow-xl space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-800/80 pb-4">
            <div className="flex items-center gap-2.5">
              <Building2 className="w-4 h-4 text-amber-400" />
              <h2 className="text-base font-semibold text-white">Active Placement Drives</h2>
            </div>
            <Link
              href="/admin/drives"
              className="text-xs font-semibold text-amber-400 hover:text-amber-300 flex items-center gap-1"
            >
              View All {drives.length} Drives <ArrowRight className="w-3 h-3" />
            </Link>
          </div>

          <div className="divide-y divide-zinc-800/60">
            {drives.slice(0, 5).map((drive) => (
              <div key={drive.driveKey} className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-start justify-between sm:justify-start sm:items-center gap-2 flex-wrap">
                    <h3 className="font-bold text-white text-base leading-snug break-words">
                      {drive.companyName}
                    </h3>
                    {drive.category && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 font-medium shrink-0 border border-zinc-700/60">
                        {drive.category}
                      </span>
                    )}
                  </div>
                  
                  <div className="flex items-center gap-x-2 gap-y-1.5 text-xs text-zinc-400 flex-wrap">
                    {drive.driveNumber && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/15 text-amber-300 border border-amber-500/25 shrink-0">
                        Drive {drive.driveNumber}
                      </span>
                    )}
                    {drive.role && <span className="text-zinc-300 font-medium">{drive.role}</span>}
                    {drive.ctc && (
                      <span className="text-emerald-400 font-mono font-semibold bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded text-[11px] shrink-0">
                        {drive.ctc}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-x-3 gap-y-1 text-xs text-zinc-400 flex-wrap pt-0.5">
                    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-zinc-400 bg-zinc-800/60 px-1.5 py-0.5 rounded">
                      <Users className="w-3 h-3 text-indigo-400" />
                      {drive.totalUsers} student{drive.totalUsers === 1 ? '' : 's'}
                    </span>
                    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-zinc-400 bg-zinc-800/60 px-1.5 py-0.5 rounded">
                      <Mail className="w-3 h-3 text-cyan-400" />
                      {drive.totalEmails} email{drive.totalEmails === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>

                <Link
                  href="/admin/drives"
                  className="px-3.5 py-1.5 text-xs font-semibold text-zinc-200 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-lg border border-zinc-700/60 transition-colors shrink-0 text-center self-stretch sm:self-center"
                >
                  Inspect
                </Link>
              </div>
            ))}
          </div>
        </div>

        {/* Right Column: Quick Links & Engine Health (1 col) */}
        <div className="space-y-6">
          {/* Resolution Rules Quick Card */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-5 backdrop-blur-sm shadow-xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                <Filter className="w-3.5 h-3.5 text-cyan-400" />
                Resolution Rules
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-cyan-500/10 text-cyan-300 border border-cyan-500/25">
                {aliasCount} Rules Active
              </span>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Enforce canonical naming and override ambiguous email sender keywords.
            </p>
            <Link
              href="/admin/aliases"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-cyan-400 hover:text-cyan-300 pt-1"
            >
              Configure Rules & Aliases <ArrowRight className="w-3 h-3" />
            </Link>
          </div>

          {/* Deduplication Quick Card */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-5 backdrop-blur-sm shadow-xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                <Layers className="w-3.5 h-3.5 text-emerald-400" />
                Deduplication Engine
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/10 text-emerald-300 border border-emerald-500/25">
                Active
              </span>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Shared college circular bodies reducing per-student database storage by up to 90%.
            </p>
            <Link
              href="/admin/system"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300 pt-1"
            >
              Inspect Storage & Backfill <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        </div>
      </div>

      {/* Confirmation Dialog for Reprocess All */}
      {showConfirmReprocessAll && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4 animate-fade-in">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
                <RefreshCw className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-white">Reprocess All Student Accounts?</h3>
                <p className="text-xs text-zinc-400 mt-0.5">Global Placement State Re-Evaluation</p>
              </div>
            </div>

            <p className="text-xs text-zinc-300 leading-relaxed">
              This will re-evaluate all circular assignments, CTC offers, and application stages across all {users.length} registered students in the system.
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setShowConfirmReprocessAll(false)}
                className="px-4 py-2 text-xs font-semibold text-zinc-400 hover:text-white transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleReprocessAll}
                className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg shadow-sm transition-colors cursor-pointer"
              >
                Proceed with Full Reprocess
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Real-Time Live Reprocess Progress Toast */}
      <ReprocessProgressToast
        state={reprocessProgress}
        onDismiss={() => setReprocessProgress(null)}
      />
    </div>
  );
}
