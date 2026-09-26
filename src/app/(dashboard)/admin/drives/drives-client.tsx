'use client';

import { useState, useEffect } from 'react';
import {
  Building2,
  Search,
  RefreshCw,
  Mail,
  Pencil,
  ChevronDown,
  ChevronRight,
  Users,
  Loader2,
  Trash2,
  Unlink,
  Link2,
  CheckCircle2,
  AlertCircle,
  Shield,
} from 'lucide-react';
import { timeAgo, cn } from '@/lib/utils';
import { appToast } from '@/components/ui/toast';

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
  driveIds: string[];
  aliases?: string[];
}

interface SearchEmailResult {
  id: string;
  subject: string;
  sender: string;
  receivedAt: string | null;
  snippet: string;
  canonicalEmailId: string | null;
  placementDriveId: string | null;
  receiptCount: number;
  emailIds: string[];
  students: Array<{ name: string; email: string }>;
}

interface DriveEmail {
  id: string;
  subject: string;
  sender: string;
  receivedAt: string | null;
  classification: string | null;
  bodySnippet: string;
  canonicalEmailId: string | null;
  collegeEmailId?: string | null;
  isCanonical: boolean;
  isCollegeCircular?: boolean;
  receiptCount: number;
  emailIds: string[];
  students: { userId: string; userName: string; userEmail: string }[];
}

const CLASSIFICATION_OPTIONS = [
  { value: 'registration_announcement', label: 'Registration Announcement' },
  { value: 'registration_confirmation', label: 'Registration Confirmation' },
  { value: 'shortlist', label: 'Shortlist / Qualified' },
  { value: 'oa_scheduled', label: 'OA / Test Scheduled' },
  { value: 'interview_scheduled', label: 'Interview Scheduled' },
  { value: 'placed', label: 'Offer / Placed' },
  { value: 'irrelevant', label: 'Irrelevant / Spam' },
];

