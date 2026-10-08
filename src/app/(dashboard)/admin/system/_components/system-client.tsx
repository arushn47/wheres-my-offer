'use client';

import { useState, useEffect } from 'react';
import {
  Layers,
  RefreshCw,
  Clock,
  ExternalLink,
  Shield,
  CheckCircle2,
  AlertCircle,
  Database,
  Cpu,
  Activity,
  HardDrive,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SharedArchiveRefreshResult } from '@/lib/sync/canonical/shared-archive-refresh';

interface CanonicalStats {
  totalCanonical: number;
  completeCanonical: number;
  totalLinkedReceipts: number;
  unlinkedCollegeReceipts: number;
  totalCanonicalAttachments: number;
}

interface CanonicalAudit {
  dryRun: true;
  generatedAt: string;
  archive: {
    total: number;
    bodyTextMissing: number;
    bodyTextShort: number;
    messageIdMissing: number;
    outdatedIdentityVersion: number;
    outdatedParserVersion: number;
    classificationMissing: number;
    parsedCompanyMissing: number;
    parsedJobDetailsMissing: number;
    parsedEventsMissing: number;
    receivedAtMissing: number;
    processingStatusCounts: Record<string, number>;
    attachmentCount: number;
    attachmentStatusCounts: Record<string, number>;
    attachmentsMissingExtractedRows: number;
    attachmentsMissingContentHash: number;
    staleSamples: Array<{ id: string; subject: string; reasons: string[] }>;
  };
  onboarding: {
    connectedCollegeInboxCount: number;
    connectedCollegeInboxEmails: string[];
  };
  userTracking: {
    applicationCount: number;
    unsupportedNonManualApplicationCount: number;
    unsupportedSamples: Array<{
      userEmail: string | null;
      company: string | null;
      driveNumber: string | null;
      status: string;
      statusSource: string | null;
    }>;
  };
}

