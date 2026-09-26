'use client';

import { useState, useEffect } from 'react';
import {
  Users,
  Search,
  RefreshCw,
  Mail,
  Shield,
  Loader2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  RotateCcw,
  ExternalLink,
} from 'lucide-react';
import { timeAgo, cn } from '@/lib/utils';
import ReprocessProgressToast, { ReprocessProgressState } from '@/components/admin/reprocess-progress-toast';
import { appToast } from '@/components/ui/toast';

interface UserAccount {
  id: string;
  email: string;
  account_type: 'personal' | 'college';
  is_connected: boolean;
  last_sync_at: string | null;
}

interface UserSyncState {
  is_syncing: boolean;
  is_stuck?: boolean;
  phase: string | null;
  total_messages: number;
  processed_messages: number;
  new_emails: number;
  new_companies: number;
  current_subject: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
  lease_expires_at: string | null;
  account_email: string | null;
  is_initial_sync?: boolean;
  current_page_index?: number;
  total_pages?: number;
}

interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  role: 'user' | 'admin';
  created_at: string;
  accounts: UserAccount[];
  syncState: UserSyncState | null;
  emailCount: number;
  totalExpected?: number;
  canonicalCount?: number;
  shortlistCount?: number;
  rawMatchCount?: number;
  applicationCount?: number;
  totalCanonical?: number;
}

