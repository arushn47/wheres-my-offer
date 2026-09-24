'use client';

import { useState, useEffect } from 'react';
import {
  Filter,
  Search,
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Pencil,
  Info,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface DriveAlias {
  id: string;
  companyBaseName: string | null;  // used as the Rule/Keyword (company_base_name in DB)
  driveNumber: string | null;
  resolvedCompanyName: string;
  resolvedRole: string | null;
  confidence: number;
  notes: string | null;
  createdAt: string;
}

export default function AliasesClient() {
  const [aliases, setAliases] = useState<DriveAlias[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAliasModal, setShowAliasModal] = useState(false);
  const [editingAlias, setEditingAlias] = useState<DriveAlias | null>(null);

  const [formDriveNumber, setFormDriveNumber] = useState('');
  const [formCompanyName, setFormCompanyName] = useState('');
  const [formBaseName, setFormBaseName] = useState('');
  const [formRole, setFormRole] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [savingAlias, setSavingAlias] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchAliases = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/aliases');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load aliases');
      setAliases(data.aliases || []);
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message || 'Failed to load aliases' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAliases();
  }, []);

  const handleOpenNew = () => {
    setEditingAlias(null);
    setFormDriveNumber('');
    setFormCompanyName('');
    setFormBaseName('');
    setFormRole('');
    setFormNotes('');
    setShowAliasModal(true);
  };

  const handleOpenEdit = (alias: DriveAlias) => {
    setEditingAlias(alias);
    setFormDriveNumber(alias.driveNumber || '');
    setFormCompanyName(alias.resolvedCompanyName || '');
    setFormBaseName(alias.companyBaseName || '');
    setFormRole(
      // Pre-fill role only if it differs from company name (avoid showing stale mirrored value)
      alias.resolvedRole && alias.resolvedRole.trim().toLowerCase() !== alias.resolvedCompanyName.trim().toLowerCase()
        ? alias.resolvedRole
        : ''
    );
    setFormNotes(alias.notes || '');
    setShowAliasModal(true);
  };

  const handleSaveAlias = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formCompanyName) return;

    setSavingAlias(true);
    try {
      const isEdit = Boolean(editingAlias);
      const url = isEdit ? `/api/admin/aliases/${editingAlias!.id}` : '/api/admin/aliases';
      const method = isEdit ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driveNumber: formDriveNumber || undefined,
          resolvedCompanyName: formCompanyName,
          companyBaseName: formBaseName || undefined,
          resolvedRole: formRole || undefined,
          notes: formNotes || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save alias rule');

      setFeedbackMessage({
        type: 'success',
        text: isEdit
          ? `Rule for "${formCompanyName}" updated and synchronized.`
          : `Rule saved for "${formCompanyName}". It is now permanently active in the sync engine.`,
      });

      setShowAliasModal(false);
      setEditingAlias(null);
      fetchAliases();
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message || 'Failed to save rule' });
    } finally {
      setSavingAlias(false);
    }
  };

  const handleDeleteAlias = async (id: string, name: string) => {
    if (!confirm(`Delete drive resolution rule for "${name}"?`)) return;

    try {
      const res = await fetch(`/api/admin/aliases/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete rule');

      setAliases((prev) => prev.filter((a) => a.id !== id));
      setFeedbackMessage({ type: 'success', text: `Rule for "${name}" deleted.` });
    } catch (err: any) {
      setFeedbackMessage({ type: 'error', text: err.message || 'Delete failed' });
    }
  };

  const filteredAliases = aliases.filter((a) => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return (
      (a.companyBaseName && a.companyBaseName.toLowerCase().includes(q)) ||
      a.resolvedCompanyName.toLowerCase().includes(q) ||
      (a.driveNumber && a.driveNumber.toLowerCase().includes(q)) ||
      (a.resolvedRole && a.resolvedRole.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-16">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-zinc-800/80 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              <Filter className="w-3.5 h-3.5" />
              Routing Engine
            </span>
            <span className="text-xs text-zinc-500 font-mono">Dynamic Overrides</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mt-2">
            Drive Resolution Rules
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Master routing dictionary: maps incoming email keywords and drive numbers to official placement campaigns.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleOpenNew}
            className="inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-semibold text-white bg-cyan-600 hover:bg-cyan-500 rounded-lg shadow-sm transition-colors cursor-pointer flex-1 sm:flex-initial"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Rule</span>
          </button>

          <button
            onClick={fetchAliases}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-semibold text-zinc-200 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg border border-zinc-700/60 transition-colors cursor-pointer"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      {/* Explanatory Banner */}
      <div className="p-3.5 rounded-xl bg-cyan-950/20 border border-cyan-800/30 flex items-start gap-3 text-xs text-zinc-300">
        <Info className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
        <div className="leading-relaxed">
          <span className="font-semibold text-cyan-300">Why do rules exist?</span> When emails arrive with varying names (e.g. <span className="text-white font-mono">LTIMindtree</span> vs <span className="text-white font-mono">LTM</span> or circulars quoting drive numbers), these rules instruct the sync engine exactly how to link emails to the correct company and role. Use <span className="font-semibold text-cyan-300">Edit</span> to update existing mappings without creating duplicates.
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
            className="text-xs opacity-70 hover:opacity-100 font-mono cursor-pointer"
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
            placeholder="Search rules by company, keyword, or drive number…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 text-xs bg-zinc-900/80 border border-zinc-800 rounded-xl text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-cyan-500/50 shadow-inner"
          />
        </div>
        <div className="text-xs text-zinc-400 font-mono self-center">
          Showing <span className="text-cyan-400 font-bold">{filteredAliases.length}</span> of {aliases.length} active rules
        </div>
      </div>

      {/* Aliases View: Desktop Table + Mobile Cards */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl overflow-hidden backdrop-blur-sm shadow-xl">
        {/* Desktop Table View (>= md screens) */}
        <div className="hidden md:block overflow-x-auto">
          <table className="min-w-[860px] w-full text-left text-xs text-zinc-300">
            <thead className="bg-zinc-950/70 border-b border-zinc-800 text-[11px] uppercase tracking-wider text-zinc-400 font-semibold">
              <tr>
                <th className="px-6 py-3.5">Drive Number</th>
                <th className="px-6 py-3.5">Resolved Company Name</th>
                <th className="px-6 py-3.5">Role</th>
                <th className="px-6 py-3.5">Rule / Keyword</th>
                <th className="px-6 py-3.5">Notes</th>
                <th className="px-6 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 font-sans">
              {filteredAliases.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-zinc-500">
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
                        Loading resolution rules…
                      </div>
                    ) : (
                      'No resolution rules match your query.'
                    )}
                  </td>
                </tr>
              ) : (
                filteredAliases.map((a) => (
                  <tr key={a.id} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="px-6 py-3.5 whitespace-nowrap">
                      {a.driveNumber ? (
                        <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-amber-500/15 text-amber-300 border border-amber-500/25 whitespace-nowrap">
                          {a.driveNumber}
                        </span>
                      ) : (
                        <span className="text-zinc-600 font-mono">—</span>
                      )}
                    </td>
                    <td className="px-6 py-3.5 font-semibold text-white">
                      {a.resolvedCompanyName}
                    </td>
                    <td className="px-6 py-3.5 text-zinc-300">
                      {a.resolvedRole &&
                       a.resolvedRole.trim().toLowerCase() !== a.resolvedCompanyName.trim().toLowerCase()
                        ? a.resolvedRole
                        : <span className="text-zinc-600">—</span>}
                    </td>
                    <td className="px-6 py-3.5 font-mono text-[11px] text-cyan-300">
                      {a.companyBaseName || <span className="text-zinc-600">—</span>}
                    </td>
                    <td className="px-6 py-3.5 text-zinc-400 max-w-xs truncate" title={a.notes || ''}>
                      {a.notes || '—'}
                    </td>
                    <td className="px-6 py-3.5 whitespace-nowrap text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => handleOpenEdit(a)}
                          className="p-1.5 text-zinc-400 hover:text-cyan-300 hover:bg-cyan-500/10 rounded-md transition-colors cursor-pointer"
                          title="Edit this rule"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteAlias(a.id, a.resolvedCompanyName)}
                          className="p-1.5 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors cursor-pointer"
                          title="Delete this rule"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile Cards View (< md screens) */}
        <div className="block md:hidden divide-y divide-zinc-800/60 font-sans">
          {filteredAliases.length === 0 ? (
            <div className="px-4 py-12 text-center text-zinc-500 text-xs">
              {loading ? (
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
                  Loading resolution rules…
                </div>
              ) : (
                'No resolution rules match your query.'
              )}
            </div>
          ) : (
            filteredAliases.map((a) => (
              <div key={a.id} className="p-4 space-y-2 hover:bg-zinc-800/20 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {a.driveNumber && (
                        <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-amber-500/15 text-amber-300 border border-amber-500/25 whitespace-nowrap">
                          {a.driveNumber}
                        </span>
                      )}
                      {a.companyBaseName && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-cyan-500/10 text-cyan-300 border border-cyan-500/25">
                          {a.companyBaseName}
                        </span>
                      )}
                    </div>

                    <h4 className="font-bold text-white text-base leading-snug break-words">
                      {a.resolvedCompanyName}
                    </h4>

                    {a.resolvedRole &&
                     a.resolvedRole.trim().toLowerCase() !== a.resolvedCompanyName.trim().toLowerCase() && (
                      <p className="text-xs text-zinc-300 font-medium">
                        {a.resolvedRole}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0 pt-0.5">
                    <button
                      onClick={() => handleOpenEdit(a)}
                      className="p-2 text-zinc-400 hover:text-cyan-300 hover:bg-cyan-500/10 rounded-lg border border-zinc-800 transition-colors cursor-pointer"
                      title="Edit this rule"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteAlias(a.id, a.resolvedCompanyName)}
                      className="p-2 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg border border-zinc-800 transition-colors cursor-pointer"
                      title="Delete this rule"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {a.notes && (
                  <p className="text-[11px] text-zinc-400 bg-zinc-950/60 p-2 rounded-lg border border-zinc-800/70 leading-relaxed break-words">
                    {a.notes}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* New / Edit Alias Modal */}
      {showAliasModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4 animate-fade-in">
            <div className="flex items-center justify-between border-b border-zinc-800/80 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shrink-0">
                  {editingAlias ? <Pencil className="w-4 h-4" /> : <Sparkles className="w-4 h-4" />}
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white">
                    {editingAlias ? 'Edit Resolution Rule' : 'New Resolution Rule'}
                  </h3>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {editingAlias ? 'Modify mapping criteria and drive routing' : 'Overrides sync matching heuristics'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowAliasModal(false);
                  setEditingAlias(null);
                }}
                className="text-zinc-500 hover:text-white p-1 rounded-lg transition-colors cursor-pointer text-sm"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveAlias} className="space-y-3.5 pt-1">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Target Company Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. LTM or KPMG GLOBAL SERVICES"
                  value={formCompanyName}
                  onChange={(e) => setFormCompanyName(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-white focus:outline-none focus:border-cyan-500/50"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1">
                    Drive Number (optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. pat-pl-2026-1348"
                    value={formDriveNumber}
                    onChange={(e) => setFormDriveNumber(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono bg-zinc-950 border border-zinc-800 rounded-lg text-amber-300 focus:outline-none focus:border-cyan-500/50"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1">
                    Normalized Base Name
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. ltm or kpmg"
                    value={formBaseName}
                    onChange={(e) => setFormBaseName(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-300 focus:outline-none focus:border-cyan-500/50"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Resolved Role / Track
                </label>
                <input
                  type="text"
                  placeholder="e.g. Graduate Engineer Trainee"
                  value={formRole}
                  onChange={(e) => setFormRole(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-white focus:outline-none focus:border-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Admin Context / Notes
                </label>
                <input
                  type="text"
                  placeholder="e.g. LTM formerly LTIMindtree Limited"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-400 focus:outline-none focus:border-cyan-500/50"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-zinc-800/80">
                <button
                  type="button"
                  onClick={() => {
                    setShowAliasModal(false);
                    setEditingAlias(null);
                  }}
                  className="px-4 py-2 text-xs font-semibold text-zinc-400 hover:text-white transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingAlias}
                  className="px-4 py-2 text-xs font-semibold text-white bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 rounded-lg shadow-sm transition-colors cursor-pointer flex items-center gap-2"
                >
                  {savingAlias && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>{savingAlias ? 'Saving Rule…' : (editingAlias ? 'Save Changes' : 'Create Rule')}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