export default function SystemClient() {
  const [stats, setStats] = useState<CanonicalStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [auditing, setAuditing] = useState(false);
  const [audit, setAudit] = useState<CanonicalAudit | null>(null);
  const [refreshPreview, setRefreshPreview] = useState<SharedArchiveRefreshResult | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchStats = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const res = await fetch('/api/admin/canonical/stats');
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Failed to load system stats');
      setStats(data.stats || null);
    } catch (error) {
      setFeedbackMessage({ type: 'error', text: error instanceof Error ? error.message : 'Failed to load system stats' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetch('/api/admin/canonical/stats', { cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Failed to load system stats');
        setStats(data.stats || null);
      })
      .catch((error: unknown) => {
        setFeedbackMessage({ type: 'error', text: error instanceof Error ? error.message : 'Failed to load system stats' });
      })
      .finally(() => setLoading(false));
  }, []);

  const handleRunArchiveAudit = async () => {
    setAuditing(true);
    setFeedbackMessage(null);
    try {
      const res = await fetch('/api/admin/canonical/audit', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Archive audit failed');
      setAudit(data as CanonicalAudit);
      setFeedbackMessage({
        type: 'success',
        text: `Read-only audit complete: ${data.archive.total} shared circulars, ${data.archive.bodyTextMissing} missing bodies, ${data.archive.attachmentsMissingExtractedRows} attachments without extracted rows, and ${data.userTracking.unsupportedNonManualApplicationCount} unsupported applications to review. No data was changed.`,
      });
    } catch (err) {
      setFeedbackMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Archive audit failed',
      });
    } finally {
      setAuditing(false);
    }
  };

  const handleRefreshPreview = async (pageCursor?: string) => {
    setAuditing(true);
    setFeedbackMessage(null);
    try {
      const res = await fetch('/api/admin/canonical/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true, limit: 100, pageCursor }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Archive refresh preview failed');
      setRefreshPreview(data.result as SharedArchiveRefreshResult);
      setFeedbackMessage({
        type: 'success',
        text: `Read-only refresh preview: ${data.result.scanned} message IDs scanned from ${data.result.sourceInbox || 'no available College inbox'}, ${data.result.reused} existing broadcasts reusable, ${data.result.wouldCreate} would create, ${data.result.attachmentsParsed} workbook attachments parseable. No database rows were changed.`,
      });
    } catch (error) {
      setFeedbackMessage({ type: 'error', text: error instanceof Error ? error.message : 'Archive refresh preview failed' });
    } finally {
      setAuditing(false);
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
            onClick={handleRunArchiveAudit}
            disabled={auditing}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-zinc-100 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg border border-zinc-700 transition-colors cursor-pointer flex-1 sm:flex-initial"
          >
            <Activity className={cn('w-3.5 h-3.5', auditing && 'animate-pulse')} />
            <span>{auditing ? 'Auditing…' : 'Read-only Archive Audit'}</span>
          </button>

          <button
            onClick={() => void handleRefreshPreview()}
            disabled={auditing}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-zinc-100 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg border border-zinc-700 transition-colors cursor-pointer flex-1 sm:flex-initial"
          >
            <HardDrive className={cn('w-3.5 h-3.5', auditing && 'animate-pulse')} />
            <span>{auditing ? 'Previewing…' : 'Refresh Preview · Dry Run'}</span>
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
            onClick={() => void fetchStats()}
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

      {audit && (
        <section className="space-y-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.035] p-4 sm:p-5" data-testid="canonical-audit-results">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white">Shared archive audit · read-only</h2>
              <p className="mt-1 text-xs text-zinc-500">Generated {new Date(audit.generatedAt).toLocaleString()} · no database rows were changed</p>
            </div>
            <span className="w-fit rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 font-mono text-[10px] font-semibold text-amber-300">
              DRY RUN
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Shared circulars', audit.archive.total],
              ['Missing bodies', audit.archive.bodyTextMissing],
              ['Old identity version', audit.archive.outdatedIdentityVersion],
              ['Attachments not parsed', audit.archive.attachmentsMissingExtractedRows],
              ['Unsupported apps', audit.userTracking.unsupportedNonManualApplicationCount],
              ['Connected College inboxes', audit.onboarding.connectedCollegeInboxCount],
              ['Attachments in archive', audit.archive.attachmentCount],
              ['Missing message IDs', audit.archive.messageIdMissing],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-zinc-800/80 bg-zinc-950/65 p-3">
                <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">{label}</div>
                <div className="mt-1.5 font-mono text-lg font-bold text-zinc-100">{Number(value).toLocaleString()}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
            <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/65 p-3">
              <div className="mb-2 font-semibold text-zinc-200">Other archive gaps</div>
              <ul className="space-y-1 text-zinc-400">
                <li>Short body text: {audit.archive.bodyTextShort}</li>
                <li>Old parser version: {audit.archive.outdatedParserVersion}</li>
                <li>Missing classification: {audit.archive.classificationMissing}</li>
                <li>Missing company parse: {audit.archive.parsedCompanyMissing}</li>
                <li>Missing job details: {audit.archive.parsedJobDetailsMissing}</li>
                <li>Missing parsed events: {audit.archive.parsedEventsMissing}</li>
                <li>Attachments without content hash: {audit.archive.attachmentsMissingContentHash}</li>
              </ul>
            </div>
            <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/65 p-3">
              <div className="mb-2 font-semibold text-zinc-200">Shared attachment states</div>
              {Object.entries(audit.archive.attachmentStatusCounts).length === 0 ? (
                <p className="text-zinc-500">No attachment rows found.</p>
              ) : (
                <ul className="space-y-1 text-zinc-400">
                  {Object.entries(audit.archive.attachmentStatusCounts).map(([state, count]) => (
                    <li key={state}>{state}: {count}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {audit.userTracking.unsupportedSamples.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-zinc-800/80 bg-zinc-950/65">
              <div className="border-b border-zinc-800 px-3 py-2.5 text-xs font-semibold text-zinc-200">
                Applications without Personal or shortlist evidence (sample)
              </div>
              <table className="w-full min-w-[650px] text-left text-[11px]">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Student</th>
                    <th className="px-3 py-2 font-medium">Company</th>
                    <th className="px-3 py-2 font-medium">Drive</th>
                    <th className="px-3 py-2 font-medium">Status source</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.userTracking.unsupportedSamples.map((row, index) => (
                    <tr key={`${row.userEmail}-${row.driveNumber}-${index}`} className="border-t border-zinc-800/70 text-zinc-300">
                      <td className="px-3 py-2">{row.userEmail || 'Unknown'}</td>
                      <td className="px-3 py-2">{row.company || 'Unknown'}</td>
                      <td className="px-3 py-2 font-mono">{row.driveNumber || '—'}</td>
                      <td className="px-3 py-2">{row.statusSource || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {refreshPreview && (
        <section className="space-y-3 rounded-xl border border-cyan-500/25 bg-cyan-500/[0.035] p-4 sm:p-5" data-testid="canonical-refresh-preview">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white">One-time archive refresh preview · batch results</h2>
              <p className="mt-1 text-xs text-zinc-500">Source inbox: {refreshPreview.sourceInbox || 'No connected College inbox'}</p>
              <p className="mt-1 text-xs text-zinc-500">Fixed cutoff date: before {refreshPreview.before}</p>
            </div>
              <span className="w-fit rounded-full border border-cyan-500/25 bg-cyan-500/10 px-2.5 py-1 font-mono text-[10px] font-semibold text-cyan-300">
                GMAIL READ-ONLY · NO DB WRITES
              </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Scanned IDs', refreshPreview.scanned],
              ['Existing rows reused', refreshPreview.reused],
              ['New rows proposed', refreshPreview.wouldCreate],
              ['Workbook attachments parseable', refreshPreview.attachmentsParsed],
              ['Attachments reused', refreshPreview.attachmentsReused],
              ['Attachment bytes to read', refreshPreview.attachmentBytes],
              ['Message errors', refreshPreview.failed],
              ['Attachment errors', refreshPreview.attachmentsFailed],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-zinc-800/80 bg-zinc-950/65 p-3">
                <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">{label}</div>
                <div className="mt-1.5 font-mono text-lg font-bold text-zinc-100">{Number(value).toLocaleString()}</div>
              </div>
            ))}
          </div>
          {refreshPreview.nextAfterId && (
            <button
              onClick={() => void handleRefreshPreview(refreshPreview.nextAfterId || undefined)}
              disabled={auditing}
              className="inline-flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/15 disabled:opacity-50"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', auditing && 'animate-spin')} />
              Preview next batch
            </button>
          )}
          {refreshPreview.errors.length > 0 && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3 text-xs text-amber-200">
              <div className="mb-1 font-semibold">Preview notes</div>
              <ul className="space-y-1">
                {refreshPreview.errors.slice(0, 5).map((item, index) => (
                  <li key={`${item.subject}-${index}`}>{item.subject}: {item.message}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
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
              <span className="font-mono text-[11px] text-emerald-400 font-semibold">Personal + central College</span>
            </div>

            <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-purple-400" />
                <span className="font-medium text-white">cron-job.org Safety Net</span>
              </div>
              <span className="font-mono text-[11px] text-purple-300">Users + shared College</span>
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