function UserAvatar({
  src,
  name,
  email,
  className,
}: {
  src: string | null;
  name: string | null;
  email: string;
  className?: string;
}) {
  const [imgError, setImgError] = useState(false);

  const initial = (name?.trim() || email.split('@')[0] || '?').charAt(0).toUpperCase();

  if (!src || imgError) {
    return (
      <div
        className={cn(
          'w-8 h-8 rounded-full border border-indigo-500/30 bg-gradient-to-br from-indigo-500/20 to-purple-500/10 text-indigo-300 flex items-center justify-center font-bold text-xs shrink-0 select-none shadow-sm',
          className
        )}
      >
        {initial}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={name || email}
      referrerPolicy="no-referrer"
      onError={() => setImgError(true)}
      className={cn('w-8 h-8 rounded-full border border-zinc-700/80 object-cover shrink-0', className)}
    />
  );
}

export default function UsersClient() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [syncingUsers, setSyncingUsers] = useState<Record<string, boolean>>({});
  const [reprocessingUsers, setReprocessingUsers] = useState<Record<string, boolean>>({});
  const [reprocessingAll, setReprocessingAll] = useState(false);
  const [showConfirmReprocessAll, setShowConfirmReprocessAll] = useState(false);
  const [reprocessProgress, setReprocessProgress] = useState<ReprocessProgressState | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/users');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load users');
      setUsers(data.users || []);
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message || 'Failed to load users' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleForceSync = async (userId: string, force: boolean = false) => {
    setSyncingUsers((prev) => ({ ...prev, [userId]: true }));
    setFeedbackMessage(null);
    try {
      const res = await fetch(`/api/admin/sync/${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');

      if (data.alreadyRunning) {
        const warnText = 'Sync is currently active for this user. If it appears stuck, click "Reset & Sync".';
        appToast.warning('Sync already active', warnText);
        setFeedbackMessage({
          type: 'error',
          text: warnText,
        });
      } else {
        const successText = force
          ? `Sync lock cleared and sync completed: ${data.result?.newEmails ?? 0} new emails, ${data.result?.newCompanies ?? 0} new companies.`
          : `Sync completed: ${data.result?.newEmails ?? 0} new emails, ${data.result?.newCompanies ?? 0} new companies.`;
        appToast.sync('User sync completed', successText);
        setFeedbackMessage({
          type: 'success',
          text: successText,
        });
      }
      fetchUsers();
    } catch (err: any) {
      appToast.error('Sync failed', err.message || 'Sync failed');
      setFeedbackMessage({ type: 'error', text: err.message || 'Sync failed' });
    } finally {
      setSyncingUsers((prev) => ({ ...prev, [userId]: false }));
    }
  };

  const handleReprocessUser = async (userId: string) => {
    const targetUser = users.find((u) => u.id === userId);
    const userName = targetUser?.name || targetUser?.email.split('@')[0] || 'Student';
    setReprocessingUsers((prev) => ({ ...prev, [userId]: true }));
    setFeedbackMessage(null);
    setReprocessProgress({
      isActive: true,
      mode: 'user',
      currentUser: userName,
      step: 1,
      totalSteps: 5,
      stageMessage: 'Cleaning recipient matches & fetching stored circulars…',
      totalApplicationsUpdated: 0,
      recentLogs: [],
    });

    try {
      const res = await fetch(`/api/admin/reprocess/${userId}?stream=true`, {
        method: 'POST',
        headers: { Accept: 'text/event-stream' },
      });

      if (!res.ok) throw new Error('Reprocess failed');

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
              if (event === 'stage') {
                setReprocessProgress((prev) =>
                  prev
                    ? {
                        ...prev,
                        step: data.step,
                        totalSteps: data.totalSteps,
                        stageMessage: data.message,
                      }
                    : null
                );
              } else if (event === 'complete') {
                const appsUpdated = data.updatedApplications ?? data.fixed ?? 0;
                setReprocessProgress((prev) =>
                  prev
                    ? {
                        ...prev,
                        completed: true,
                        isActive: false,
                        stageMessage: `Reprocess complete! ${appsUpdated} application stage(s) re-evaluated.`,
                        totalApplicationsUpdated: appsUpdated,
                      }
                    : null
                );
                const successText = `Reprocess completed for ${userName}: ${appsUpdated} applications updated across ${data.neoPatDrivesCount ?? 0} drives.`;
                appToast.success('Reprocess completed', successText, undefined, 5000);
                setFeedbackMessage({
                  type: 'success',
                  text: successText,
                });
              } else if (event === 'error') {
                throw new Error(data.message || 'Reprocess failed');
              }
            } catch {
              // Ignore parse error
            }
          }
        }
      }
      fetchUsers();
    } catch (err: any) {
      appToast.error('Reprocess failed', err.message || 'Reprocess failed', undefined, 6000);
      setFeedbackMessage({ type: 'error', text: err.message || 'Reprocess failed' });
      setReprocessProgress(null);
    } finally {
      setReprocessingUsers((prev) => ({ ...prev, [userId]: false }));
    }
  };

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

                const successText = `Global reprocess complete: ${totalStudents} students evaluated, ${totalApps} application stage(s) re-evaluated.`;
                appToast.success('Global reprocess complete', successText, undefined, 5000);
                setFeedbackMessage({
                  type: 'success',
                  text: successText,
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
      fetchUsers();
    } catch (err: any) {
      appToast.error('Global reprocess failed', err.message || 'Reprocess all failed', undefined, 6000);
      setFeedbackMessage({ type: 'error', text: err.message || 'Reprocess all failed' });
      setReprocessProgress(null);
    } finally {
      setReprocessingAll(false);
    }
  };

  const filteredUsers = users.filter((u) => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    const nameMatch = u.name?.toLowerCase().includes(q);
    const emailMatch = u.email.toLowerCase().includes(q);
    const accountMatch = u.accounts.some((a) => a.email.toLowerCase().includes(q));
    return nameMatch || emailMatch || accountMatch;
  });

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-16">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-zinc-800/80 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <Users className="w-3.5 h-3.5" />
              Student Directory
            </span>
            <span className="text-xs text-zinc-500 font-mono">Multi-Tenant Isolation</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mt-2">
            Registered Student Accounts
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Multi-tenant student accounts, OAuth connectivity status, inbox volume, and manual sync triggers.
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

          <button
            onClick={fetchUsers}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-semibold text-zinc-200 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg border border-zinc-700/60 transition-colors cursor-pointer"
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

      {/* Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search by student name, personal email, or college ID…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 text-xs bg-zinc-900/80 border border-zinc-800 rounded-xl text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50 shadow-inner"
          />
        </div>
        <div className="text-xs text-zinc-400 font-mono self-center">
          Showing <span className="text-indigo-400 font-bold">{filteredUsers.length}</span> of {users.length} registered students
        </div>
      </div>

      {/* Users View: Desktop Table + Mobile Cards */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl overflow-hidden backdrop-blur-sm shadow-xl">
        {/* Desktop Table View (>= md screens) */}
        <div className="hidden md:block overflow-x-auto">
          <table className="min-w-[960px] w-full text-left text-xs text-zinc-300">
            <thead className="bg-zinc-950/70 border-b border-zinc-800 text-[11px] uppercase tracking-wider text-zinc-400 font-semibold">
              <tr>
                <th className="px-6 py-3.5 w-[230px]">User Profile</th>
                <th className="px-4 py-3.5 w-[75px]">Role</th>
                <th className="px-6 py-3.5 w-[250px]">Connected Inboxes</th>
                <th className="px-6 py-3.5 w-[160px] text-center whitespace-nowrap">Synced Mails</th>
                <th className="px-6 py-3.5 w-[140px] whitespace-nowrap">Sync State</th>
                <th className="px-6 py-3.5 w-[160px] text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 font-sans">
              {filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-zinc-500">
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                        Loading student accounts…
                      </div>
                    ) : (
                      'No student accounts match your search.'
                    )}
                  </td>
                </tr>
              ) : (
                filteredUsers.map((user) => {
                  const personalAccount = user.accounts.find((a) => a.account_type === 'personal');
                  const collegeAccount = user.accounts.find((a) => a.account_type === 'college');
                  const isSyncing = syncingUsers[user.id] || Boolean(user.syncState?.is_syncing);
                  const isReprocessing = reprocessingUsers[user.id];

                  return (
                    <tr key={user.id} className="hover:bg-zinc-800/30 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <UserAvatar
                            src={user.avatar}
                            name={user.name}
                            email={user.email}
                          />
                          <div className="min-w-0">
                            <p className="font-semibold text-white truncate max-w-[170px]">
                              {user.name || 'Unnamed User'}
                            </p>
                            <p className="text-[11px] text-zinc-500 font-mono truncate max-w-[190px]">
                              {user.email}
                            </p>
                          </div>
                        </div>
                      </td>

                      <td className="px-4 py-4 whitespace-nowrap">
                        <span
                          className={cn(
                            'px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase',
                            user.role === 'admin'
                              ? 'bg-amber-500/15 text-amber-300 border border-amber-500/25'
                              : 'bg-zinc-800 text-zinc-400'
                          )}
                        >
                          {user.role}
                        </span>
                      </td>

                      <td className="px-6 py-4">
                        <div className="space-y-1.5 font-mono text-[11px]">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'w-1.5 h-1.5 rounded-full shrink-0',
                                personalAccount?.is_connected ? 'bg-emerald-400' : 'bg-red-400'
                              )}
                            />
                            <span className="text-zinc-300 truncate max-w-[170px]" title={personalAccount?.email}>
                              {personalAccount?.email || 'Not connected'}
                            </span>
                            <span className="text-[9px] uppercase px-1 py-0.2 rounded bg-zinc-800 text-zinc-500 shrink-0">
                              Personal
                            </span>
                          </div>

                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'w-1.5 h-1.5 rounded-full shrink-0',
                                collegeAccount?.is_connected ? 'bg-emerald-400' : 'bg-red-400'
                              )}
                            />
                            <span className="text-zinc-300 truncate max-w-[170px]" title={collegeAccount?.email}>
                              {collegeAccount?.email || 'Not connected'}
                            </span>
                            <span className="text-[9px] uppercase px-1 py-0.2 rounded bg-zinc-800 text-zinc-500 shrink-0">
                              College
                            </span>
                          </div>
                        </div>
                      </td>

                      <td className="px-6 py-4 text-center whitespace-nowrap">
                        <div className="flex flex-col items-center whitespace-nowrap">
                          <div className="font-mono text-sm font-bold text-zinc-100 flex items-baseline justify-center gap-1.5 whitespace-nowrap">
                            <span>{user.emailCount.toLocaleString()}</span>
                            {isSyncing && user.totalExpected && user.totalExpected > user.emailCount ? (
                              <span className="text-zinc-500 font-normal text-xs whitespace-nowrap">
                                / {user.totalExpected.toLocaleString()}
                              </span>
                            ) : null}
                          </div>

                          {isSyncing && user.syncState?.total_pages && user.syncState.total_pages > 1 ? (
                            <span className="text-[10px] text-amber-400 font-mono mt-0.5 whitespace-nowrap">
                              Pg {user.syncState.current_page_index} of {user.syncState.total_pages} ({Math.min(100, Math.round((user.emailCount / (user.syncState.total_pages * 50)) * 100))}%)
                            </span>
                          ) : (
                            <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-zinc-500 font-mono whitespace-nowrap">
                              <span>{user.applicationCount ?? 0} drives</span>
                              <span>•</span>
                              <span
                                className="cursor-help text-emerald-400/90 hover:text-emerald-300 transition-colors"
                                title={`${user.shortlistCount ?? 0} unique shortlisted drives (${user.rawMatchCount ?? user.shortlistCount ?? 0} candidate roster matches found across ${(user.totalCanonical || 1866).toLocaleString()} campus circulars)`}
                              >
                                {user.shortlistCount ?? 0} shortlisted
                              </span>
                            </div>
                          )}
                        </div>
                      </td>

                      <td className="px-6 py-4 whitespace-nowrap">
                        {user.syncState?.is_stuck ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="inline-flex items-center gap-1 text-[11px] text-amber-400 font-semibold bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full w-fit">
                              <AlertTriangle className="w-3 h-3 text-amber-400" />
                              Stuck Lock
                            </span>
                            <span className="text-[10px] text-zinc-500 font-mono">
                              Active {user.syncState.updated_at ? timeAgo(user.syncState.updated_at) : 'recently'}
                            </span>
                          </div>
                        ) : isSyncing ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="inline-flex items-center gap-1.5 text-xs text-amber-400 font-medium">
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span className="capitalize">{user.syncState?.phase?.replace(/_/g, ' ') || 'Syncing…'}</span>
                            </span>
                            {user.syncState && user.syncState.total_messages > 0 ? (
                              <span className="text-[10px] text-zinc-400 font-mono">
                                {user.syncState.processed_messages} / {user.syncState.total_messages} msgs
                              </span>
                            ) : null}
                          </div>
                        ) : user.syncState?.phase === 'error' || user.syncState?.error ? (
                          <div className="flex flex-col gap-0.5 max-w-[180px]" title={user.syncState.error || 'Sync error'}>
                            <span className="inline-flex items-center gap-1 text-[11px] text-rose-400 font-medium bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 rounded-full w-fit">
                              <AlertCircle className="w-3 h-3 text-rose-400" />
                              Sync Error
                            </span>
                            <span className="text-[10px] text-rose-400/80 font-mono truncate">
                              {user.syncState.error || 'Failed'}
                            </span>
                          </div>
                        ) : user.syncState?.completed_at || user.syncState?.updated_at ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[11px] text-zinc-400 font-mono flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                              Synced {timeAgo(user.syncState.completed_at || user.syncState.updated_at!)}
                            </span>
                            {user.syncState.new_emails > 0 ? (
                              <span className="text-[10px] text-emerald-400/80 font-mono">
                                +{user.syncState.new_emails} new
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-[11px] text-zinc-600">Idle</span>
                        )}
                      </td>

                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {user.syncState?.is_stuck ? (
                            <button
                              onClick={() => handleForceSync(user.id, true)}
                              disabled={syncingUsers[user.id]}
                              className="px-2.5 py-1 text-xs font-semibold rounded-lg border border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-1"
                              title="Clear stale lease lock and restart sync"
                            >
                              <RotateCcw className={cn('w-3 h-3', syncingUsers[user.id] && 'animate-spin')} />
                              <span>Reset & Sync</span>
                            </button>
                          ) : (
                            <button
                              onClick={() => handleForceSync(user.id, false)}
                              disabled={isSyncing}
                              className="px-2.5 py-1 text-xs font-semibold rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-1"
                              title="Trigger Gmail sync for this user"
                            >
                              <RefreshCw className={cn('w-3 h-3', isSyncing && 'animate-spin text-amber-400')} />
                              <span>Sync</span>
                            </button>
                          )}

                          {/* Extra Reset button if sync is running or errored */}
                          {(isSyncing || user.syncState?.error) && !user.syncState?.is_stuck && (
                            <button
                              onClick={() => handleForceSync(user.id, true)}
                              disabled={syncingUsers[user.id]}
                              className="px-2 py-1 text-[11px] font-semibold rounded-lg border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-1"
                              title="Force reset lock and sync"
                            >
                              <RotateCcw className={cn('w-2.5 h-2.5', syncingUsers[user.id] && 'animate-spin')} />
                              <span>Reset</span>
                            </button>
                          )}

                          <button
                            onClick={() => handleReprocessUser(user.id)}
                            disabled={isReprocessing}
                            className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-indigo-600/80 hover:bg-indigo-600 text-white disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-1"
                            title="Recalculate application status and matches for this user"
                          >
                            <RefreshCw className={cn('w-3 h-3', isReprocessing && 'animate-spin')} />
                            <span>Reprocess</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile Cards View (< md screens) */}
        <div className="block md:hidden divide-y divide-zinc-800/60 font-sans">
          {filteredUsers.length === 0 ? (
            <div className="px-4 py-12 text-center text-zinc-500 text-xs">
              {loading ? (
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                  Loading student accounts…
                </div>
              ) : (
                'No student accounts match your search.'
              )}
            </div>
          ) : (
            filteredUsers.map((user) => {
              const personalAccount = user.accounts.find((a) => a.account_type === 'personal');
              const collegeAccount = user.accounts.find((a) => a.account_type === 'college');
              const isSyncing = syncingUsers[user.id] || Boolean(user.syncState?.is_syncing);
              const isReprocessing = reprocessingUsers[user.id];

              return (
                <div key={user.id} className="p-4 space-y-3.5 hover:bg-zinc-800/20 transition-colors">
                  {/* Student Header */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <UserAvatar
                        src={user.avatar}
                        name={user.name}
                        email={user.email}
                        className="w-9 h-9"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-white text-sm truncate">
                            {user.name || 'Unnamed User'}
                          </p>
                          <span
                            className={cn(
                              'px-1.5 py-0.2 rounded text-[9px] font-mono font-bold uppercase shrink-0',
                              user.role === 'admin'
                                ? 'bg-amber-500/15 text-amber-300 border border-amber-500/25'
                                : 'bg-zinc-800 text-zinc-400'
                            )}
                          >
                            {user.role}
                          </span>
                        </div>
                        <p className="text-[11px] text-zinc-500 font-mono truncate">
                          {user.email}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Connected Inboxes */}
                  <div className="space-y-1.5 font-mono text-[11px] bg-zinc-950/40 p-2.5 rounded-lg border border-zinc-800/60">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            'w-1.5 h-1.5 rounded-full shrink-0',
                            personalAccount?.is_connected ? 'bg-emerald-400' : 'bg-red-400'
                          )}
                        />
                        <span className="text-zinc-300 truncate text-[11px]">
                          {personalAccount?.email || 'Not connected'}
                        </span>
                      </div>
                      <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 shrink-0">
                        Personal
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            'w-1.5 h-1.5 rounded-full shrink-0',
                            collegeAccount?.is_connected ? 'bg-emerald-400' : 'bg-red-400'
                          )}
                        />
                        <span className="text-zinc-300 truncate text-[11px]">
                          {collegeAccount?.email || 'Not connected'}
                        </span>
                      </div>
                      <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 shrink-0">
                        College
                      </span>
                    </div>
                  </div>

                  {/* 2-Column Stats Card */}
                  <div className="grid grid-cols-2 gap-2 p-2.5 rounded-lg bg-zinc-950/60 border border-zinc-800/80">
                    {/* Synced Mails */}
                    <div className="flex flex-col">
                      <span className="text-[10px] text-zinc-500 uppercase font-semibold tracking-wider">Synced Mails</span>
                      <div className="font-mono text-sm font-bold text-zinc-100 flex items-baseline gap-1 mt-0.5 whitespace-nowrap">
                        <span>{user.emailCount.toLocaleString()}</span>
                        {isSyncing && user.totalExpected && user.totalExpected > user.emailCount ? (
                          <span className="text-zinc-500 font-normal text-xs">
                            / {user.totalExpected.toLocaleString()}
                          </span>
                        ) : null}
                      </div>
                      {isSyncing && user.syncState?.total_pages && user.syncState.total_pages > 1 ? (
                        <span className="text-[10px] text-amber-400 font-mono mt-0.5 truncate">
                          Pg {user.syncState.current_page_index}/{user.syncState.total_pages} ({Math.min(100, Math.round((user.emailCount / (user.syncState.total_pages * 50)) * 100))}%)
                        </span>
                      ) : (
                        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-zinc-500 font-mono truncate">
                          <span>{user.applicationCount ?? 0} drives</span>
                          <span>•</span>
                          <span
                            className="cursor-help text-emerald-400/90 hover:text-emerald-300 transition-colors"
                            title={`${user.shortlistCount ?? 0} unique shortlisted drives (${user.rawMatchCount ?? user.shortlistCount ?? 0} candidate roster matches found across ${(user.totalCanonical || 1866).toLocaleString()} campus circulars)`}
                          >
                            {user.shortlistCount ?? 0} shortlisted
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Sync State */}
                    <div className="flex flex-col justify-start">
                      <span className="text-[10px] text-zinc-500 uppercase font-semibold tracking-wider">Sync State</span>
                      <div className="mt-0.5">
                        {user.syncState?.is_stuck ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="inline-flex items-center gap-1 text-[11px] text-amber-400 font-semibold bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full w-fit">
                              <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                              Stuck Lock
                            </span>
                            <span className="text-[10px] text-zinc-500 font-mono">
                              {user.syncState.updated_at ? timeAgo(user.syncState.updated_at) : 'recently'}
                            </span>
                          </div>
                        ) : isSyncing ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="inline-flex items-center gap-1.5 text-xs text-amber-400 font-medium">
                              <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                              <span className="capitalize">{user.syncState?.phase?.replace(/_/g, ' ') || 'Syncing…'}</span>
                            </span>
                            {user.syncState && user.syncState.total_messages > 0 ? (
                              <span className="text-[10px] text-zinc-400 font-mono">
                                {user.syncState.processed_messages}/{user.syncState.total_messages} msgs
                              </span>
                            ) : null}
                          </div>
                        ) : user.syncState?.phase === 'error' || user.syncState?.error ? (
                          <div className="flex flex-col gap-0.5" title={user.syncState.error || 'Sync error'}>
                            <span className="inline-flex items-center gap-1 text-[11px] text-rose-400 font-medium bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 rounded-full w-fit">
                              <AlertCircle className="w-3 h-3 text-rose-400 shrink-0" />
                              Sync Error
                            </span>
                          </div>
                        ) : user.syncState?.completed_at || user.syncState?.updated_at ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[11px] text-zinc-300 font-mono flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                              {timeAgo(user.syncState.completed_at || user.syncState.updated_at!)}
                            </span>
                            {user.syncState.new_emails > 0 ? (
                              <span className="text-[10px] text-emerald-400 font-mono">
                                +{user.syncState.new_emails} new
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-[11px] text-zinc-600">Idle</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Actions Row */}
                  <div className="flex items-center gap-2 pt-1">
                    {user.syncState?.is_stuck ? (
                      <button
                        onClick={() => handleForceSync(user.id, true)}
                        disabled={syncingUsers[user.id]}
                        className="flex-1 py-2 text-xs font-semibold rounded-lg border border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 disabled:opacity-50 transition-colors cursor-pointer flex items-center justify-center gap-1.5"
                      >
                        <RotateCcw className={cn('w-3.5 h-3.5', syncingUsers[user.id] && 'animate-spin')} />
                        <span>Reset & Sync</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => handleForceSync(user.id, false)}
                        disabled={isSyncing}
                        className="flex-1 py-2 text-xs font-semibold rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-50 transition-colors cursor-pointer flex items-center justify-center gap-1.5"
                      >
                        <RefreshCw className={cn('w-3.5 h-3.5', isSyncing && 'animate-spin text-amber-400')} />
                        <span>Sync</span>
                      </button>
                    )}

                    {(isSyncing || user.syncState?.error) && !user.syncState?.is_stuck && (
                      <button
                        onClick={() => handleForceSync(user.id, true)}
                        disabled={syncingUsers[user.id]}
                        className="px-3 py-2 text-xs font-semibold rounded-lg border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-1"
                        title="Force reset lock"
                      >
                        <RotateCcw className={cn('w-3 h-3', syncingUsers[user.id] && 'animate-spin')} />
                        <span>Reset</span>
                      </button>
                    )}

                    <button
                      onClick={() => handleReprocessUser(user.id)}
                      disabled={isReprocessing}
                      className="flex-1 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition-colors cursor-pointer flex items-center justify-center gap-1.5 shadow-sm"
                    >
                      <RefreshCw className={cn('w-3.5 h-3.5', isReprocessing && 'animate-spin')} />
                      <span>Reprocess</span>
                    </button>
                  </div>
                </div>
              );
            })
          )}
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
