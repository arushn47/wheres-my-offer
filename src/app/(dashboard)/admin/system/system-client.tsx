'use client';

import { useState, useEffect } from 'react';
import {
  Layers,
  RefreshCw,
  Clock,
  ExternalLink,
  Shield,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Database,
  Cpu,
  Activity,
  HardDrive,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { appToast } from '@/components/ui/toast';

interface CanonicalStats {
  totalCanonical: number;
  completeCanonical: number;
  totalLinkedReceipts: number;
  unlinkedCollegeReceipts: number;
  totalCanonicalAttachments: number;
}

export default function SystemClient() {
  const [stats, setStats] = useState<CanonicalStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [backfilling, setBackfilling] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchStats = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/canonical/stats');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load system stats');
      setStats(data.stats || null);
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message || 'Failed to load system stats' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  const handleRunBackfill = async () => {
    setBackfilling(true);
    setFeedbackMessage(null);
    const toastId = 'backfill-canonical';
    appToast.loading('Running canonical backfill…', 'Linking existing receipts to canonical emails…', undefined, Infinity, toastId);
    try {
      const res = await fetch('/api/admin/canonical/backfill', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Backfill failed');
      const successText = data.message || 'Canonical backfill completed.';
      appToast.success('Canonical backfill completed', successText, undefined, 5000, toastId);
      setFeedbackMessage({
        type: 'success',
        text: successText,
      });
      fetchStats();
    } catch (err: any) {
      appToast.error('Backfill failed', err.message || 'Backfill failed', undefined, 7000, toastId);
      setFeedbackMessage({ type: 'error', text: err.message || 'Backfill failed' });
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-16">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-zinc-800/80 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Layers className="w-3.5 h-3.5" />
              Storage Engine
            </span>
            <span className="text-xs text-zinc-500 font-mono">Deduplication Telemetry</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mt-2">
            System & Deduplication Engine
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Broadcast email deduplication, body snippet compression, and cron safety net telemetry.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleRunBackfill}
            disabled={backfilling}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg shadow-sm transition-colors cursor-pointer flex-1 sm:flex-initial"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', backfilling && 'animate-spin')} />
            <span>{backfilling ? 'Backfilling…' : 'Canonical Backfill'}</span>
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
            onClick={fetchStats}
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

      {/* Storage & Deduplication Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-5 backdrop-blur-sm shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Total Canonical Broadcasts</span>
            <Layers className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-white mt-3">
            {stats?.totalCanonical ?? (loading ? '—' : 0)}
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            {stats?.completeCanonical ?? 0} ready for instant cache reuse
          </p>
        </div>

        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-5 backdrop-blur-sm shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Linked Student Receipts</span>
            <Database className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="text-2xl font-bold text-cyan-300 mt-3">
            {stats?.totalLinkedReceipts ?? (loading ? '—' : 0)}
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            Receipts sharing broadcast bodies (500 char snippets)
          </p>
        </div>

        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-5 backdrop-blur-sm shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Unlinked Circulars Remaining</span>
            <HardDrive className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold text-amber-300 mt-3">
            {stats?.unlinkedCollegeReceipts ?? (loading ? '—' : 0)}
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            College emails ready for backfill linkage
          </p>
        </div>
      </div>

      {/* Technical Architecture Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-6 backdrop-blur-sm shadow-xl space-y-4">
          <div className="flex items-center gap-2 text-white font-semibold text-sm">
            <Cpu className="w-4 h-4 text-emerald-400" />
            Storage Quota Remediation
          </div>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Broadcast emails sent from <span className="font-mono text-zinc-300">vitlions2027@vitbhopal.ac.in</span> contain identical bodies, schedules, and job criteria across students. Rather than storing full HTML bodies inside the <span className="font-mono text-zinc-300">personal_emails</span> table for every individual student, the body is stored once in <span className="font-mono text-zinc-300">college_emails</span>.
          </p>
          <div className="p-3.5 rounded-lg bg-zinc-950/70 border border-zinc-800 space-y-2 text-xs">
            <div className="flex items-center justify-between text-zinc-400">
              <span>Per-User Email Snippet Size</span>
              <span className="font-mono font-bold text-emerald-400">Truncated to 500 chars</span>
            </div>
            <div className="flex items-center justify-between text-zinc-400">
              <span>Canonical Identity Hash</span>
              <span className="font-mono font-bold text-cyan-300">SHA-256 (Version 2)</span>
            </div>
            <div className="flex items-center justify-between text-zinc-400">
              <span>Excel Shortlist Attachments</span>
              <span className="font-mono font-bold text-amber-300">{stats?.totalCanonicalAttachments ?? 0} indexed in college_attachments</span>
            </div>
          </div>
        </div>

        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-6 backdrop-blur-sm shadow-xl space-y-4">
          <div className="flex items-center gap-2 text-white font-semibold text-sm">
            <Activity className="w-4 h-4 text-purple-400" />
            Background Synchronization Pipeline
          </div>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Multi-tier architecture combining real-time Google Cloud Pub/Sub push webhooks with a daily midnight safety net.
          </p>
          <div className="space-y-2.5 text-xs">
            <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="font-medium text-white">Google Cloud Pub/Sub</span>
              </div>
              <span className="font-mono text-[11px] text-emerald-400 font-semibold">Active Webhook Push</span>
            </div>

            <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-purple-400" />
                <span className="font-medium text-white">cron-job.org Safety Net</span>
              </div>
              <span className="font-mono text-[11px] text-purple-300">Daily @ 00:00 IST</span>
            </div>

            <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Shield className="w-3.5 h-3.5 text-amber-400" />
                <span className="font-medium text-white">Concurrency Guard</span>
              </div>
              <span className="font-mono text-[11px] text-amber-300 font-semibold">Per-User DB Lock</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