export default function DrivesClient() {
  const [drives, setDrives] = useState<AdminDrive[]>([]);
  const [loading, setLoading] = useState(true);
  const [driveSearch, setDriveSearch] = useState('');
  const [expandedDriveKey, setExpandedDriveKey] = useState<string | null>(null);
  const [driveEmails, setDriveEmails] = useState<Record<string, DriveEmail[]>>({});
  const [loadingEmails, setLoadingEmails] = useState<Record<string, boolean>>({});
  const [reprocessingDrives, setReprocessingDrives] = useState<Record<string, boolean>>({});
  const [feedbackMessage, setFeedbackMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Unlinking progress & active status state
  const [unlinkingEmailId, setUnlinkingEmailId] = useState<string | null>(null);
  const [unlinkingProgress, setUnlinkingProgress] = useState<{
    emailId: string;
    step: number;
    stage: string;
    studentCount: number;
  } | null>(null);

  // Edit Drive Form state
  const [editingDrive, setEditingDrive] = useState<AdminDrive | null>(null);
  const [editCompanyName, setEditCompanyName] = useState('');
  const [editDriveNumber, setEditDriveNumber] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editCtc, setEditCtc] = useState('');
  const [editStipend, setEditStipend] = useState('');
  const [editLocation, setEditLocation] = useState('');
  const [editAliases, setEditAliases] = useState('');
  const [savingDrive, setSavingDrive] = useState(false);

  // Link Email Modal state
  const [linkingDrive, setLinkingDrive] = useState<AdminDrive | null>(null);
  const [linkSearchQuery, setLinkSearchQuery] = useState('');
  const [searchingEmails, setSearchingEmails] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchEmailResult[]>([]);
  const [linkingEmailId, setLinkingEmailId] = useState<string | null>(null);
  const [autoAddAlias, setAutoAddAlias] = useState(true);

  const fetchDrives = async (manual: boolean = false) => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/drives');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load drives');
      setDrives(data.drives || []);
      if (manual) {
        appToast.success('Drives refreshed', `Loaded ${data.drives?.length || 0} recruitment campaigns.`);
      }
    } catch (err: any) {
      appToast.error('Failed to load drives', err.message || 'Failed to load drives');
      setFeedbackMessage({ type: 'error', text: err.message || 'Failed to load drives' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDrives();
  }, []);

  const toggleExpandDrive = async (driveKey: string) => {
    if (expandedDriveKey === driveKey) {
      setExpandedDriveKey(null);
      return;
    }
    setExpandedDriveKey(driveKey);
    if (!driveEmails[driveKey]) {
      setLoadingEmails((prev) => ({ ...prev, [driveKey]: true }));
      try {
        const res = await fetch(`/api/admin/drives/${encodeURIComponent(driveKey)}/emails`);
        const data = await res.json();
        if (res.ok) {
          setDriveEmails((prev) => ({ ...prev, [driveKey]: data.emails || [] }));
        }
      } catch (err: any) {
        console.error('Failed to load drive emails:', err);
      } finally {
        setLoadingEmails((prev) => ({ ...prev, [driveKey]: false }));
      }
    }
  };

  const handleReprocessDrive = async (driveKey: string) => {
    const targetDrive = drives.find((d) => d.driveKey === driveKey);
    const driveName = targetDrive?.companyName || driveKey;
    setReprocessingDrives((prev) => ({ ...prev, [driveKey]: true }));
    const toastId = 'reprocess-' + driveKey;
    appToast.loading(
      'Reprocessing drive…',
      `Recalculating application statuses and circular correlations for ${driveName}…`,
      undefined,
      Infinity,
      toastId
    );
    setFeedbackMessage({
      type: 'success',
      text: `Recalculating application statuses and circular correlations for ${driveName}…`,
    });
    try {
      const res = await fetch(`/api/admin/drives/${encodeURIComponent(driveKey)}/reprocess`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Drive reprocess failed');
      const affected = data.usersAffected ?? data.result?.usersAffected ?? 0;
      appToast.success(
        'Drive reprocessed successfully',
        `Recalculated across ${affected} student account${affected === 1 ? '' : 's'}.`,
        undefined,
        5000,
        toastId
      );
      setFeedbackMessage({
        type: 'success',
        text: `Drive reprocessed successfully across ${affected} student account${affected === 1 ? '' : 's'}.`,
      });
      fetchDrives();
    } catch (err: any) {
      appToast.error('Reprocess failed', err.message || 'Drive reprocess failed', undefined, 7000, toastId);
      setFeedbackMessage({ type: 'error', text: err.message || 'Reprocess failed' });
    } finally {
      setReprocessingDrives((prev) => ({ ...prev, [driveKey]: false }));
    }
  };

  const handleOpenEditDrive = (drive: AdminDrive) => {
    setEditingDrive(drive);
    setEditCompanyName(drive.companyName || '');
    setEditDriveNumber(drive.driveNumber || '');
    setEditRole(drive.role || '');
    setEditCategory(drive.category || '');
    setEditCtc(drive.ctc || '');
    setEditStipend(drive.stipend || '');
    setEditLocation(drive.location || '');
    setEditAliases((drive.aliases || []).join(', '));
  };

  const handleSaveDrive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDrive || !editCompanyName.trim()) return;

    setSavingDrive(true);
    const toastId = 'save-drive-' + editingDrive.driveKey;
    appToast.loading('Saving drive edits…', `Updating "${editCompanyName}" across student accounts…`, undefined, Infinity, toastId);

    try {
      const aliasArray = editAliases
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const res = await fetch(`/api/admin/drives/${encodeURIComponent(editingDrive.driveKey)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName: editCompanyName.trim(),
          driveNumber: editDriveNumber.trim() || null,
          role: editRole.trim() || null,
          category: editCategory.trim() || null,
          ctc: editCtc.trim() || null,
          stipend: editStipend.trim() || null,
          location: editLocation.trim() || null,
          aliases: aliasArray,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update placement drive');

      const successText = `Drive "${editCompanyName}" updated successfully across ${data.updatedCount || 'all'} student accounts.`;
      appToast.success('Drive updated', successText, undefined, 5000, toastId);
      setFeedbackMessage({
        type: 'success',
        text: successText,
      });

      setEditingDrive(null);
      fetchDrives();
    } catch (err: any) {
      appToast.error('Failed to save drive', err.message || 'Drive update failed', undefined, 7000, toastId);
      setFeedbackMessage({ type: 'error', text: err.message || 'Failed to save drive edits' });
    } finally {
      setSavingDrive(false);
    }
  };

  const searchUnassignedEmails = async (query: string, driveKey?: string) => {
    setSearchingEmails(true);
    try {
      const driveKeyParam = driveKey ? `&driveKey=${encodeURIComponent(driveKey)}` : '';
      const res = await fetch(`/api/admin/emails/search?q=${encodeURIComponent(query)}&unassignedOnly=true${driveKeyParam}`);
      const data = await res.json();
      if (res.ok) {
        setSearchResults(data.results || []);
      }
    } catch (err: any) {
      console.error('Failed to search unassigned emails:', err);
    } finally {
      setSearchingEmails(false);
    }
  };

  const handleOpenLinkEmail = (drive: AdminDrive) => {
    setLinkingDrive(drive);
    // Pre-populate search query with first word or company name if available
    const initialQuery = drive.companyName ? drive.companyName.split(' ')[0] : '';
    setLinkSearchQuery(initialQuery);
    searchUnassignedEmails(initialQuery, drive.driveKey);
  };

  const handleLinkEmailToDrive = async (email: SearchEmailResult) => {
    if (!linkingDrive) return;
    setLinkingEmailId(email.id);
    const toastId = 'link-email-' + email.id;
    appToast.loading('Linking circular to drive…', `Connecting circular to "${linkingDrive.companyName}"…`, undefined, Infinity, toastId);

    try {
      let aliasToAdd: string | undefined = undefined;
      if (autoAddAlias && linkSearchQuery.trim()) {
        const queryTerm = linkSearchQuery.trim();
        if (
          queryTerm.toLowerCase() !== linkingDrive.companyName.toLowerCase() &&
          !(linkingDrive.aliases || []).some((a) => a.toLowerCase() === queryTerm.toLowerCase())
        ) {
          aliasToAdd = queryTerm;
        }
      }

      const res = await fetch(`/api/admin/drives/${encodeURIComponent(linkingDrive.driveKey)}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailId: email.id,
          emailIds: email.emailIds,
          aliasToAdd,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to link email to drive');

      const affected = data.result?.usersAffected ?? (email.students?.length || 1);
      const successText = `Linked circular to "${linkingDrive.companyName}" across ${affected} student account${affected === 1 ? '' : 's'}.`;
      appToast.success('Circular linked successfully', successText, undefined, 5000, toastId);
      setFeedbackMessage({
        type: 'success',
        text: successText,
      });

      setSearchResults((prev) => prev.filter((r) => r.id !== email.id));

      try {
        const emailRes = await fetch(`/api/admin/drives/${encodeURIComponent(linkingDrive.driveKey)}/emails`);
        const emailData = await emailRes.json();
        if (emailRes.ok) {
          setDriveEmails((prev) => ({ ...prev, [linkingDrive.driveKey]: emailData.emails || [] }));
        }
      } catch (e) {
        // ignore
      }

      fetchDrives();
      setLinkingDrive(null);
    } catch (err: any) {
      appToast.error('Linking failed', err.message || 'Failed to link email to drive', undefined, 7000, toastId);
      setFeedbackMessage({ type: 'error', text: err.message || 'Linking failed' });
    } finally {
      setLinkingEmailId(null);
    }
  };

  const handleUnlinkEmail = async (email: DriveEmail, driveKey: string) => {
    const targetDrive = drives.find((d) => d.driveKey === driveKey);
    const driveName = targetDrive?.companyName || 'placement drive';
    const studentCount = email.students?.length || 1;
    const emailCount = email.receiptCount || email.emailIds?.length || studentCount;
    const confirmMsg =
      studentCount > 1
        ? `Unlink this circular from "${driveName}" for all ${studentCount} students (${emailCount} total copies)?\n\nThis permanently protects it from auto-sync re-attachment and recalculates application statuses.`
        : `Unlink this circular from "${driveName}"?\n\nThis permanently protects it from auto-sync re-attachment and recalculates application status.`;
    if (!confirm(confirmMsg)) return;

    setUnlinkingEmailId(email.id);
    setUnlinkingProgress({
      emailId: email.id,
      step: 1,
      stage: 'Guarding email & unlinking from placement drive…',
      studentCount,
    });

    const toastId = 'unlink-email-' + email.id;
    appToast.loading(
      'Unlinking circular…',
      `Disconnecting from "${driveName}" across ${studentCount} student account${studentCount === 1 ? '' : 's'}…`,
      undefined,
      Infinity,
      toastId
    );

    // Staged progress indication as server-side reconciliation executes
    const timer1 = setTimeout(() => {
      setUnlinkingProgress((prev) =>
        prev && prev.emailId === email.id
          ? { ...prev, step: 2, stage: 'Clearing matches, email drive links & timeline events…' }
          : prev
      );
    }, 700);

    const timer2 = setTimeout(() => {
      setUnlinkingProgress((prev) =>
        prev && prev.emailId === email.id
          ? { ...prev, step: 3, stage: 'Recalculating student application statuses from remaining evidence…' }
          : prev
      );
    }, 1800);

    try {
      const res = await fetch(`/api/admin/emails/${email.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unlinkDrive: true,
          driveKey,
          emailIds: email.emailIds || [email.id],
        }),
      });
      const data = await res.json();
      clearTimeout(timer1);
      clearTimeout(timer2);

      if (!res.ok) throw new Error(data.error || 'Failed to unlink');

      setDriveEmails((prev) => ({
        ...prev,
        [driveKey]: (prev[driveKey] || []).filter((e) => e.id !== email.id),
      }));

      setDrives((prev) =>
        prev.map((d) =>
          d.driveKey === driveKey
            ? { ...d, totalEmails: Math.max(0, d.totalEmails - 1) }
            : d
        )
      );

      const successDetail =
        data.message ||
        `Circular unlinked from "${driveName}" for ${studentCount} student account${studentCount === 1 ? '' : 's'}. Application statuses recalculated.`;

      appToast.success(
        'Circular unlinked successfully',
        successDetail,
        undefined,
        6000,
        toastId
      );

      setFeedbackMessage({
        type: 'success',
        text: successDetail,
      });
    } catch (err: any) {
      clearTimeout(timer1);
      clearTimeout(timer2);
      appToast.error('Unlink failed', err.message || 'Failed to unlink circular', undefined, 7000, toastId);
      setFeedbackMessage({ type: 'error', text: err.message || 'Unlink failed' });
    } finally {
      setUnlinkingEmailId(null);
      setUnlinkingProgress(null);
    }
  };

  const handleUpdateEmailClassification = async (email: DriveEmail, driveKey: string, newClass: string) => {
    const targetDrive = drives.find((d) => d.driveKey === driveKey);
    const classLabel = CLASSIFICATION_OPTIONS.find((c) => c.value === newClass)?.label || newClass || 'Auto';
    const toastId = 'classify-' + email.id;
    try {
      const res = await fetch(`/api/admin/emails/${email.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_classification',
          classification: newClass,
          driveKey,
          emailIds: email.emailIds || [email.id],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Update failed');
      if (newClass === 'irrelevant') {
        setDriveEmails((prev) => ({
          ...prev,
          [driveKey]: (prev[driveKey] || []).filter((e) => e.id !== email.id),
        }));
        setDrives((prev) =>
          prev.map((d) =>
            d.driveKey === driveKey
              ? { ...d, totalEmails: Math.max(0, d.totalEmails - 1) }
              : d
          )
        );
      } else {
        setDriveEmails((prev) => ({
          ...prev,
          [driveKey]: (prev[driveKey] || []).map((e) =>
            e.id === email.id ? { ...e, classification: newClass } : e
          ),
        }));
      }
      const successText = newClass === 'irrelevant'
        ? `Circular marked as irrelevant and permanently unlinked from "${targetDrive?.companyName || 'drive'}".`
        : `Classification set to ${classLabel} across student receipts.`;
      appToast.success('Classification updated', successText, undefined, 4500, toastId);
      setFeedbackMessage({ type: 'success', text: successText });
    } catch (err: any) {
      appToast.error('Update failed', err.message || 'Failed to update classification', undefined, 6000, toastId);
      setFeedbackMessage({ type: 'error', text: err.message || 'Update failed' });
    }
  };

  const filteredDrives = drives.filter((d) => {
    const q = driveSearch.toLowerCase().trim();
    if (!q) return true;
    return (
      d.companyName.toLowerCase().includes(q) ||
      (d.driveNumber && d.driveNumber.includes(q)) ||
      (d.role && d.role.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-16">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-zinc-800/80 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <Building2 className="w-3.5 h-3.5" />
              Recruitment Campaigns
            </span>
            <span className="text-xs text-zinc-500 font-mono">Multi-Tenant Pipeline</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mt-2">
            Placement Drives & Email Pipeline
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Search, inspect synced circulars, edit drive criteria, and reprocess candidate shortlists.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => fetchDrives(true)}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-zinc-200 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg border border-zinc-700/60 transition-colors cursor-pointer"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            Refresh Drives
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

      {/* Search and Filters Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search by company name, role, or drive number (e.g. 142)…"
            value={driveSearch}
            onChange={(e) => setDriveSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 text-xs bg-zinc-900/80 border border-zinc-800 rounded-xl text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50 shadow-inner"
          />
        </div>
        <div className="text-xs text-zinc-400 font-mono self-center">
          Showing <span className="text-amber-400 font-bold">{filteredDrives.length}</span> of {drives.length} drives
        </div>
      </div>

      {/* Drives List */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl overflow-hidden backdrop-blur-sm shadow-xl">
        <div className="divide-y divide-zinc-800/60">
          {filteredDrives.length === 0 ? (
            <div className="p-12 text-center text-sm text-zinc-500">
              {loading ? (
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                  Loading placement drives…
                </div>
              ) : (
                'No placement drives match your search.'
              )}
            </div>
          ) : (
            filteredDrives.map((drive) => {
              const isExpanded = expandedDriveKey === drive.driveKey;
              const emails = driveEmails[drive.driveKey] || [];
              const isLoadingEmails = loadingEmails[drive.driveKey];
              const isReprocessing = reprocessingDrives[drive.driveKey];

              return (
                <div key={drive.driveKey} className="transition-colors">
                  {/* Drive Row */}
                  <div className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-zinc-800/20">
                    <div className="flex items-start gap-3.5 min-w-0 flex-1">
                      <button
                        onClick={() => toggleExpandDrive(drive.driveKey)}
                        className="mt-0.5 p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
                        title={isExpanded ? 'Collapse emails' : 'Inspect synced emails'}
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-amber-400" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </button>

                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex items-start justify-between sm:justify-start sm:items-center gap-2 flex-wrap">
                          <h3 className="text-base sm:text-lg font-bold text-white break-words">
                            {drive.companyName}
                          </h3>
                          {drive.category && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-zinc-800 text-zinc-300 border border-zinc-700/60 shrink-0">
                              {drive.category}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-x-2 gap-y-1 text-xs text-zinc-400 flex-wrap">
                          {drive.driveNumber && (
                            <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-amber-500/15 text-amber-300 border border-amber-500/25 shrink-0">
                              Drive {drive.driveNumber}
                            </span>
                          )}
                          {drive.role && <span className="text-zinc-300 font-medium">{drive.role}</span>}
                          {drive.ctc && (
                            <span className="text-emerald-400 font-mono font-semibold bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded text-[11px] shrink-0">
                              {drive.ctc}
                            </span>
                          )}
                          {drive.location && (
                            <span className="text-zinc-400 text-[11px]">{drive.location}</span>
                          )}
                        </div>

                        {drive.aliases && drive.aliases.length > 0 && (
                          <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                            <span className="text-[10px] text-zinc-500 font-mono">Aliases:</span>
                            {drive.aliases.slice(0, 2).map((al) => (
                              <span
                                key={al}
                                className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-300/90 border border-amber-500/20 max-w-[130px] truncate"
                                title={al}
                              >
                                {al}
                              </span>
                            ))}
                            {drive.aliases.length > 2 && (
                              <span
                                className="px-1.5 py-0.5 rounded text-[9px] font-mono text-zinc-400 bg-zinc-800/80 border border-zinc-700/50 cursor-help"
                                title={drive.aliases.slice(2).join(', ')}
                              >
                                +{drive.aliases.length - 2} more
                              </span>
                            )}
                          </div>
                        )}

                        <div className="flex items-center gap-x-2.5 gap-y-1 mt-1.5 text-xs text-zinc-400 flex-wrap">
                          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-zinc-400 bg-zinc-800/60 px-2 py-0.5 rounded">
                            <Users className="w-3 h-3 text-indigo-400" />
                            {drive.totalUsers} student{drive.totalUsers === 1 ? '' : 's'}
                          </span>

                          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-zinc-400 bg-zinc-800/60 px-2 py-0.5 rounded">
                            <Mail className="w-3 h-3 text-cyan-400" />
                            {drive.totalEmails} email{drive.totalEmails === 1 ? '' : 's'}
                          </span>

                          {drive.latestEmailAt && (
                            <span className="text-zinc-500 font-mono text-[11px]">
                              Latest {timeAgo(drive.latestEmailAt)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Drive Actions */}
                    <div className="grid grid-cols-3 gap-2 w-full md:flex md:w-auto md:items-center shrink-0 mt-3 md:mt-0">
                      <button
                        onClick={() => handleOpenEditDrive(drive)}
                        className="px-2.5 sm:px-3 py-2 sm:py-1.5 text-xs font-medium rounded-lg border bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border-zinc-700/60 transition-colors cursor-pointer flex items-center justify-center gap-1.5"
                        title="Edit drive details, CTC, tier category, or drive number"
                      >
                        <Pencil className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        <span className="hidden sm:inline">Edit Drive</span>
                        <span className="sm:hidden">Edit</span>
                      </button>

                      <button
                        onClick={() => toggleExpandDrive(drive.driveKey)}
                        className={cn(
                          'px-2.5 sm:px-3 py-2 sm:py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer flex items-center justify-center gap-1.5',
                          isExpanded
                            ? 'bg-amber-500/10 text-amber-300 border-amber-500/25'
                            : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border-zinc-700/60'
                        )}
                      >
                        <Mail className="w-3.5 h-3.5 shrink-0" />
                        <span className="hidden sm:inline">{isExpanded ? 'Hide Mails' : 'Inspect Mails'}</span>
                        <span className="sm:hidden">{isExpanded ? 'Hide' : 'Mails'}</span>
                      </button>

                      <button
                        onClick={() => handleReprocessDrive(drive.driveKey)}
                        disabled={isReprocessing}
                        className="px-2.5 sm:px-3.5 py-2 sm:py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg shadow-sm transition-colors cursor-pointer flex items-center justify-center gap-1.5"
                        title="Recalculate application status, shortlist matches, and events for all students in this drive"
                      >
                        <RefreshCw className={cn('w-3.5 h-3.5 shrink-0', isReprocessing && 'animate-spin')} />
                        <span className="hidden sm:inline">{isReprocessing ? 'Reprocessing…' : 'Reprocess Drive'}</span>
                        <span className="sm:hidden">{isReprocessing ? 'Syncing…' : 'Reprocess'}</span>
                      </button>
                    </div>
                  </div>

                  {/* Expanded Synced Emails Panel */}
                  {isExpanded && (
                    <div className="bg-zinc-950/80 border-t border-zinc-800/80 p-4 sm:p-6 space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <h4 className="text-xs uppercase tracking-wider font-semibold text-zinc-300 flex items-center gap-2">
                            <Mail className="w-3.5 h-3.5 text-amber-400" />
                            Emails Assigned to this Drive ({emails.length})
                          </h4>
                          <button
                            onClick={() => handleOpenLinkEmail(drive)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg border border-amber-500/30 transition-colors cursor-pointer"
                            title="Search and link unassigned broadcast circulars to this placement drive"
                          >
                            <Link2 className="w-3.5 h-3.5" />
                            <span>+ Link Email</span>
                          </button>
                        </div>
                        <p className="text-[11px] text-zinc-500">
                          Link circulars or unlink misassigned emails, then click &ldquo;Reprocess Drive&rdquo; above.
                        </p>
                      </div>

                      {isLoadingEmails ? (
                        <div className="p-6 text-center text-xs text-zinc-400 flex items-center justify-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                          Loading synced emails for this drive…
                        </div>
                      ) : emails.length === 0 ? (
                        <div className="p-4 text-center text-xs text-zinc-500">
                          No direct emails attached to this drive in the database.
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {emails.map((email) => {
                            const studentCount = email.students?.length || 1;
                            const emailCount = email.receiptCount || email.emailIds?.length || studentCount;
                            const studentNames = email.students?.map((s) => s.userName || s.userEmail).join(', ') || '';

                            const isUnlinkingThis = unlinkingEmailId === email.id;

                            return (
                              <div
                                key={email.id}
                                className={cn(
                                  'p-4 rounded-xl border transition-all text-xs',
                                  isUnlinkingThis
                                    ? 'border-amber-500/50 bg-amber-500/[0.04] ring-1 ring-amber-500/30 shadow-lg shadow-amber-500/5'
                                    : 'border-zinc-800/90 bg-zinc-900/60 hover:bg-zinc-900'
                                )}
                              >
                                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                                  <div className="min-w-0 flex-1 space-y-1.5">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      {(email.isCollegeCircular || email.isCanonical) && (
                                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                                          College Circular
                                        </span>
                                      )}
                                      {studentCount > 1 ? (
                                        <span
                                          className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-500/25 cursor-help"
                                          title={`Synced by ${studentCount} students (${emailCount} total email records): ${studentNames}`}
                                        >
                                          {studentCount} Students Synced
                                          {emailCount > studentCount && (
                                            <span className="text-indigo-400/80 font-normal ml-1">({emailCount} copies)</span>
                                          )}
                                        </span>
                                      ) : (
                                        <span className="text-zinc-400 font-medium">
                                          {studentNames || '1 Student'}
                                          {emailCount > 1 && (
                                            <span className="text-zinc-500 text-[10px] font-mono ml-1">({emailCount} copies)</span>
                                          )}
                                        </span>
                                      )}
                                      <span className="text-[11px] text-zinc-400 font-mono truncate max-w-xs">
                                        {email.sender}
                                      </span>
                                      {email.receivedAt && (
                                        <>
                                          <span className="text-zinc-600">·</span>
                                          <span className="text-[11px] text-zinc-500 font-mono">
                                            {timeAgo(email.receivedAt)}
                                          </span>
                                        </>
                                      )}
                                    </div>

                                    <div className="font-semibold text-white text-sm">
                                      {email.subject}
                                    </div>

                                    {(email.bodySnippet || (email as any).snippet) && (
                                      <p className="text-[11px] text-zinc-400 line-clamp-2 leading-relaxed">
                                        {email.bodySnippet || (email as any).snippet}
                                      </p>
                                    )}

                                    {studentNames && studentCount > 1 && (
                                      <p className="text-[10px] text-zinc-500 font-mono truncate">
                                        Recipients ({studentCount}): <span className="text-zinc-400">{studentNames}</span>
                                      </p>
                                    )}
                                  </div>

                                  <div className="flex items-center justify-between sm:justify-end gap-2 shrink-0 w-full sm:w-auto mt-2 sm:mt-0">
                                    <select
                                      value={email.classification || ''}
                                      disabled={isUnlinkingThis || unlinkingEmailId !== null}
                                      onChange={(e) =>
                                        handleUpdateEmailClassification(email, drive.driveKey, e.target.value)
                                      }
                                      className="flex-1 sm:flex-initial px-2.5 py-1.5 text-[11px] font-medium bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                                    >
                                      <option value="">Classification: Auto</option>
                                      {CLASSIFICATION_OPTIONS.map((c) => (
                                        <option key={c.value} value={c.value}>
                                          {c.label}
                                        </option>
                                      ))}
                                    </select>

                                    <button
                                      onClick={() => handleUnlinkEmail(email, drive.driveKey)}
                                      disabled={unlinkingEmailId !== null}
                                      className={cn(
                                        'px-3 py-1.5 text-[11px] font-medium rounded-lg border transition-all flex items-center gap-1.5 shrink-0',
                                        isUnlinkingThis
                                          ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 cursor-wait shadow-sm'
                                          : 'text-red-400 hover:text-red-300 hover:bg-red-500/10 border-red-500/20 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed'
                                      )}
                                      title={
                                        studentCount > 1
                                          ? `Unlink from drive for all ${studentCount} students (${emailCount} total emails)`
                                          : `Unlink from this drive (${emailCount} email${emailCount > 1 ? 's' : ''})`
                                      }
                                    >
                                      {isUnlinkingThis ? (
                                        <>
                                          <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400 shrink-0" />
                                          <span>Unlinking…</span>
                                        </>
                                      ) : (
                                        <>
                                          <Unlink className="w-3.5 h-3.5 shrink-0" />
                                          <span>{studentCount > 1 ? `Unlink (${studentCount})` : 'Unlink'}</span>
                                        </>
                                      )}
                                    </button>
                                  </div>
                                </div>

                                {/* Active Unlinking Progress Meter */}
                                {isUnlinkingThis && (
                                  <div className="mt-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs space-y-2 animate-fade-in">
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="flex items-center gap-2 text-amber-300 font-medium text-[11px]">
                                        <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400 shrink-0" />
                                        <span>{unlinkingProgress?.stage || 'Unlinking circular & recalculating statuses…'}</span>
                                      </div>
                                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-200 border border-amber-500/30 shrink-0">
                                        Step {unlinkingProgress?.step || 1} of 3
                                      </span>
                                    </div>
                                    <div className="h-1.5 w-full bg-zinc-800/80 rounded-full overflow-hidden">
                                      <div
                                        className="h-full bg-gradient-to-r from-amber-500 to-amber-400 rounded-full transition-all duration-500 ease-out shadow-[0_0_8px_rgba(251,191,36,0.6)]"
                                        style={{
                                          width:
                                            unlinkingProgress?.step === 1
                                              ? '33%'
                                              : unlinkingProgress?.step === 2
                                              ? '66%'
                                              : '92%',
                                        }}
                                      />
                                    </div>
                                    <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono">
                                      <span>Protected by admin guard against auto-sync re-attachment</span>
                                      <span>{studentCount} student account{studentCount === 1 ? '' : 's'}</span>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Edit Drive Modal */}
      {editingDrive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4 animate-fade-in max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-zinc-800/80 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
                  <Pencil className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white">Edit Placement Drive</h3>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Modifying {editingDrive.companyName} across {editingDrive.totalUsers} student accounts
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditingDrive(null)}
                className="text-zinc-500 hover:text-white p-1 rounded-lg transition-colors cursor-pointer text-sm"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveDrive} className="space-y-4 pt-1">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                    Company Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={editCompanyName}
                    onChange={(e) => setEditCompanyName(e.target.value)}
                    placeholder="e.g. Schneider Electric"
                    className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-white focus:outline-none focus:border-amber-500/50"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                    Drive Number
                  </label>
                  <input
                    type="text"
                    value={editDriveNumber}
                    onChange={(e) => setEditDriveNumber(e.target.value)}
                    placeholder="e.g. 142 (optional)"
                    className="w-full px-3 py-2 text-xs font-mono bg-zinc-950 border border-zinc-800 rounded-lg text-amber-300 focus:outline-none focus:border-amber-500/50"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                    Role / Job Profile
                  </label>
                  <input
                    type="text"
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value)}
                    placeholder="e.g. Graduate Trainee / SDE"
                    className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-white focus:outline-none focus:border-amber-500/50"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                    Category Tier
                  </label>
                  <input
                    type="text"
                    list="category-suggestions"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    placeholder="e.g. Super Dream, Dream, Regular"
                    className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-white focus:outline-none focus:border-amber-500/50"
                  />
                  <datalist id="category-suggestions">
                    <option value="Super Dream" />
                    <option value="Dream" />
                    <option value="Regular" />
                    <option value="Internship" />
                  </datalist>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                    CTC Package
                  </label>
                  <input
                    type="text"
                    value={editCtc}
                    onChange={(e) => setEditCtc(e.target.value)}
                    placeholder="e.g. 12 LPA or 10-14 LPA"
                    className="w-full px-3 py-2 text-xs font-mono bg-zinc-950 border border-zinc-800 rounded-lg text-emerald-300 focus:outline-none focus:border-amber-500/50"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                    Monthly Stipend
                  </label>
                  <input
                    type="text"
                    value={editStipend}
                    onChange={(e) => setEditStipend(e.target.value)}
                    placeholder="e.g. ₹50,000 / month"
                    className="w-full px-3 py-2 text-xs font-mono bg-zinc-950 border border-zinc-800 rounded-lg text-white focus:outline-none focus:border-amber-500/50"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                  Job Location
                </label>
                <input
                  type="text"
                  value={editLocation}
                  onChange={(e) => setEditLocation(e.target.value)}
                  placeholder="e.g. Bangalore, Pune, Remote"
                  className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-white focus:outline-none focus:border-amber-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1.5 flex items-center justify-between">
                  <span>Aliases / Former Names</span>
                  <span className="text-[10px] text-zinc-500 font-normal">Comma-separated</span>
                </label>
                <input
                  type="text"
                  value={editAliases}
                  onChange={(e) => setEditAliases(e.target.value)}
                  placeholder="e.g. LTIMindtree, LTI Mindtree, Mindtree"
                  className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-amber-200 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
                />
                <p className="text-[10px] text-zinc-500 mt-1">
                  Incoming broadcast circulars mentioning these aliases will automatically correlate and link to this placement drive.
                </p>
              </div>

              <p className="text-[11px] text-zinc-500 pt-1">
                Saving will update metadata for all {editingDrive.totalUsers} registered students associated with this drive, synchronize company tags, and link future incoming circulars.
              </p>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-zinc-800/80">
                <button
                  type="button"
                  onClick={() => setEditingDrive(null)}
                  className="px-4 py-2 text-xs font-semibold text-zinc-400 hover:text-white transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingDrive}
                  className="px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded-lg shadow-sm transition-colors cursor-pointer flex items-center gap-2"
                >
                  {savingDrive && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>{savingDrive ? 'Saving Changes…' : 'Save Drive Changes'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Link Email Modal */}
      {linkingDrive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-4 max-h-[90vh] flex flex-col">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-zinc-800/80 pb-4 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
                  <Link2 className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white">Link Circular to Placement Drive</h3>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Target: <span className="text-amber-300 font-medium">{linkingDrive.companyName}</span>
                    {linkingDrive.driveNumber && <span className="font-mono text-zinc-500 ml-1.5">(Drive {linkingDrive.driveNumber})</span>}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setLinkingDrive(null)}
                className="text-zinc-500 hover:text-white p-1 rounded-lg transition-colors cursor-pointer text-sm"
              >
                ✕
              </button>
            </div>

            {/* Search Box */}
            <div className="space-y-3 shrink-0">
              <div className="relative">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Search unassigned emails by subject or keyword (e.g. LTIMindtree, Deloitte)…"
                  value={linkSearchQuery}
                  onChange={(e) => {
                    setLinkSearchQuery(e.target.value);
                    searchUnassignedEmails(e.target.value, linkingDrive?.driveKey);
                  }}
                  className="w-full pl-10 pr-4 py-2.5 text-xs bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50 shadow-inner"
                />
              </div>

              <div className="flex items-center justify-between text-xs text-zinc-400 px-1">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={autoAddAlias}
                    onChange={(e) => setAutoAddAlias(e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-800 text-amber-500 focus:ring-amber-500/30"
                  />
                  <span>Save search keyword as permanent company alias</span>
                </label>
                <span className="font-mono text-[11px] text-zinc-500">
                  {searchResults.length} unassigned circular{searchResults.length === 1 ? '' : 's'} found
                </span>
              </div>
            </div>

            {/* Results List */}
            <div className="flex-1 overflow-y-auto min-h-[220px] max-h-[380px] space-y-3 pr-1">
              {searchingEmails ? (
                <div className="h-40 flex items-center justify-center text-xs text-zinc-400 gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                  Searching unassigned emails…
                </div>
              ) : searchResults.length === 0 ? (
                <div className="h-40 flex flex-col items-center justify-center text-center p-6 text-zinc-500 text-xs">
                  <Mail className="w-8 h-8 text-zinc-700 mb-2" />
                  <p>No unassigned circulars match &ldquo;{linkSearchQuery}&rdquo;.</p>
                  <p className="text-[11px] text-zinc-600 mt-1">Try searching a different keyword or company name.</p>
                </div>
              ) : (
                searchResults.map((result) => {
                  const studentCount = result.students?.length || 1;
                  const emailCount = result.receiptCount || result.emailIds?.length || studentCount;
                  const isLinkingThis = linkingEmailId === result.id;
                  const studentNames = result.students?.map((s) => s.name || s.email).join(', ') || '';

                  return (
                    <div
                      key={result.id}
                      className="p-3.5 rounded-xl border border-zinc-800 bg-zinc-950/70 hover:bg-zinc-950 hover:border-zinc-700 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          {studentCount > 1 ? (
                            <span
                              className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-500/25"
                              title={`Received by ${studentCount} students (${emailCount} total copies): ${studentNames}`}
                            >
                              {studentCount} Students Synced
                              {emailCount > studentCount && (
                                <span className="text-indigo-400/80 font-normal ml-1">({emailCount} copies)</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-[10px] font-mono text-zinc-400">
                              {studentNames || '1 Student'}
                              {emailCount > 1 && (
                                <span className="text-zinc-500 ml-1">({emailCount} copies)</span>
                              )}
                            </span>
                          )}
                          <span className="text-[10px] text-zinc-500 font-mono truncate max-w-xs">
                            {result.sender}
                          </span>
                          {result.receivedAt && (
                            <>
                              <span className="text-zinc-600">·</span>
                              <span className="text-[10px] text-zinc-500 font-mono">
                                {timeAgo(result.receivedAt)}
                              </span>
                            </>
                          )}
                        </div>

                        <div className="font-semibold text-white text-xs leading-snug">
                          {result.subject}
                        </div>

                        {result.snippet && (
                          <p className="text-[11px] text-zinc-400 line-clamp-2 leading-relaxed">
                            {result.snippet}
                          </p>
                        )}
                      </div>

                      <div className="shrink-0 self-end sm:self-center">
                        <button
                          onClick={() => handleLinkEmailToDrive(result)}
                          disabled={isLinkingThis}
                          className="px-3.5 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded-lg shadow-sm transition-colors cursor-pointer flex items-center gap-1.5"
                        >
                          {isLinkingThis ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>Linking…</span>
                            </>
                          ) : (
                            <>
                              <Link2 className="w-3.5 h-3.5" />
                              <span>Link {studentCount > 1 ? `(${studentCount})` : ''}</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-3 border-t border-zinc-800/80 shrink-0 text-xs">
              <span className="text-zinc-500">
                Linking assigns this email for all students and reprocesses this drive.
              </span>
              <button
                type="button"
                onClick={() => setLinkingDrive(null)}
                className="px-4 py-2 text-xs font-semibold text-zinc-400 hover:text-white transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
