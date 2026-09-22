'use client';

import { useState, useMemo, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  Search as SearchIcon,
  Building2,
  Calendar,
  Mail,
  Sparkles,
  X,
  MapPin,
  ArrowUpRight,
} from 'lucide-react';
import { cn, timeAgo, formatStipend } from '@/lib/utils';
import { StatusChip } from '@/components/ui/status-chip';
import { DriveModeBadge } from '@/components/ui/drive-mode-badge';
import { cleanRoleTitle, cleanEventTitle } from '@/lib/sync/events';
import { cleanLocationString } from '@/lib/sync/locations';

export interface SearchCompanyItem {
  id: string;
  driveId?: string | null;
  appId?: string | null;
  name: string;
  aliases: string[] | null;
  driveNumber: string | null;
  driveName: string | null;
  role: string | null;
  category: string | null;
  ctc: string | null;
  stipend: string | null;
  location: string | null;
  notes: string | null;
  driveMode: string;
  status: string;
  statusLabel?: string;
  isMultiDrive?: boolean;
}

export interface SearchData {
  companies: SearchCompanyItem[];
  emails: {
    id: string;
    driveId?: string | null;
    subject: string;
    sender: string;
    receivedAt: string;
    companyId: string | null;
    companyName: string | null;
    snippet: string;
  }[];
  events: {
    id: string;
    driveId?: string | null;
    title: string | null;
    eventType: string;
    startTime: string | null;
    venue: string | null;
    mode?: string | null;
    companyId: string;
    companyName: string;
  }[];
}

interface SearchClientProps {
  data: SearchData;
}

export default function SearchClient({ data }: SearchClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState('');

  // Restore query on mount from URL params or sessionStorage
  useEffect(() => {
    try {
      const urlQ = searchParams.get('q') || searchParams.get('search');
      const savedQ = urlQ !== null ? urlQ : sessionStorage.getItem('wmo_global_search');
      if (savedQ && !query) {
        setQuery(savedQ);
      }
    } catch {}
  }, []);

  // Debounced URL and sessionStorage sync
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (query.trim()) {
          sessionStorage.setItem('wmo_global_search', query.trim());
        } else {
          sessionStorage.removeItem('wmo_global_search');
        }
      } catch {}

      const params = new URLSearchParams(searchParams.toString());
      const currentQ = params.get('q') || params.get('search') || '';
      if (query.trim() !== currentQ.trim()) {
        if (query.trim()) {
          params.set('q', query.trim());
          params.delete('search');
        } else {
          params.delete('q');
          params.delete('search');
        }
        const qs = params.toString();
        router.replace(qs ? `/search?${qs}` : '/search', { scroll: false });
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  const handleClear = () => {
    setQuery('');
    try {
      sessionStorage.removeItem('wmo_global_search');
    } catch {}
    const params = new URLSearchParams(searchParams.toString());
    params.delete('q');
    params.delete('search');
    const qs = params.toString();
    router.replace(qs ? `/search?${qs}` : '/search', { scroll: false });
  };

  const results = useMemo(() => {
    if (!query.trim()) {
      return {
        companies: [],
        emails: [],
        events: [],
      };
    }

    const qRaw = query.toLowerCase().trim();
    // Compact version: remove spaces, dashes, commas, underscores, slashes (enables 12lpa matching 12 LPA)
    const qCompact = qRaw.replace(/[\s\-_,\/]/g, '');
    const qTokens = qRaw.split(/\s+/).filter(Boolean);

    const matchedCompanies = data.companies.filter((c) => {
      const aliasesStr = (c.aliases || []).join(' ');
      const fullCorpus = [
        c.name,
        aliasesStr,
        c.role || '',
        c.ctc || '',
        c.stipend || '',
        c.category || '',
        c.location || '',
        c.driveMode || '',
        c.driveNumber || '',
        c.driveName || '',
        c.status,
        c.statusLabel || '',
        c.notes || '',
      ].join(' ').toLowerCase();

      const fullCorpusCompact = fullCorpus.replace(/[\s\-_,\/]/g, '');
      if (fullCorpusCompact.includes(qCompact)) return true;

      // Tokenized search: every token must match somewhere in the company corpus
      return qTokens.every((token) => {
        const tokenCompact = token.replace(/[\s\-_,\/]/g, '');
        return fullCorpus.includes(token) || (tokenCompact.length > 0 && fullCorpusCompact.includes(tokenCompact));
      });
    });

    const matchedEmails = data.emails.filter((e) => {
      const emailCorpus = [
        e.subject,
        e.sender,
        e.snippet,
        e.companyName || '',
      ].join(' ').toLowerCase();
      const emailCompact = emailCorpus.replace(/[\s\-_,\/]/g, '');

      if (emailCompact.includes(qCompact)) return true;
      return qTokens.every((token) => {
        const tokenCompact = token.replace(/[\s\-_,\/]/g, '');
        return emailCorpus.includes(token) || (tokenCompact.length > 0 && emailCompact.includes(tokenCompact));
      });
    });

    const matchedEvents = data.events.filter((ev) => {
      const eventCorpus = [
        ev.title || '',
        ev.eventType.replace('_', ' '),
        ev.venue || '',
        ev.mode || '',
        ev.companyName,
      ].join(' ').toLowerCase();
      const eventCompact = eventCorpus.replace(/[\s\-_,\/]/g, '');

      if (eventCompact.includes(qCompact)) return true;
      return qTokens.every((token) => {
        const tokenCompact = token.replace(/[\s\-_,\/]/g, '');
        return eventCorpus.includes(token) || (tokenCompact.length > 0 && eventCompact.includes(tokenCompact));
      });
    });

    return {
      companies: matchedCompanies,
      emails: matchedEmails,
      events: matchedEvents,
    };
  }, [query, data]);

  const totalResults =
    results.companies.length + results.emails.length + results.events.length;

  return (
    <div className="space-y-6 max-w-7xl mx-auto animate-fade-in selection:bg-emerald-500/20">
      {/* Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight flex items-center gap-2.5 font-display">
          <SearchIcon className="w-6 h-6 text-emerald-400" />
          <span>Global Search</span>
        </h1>
        <p className="text-xs sm:text-sm text-zinc-400 mt-1">
          Instantly search across tracked company drives, CTCs, drive modes, job roles, venues, and official circulars.
        </p>
      </div>

      {/* Luxury Search Input */}
      <div className="relative">
        <SearchIcon className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input
          type="text"
          autoFocus
          placeholder="Search company, CTC (12 LPA / 12lpa), drive mode (Online / VIT Vellore), role, venue, or circular..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full pl-12 pr-12 py-3.5 bg-[#101018]/90 backdrop-blur-xl border border-zinc-800 focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20 rounded-2xl text-sm sm:text-base text-white placeholder:text-zinc-500 shadow-xl shadow-black/20 transition-all outline-none"
        />
        {query && (
          <button
            onClick={handleClear}
            className="absolute right-4 top-1/2 -translate-y-1/2 p-1 rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800 transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Results summary */}
      {query.trim() && (
        <div className="text-xs font-mono text-zinc-400">
          Found <span className="text-emerald-400 font-bold">{totalResults}</span> {totalResults === 1 ? 'match' : 'matches'} for &ldquo;{query}&rdquo;
        </div>
      )}

      {/* Empty Initial State */}
      {!query.trim() && (
        <div className="p-14 text-center bg-[#101018]/90 border border-zinc-800/80 rounded-3xl">
          <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-3 text-zinc-600">
            <Sparkles className="w-6 h-6 text-emerald-400/80" />
          </div>
          <p className="text-zinc-200 font-bold text-base">Search Anything in Where&apos;s My Offer<span className="text-emerald-400">?</span></p>
          <p className="text-xs text-zinc-500 mt-1 max-w-md mx-auto">
            Try searching for company names (&ldquo;Google&rdquo;), CTCs (&ldquo;12 LPA&rdquo; or &ldquo;12lpa&rdquo;), drive modes (&ldquo;VIT Vellore&rdquo;, &ldquo;Online&rdquo;), roles (&ldquo;SDE&rdquo;), or venues.
          </p>
        </div>
      )}

      {/* Companies Results */}
      {results.companies.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
            <Building2 className="w-3.5 h-3.5 text-emerald-400" />
            Companies & Placement Drives ({results.companies.length})
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
            {results.companies.map((c) => {
              const cleanedRole = cleanRoleTitle(c.role);
              const roleDisplay = cleanedRole || 'Campus Placement Drive';
              const stipendDisplay = formatStipend(c.stipend);
              const ctcDisplay = c.ctc
                ? c.ctc.replace(/\*/g, '').trim()
                : stipendDisplay || 'TBA';
              const loc = cleanLocationString(c.location);
              const cleanCategory = c.category ? c.category.replace(/\b(internship|offer|placement|drive)\b/gi, '').replace(/\s*\/\s*/g, ' ').replace(/\s+/g, ' ').trim() : '';

              const driveQuery = c.driveId ? `?driveId=${c.driveId}` : '';

              return (
                <Link
                  key={`${c.id}-${c.driveId || ''}`}
                  href={`/companies/${c.id}${driveQuery}`}
                  className="flex flex-col justify-between p-4 bg-[#101018]/90 backdrop-blur-xl border border-zinc-800/80 hover:border-emerald-500/40 rounded-2xl transition-all duration-200 hover:-translate-y-0.5 group shadow-sm min-w-0"
                >
                  {/* Top: Avatar, Name, Drive Number, Category, Status */}
                  <div className="flex items-start justify-between gap-3 min-w-0">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <div className="w-10 h-10 rounded-xl bg-zinc-900 border border-zinc-800 group-hover:border-emerald-500/30 flex items-center justify-center font-extrabold text-emerald-400 text-sm shrink-0 font-display transition-colors">
                        {c.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <h3 className="text-sm font-bold text-white group-hover:text-emerald-300 transition-colors truncate">
                            {c.name}
                          </h3>
                          {c.isMultiDrive && c.driveNumber && (
                            <span className="rounded-md bg-zinc-800/90 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-400 border border-emerald-500/20 shrink-0">
                              {(() => {
                                const m = c.driveNumber.match(/\d+$/);
                                return m ? `#${m[0]}` : c.driveNumber;
                              })()}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-zinc-400 truncate mt-0.5">
                          <span className="truncate" title={roleDisplay}>{roleDisplay}</span>
                          {cleanCategory && (
                            <>
                              <span className="text-zinc-600 shrink-0">·</span>
                              <span className="text-zinc-500 font-medium shrink-0">{cleanCategory}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0">
                      <StatusChip status={c.status} label={c.statusLabel} size="sm" />
                    </div>
                  </div>

                  {/* Bottom: Compensation, Location, Drive Mode Badge */}
                  <div className="mt-3.5 pt-2.5 border-t border-zinc-800/60 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-zinc-400 min-w-0">
                    <span className="font-mono text-xs font-bold text-zinc-100 shrink-0">
                      {ctcDisplay}
                    </span>
                    {loc && loc !== 'Not Specified' && (
                      <span className="flex items-center gap-1 text-zinc-400 shrink-0 max-w-[170px] truncate" title={loc}>
                        <MapPin className="h-3 w-3 text-zinc-500 shrink-0" />
                        <span className="truncate">{loc}</span>
                      </span>
                    )}
                    <div className="ml-auto shrink-0">
                      <DriveModeBadge driveMode={c.driveMode} />
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Events Results */}
      {results.events.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
            <Calendar className="w-3.5 h-3.5 text-emerald-400" />
            Events & Schedules ({results.events.length})
          </h2>
          <div className="space-y-2">
            {results.events.map((evt) => (
              <Link
                key={evt.id}
                href={`/companies/${evt.companyId}${evt.driveId ? `?driveId=${evt.driveId}` : ''}`}
                className="flex items-center justify-between gap-3 p-3.5 sm:p-4 bg-[#101018]/90 border border-zinc-800/80 hover:border-emerald-500/40 rounded-2xl transition-all group min-w-0"
              >
                <div className="min-w-0 flex-1">
                  <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider block truncate">
                    {evt.companyName} · {evt.eventType.replace('_', ' ')}
                  </span>
                  <h4 className="text-sm font-bold text-white mt-0.5 truncate">
                    {cleanEventTitle(evt.title, evt.companyName, evt.eventType.replace(/_/g, ' '))}
                  </h4>
                </div>
                <div className="text-right text-xs text-zinc-500 shrink-0">
                  {evt.startTime && (
                    <span className="font-mono block text-zinc-300">{new Date(evt.startTime).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  )}
                  {evt.venue && <p className="text-[11px] text-zinc-400 truncate max-w-[140px] sm:max-w-[200px]" title={evt.venue}>{evt.venue}</p>}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Emails Results */}
      {results.emails.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
            <Mail className="w-3.5 h-3.5 text-emerald-400" />
            Synced CDC Circulars ({results.emails.length})
          </h2>
          <div className="space-y-2">
            {results.emails.map((em) => (
              <div key={em.id} className="p-4 bg-[#101018]/90 border border-zinc-800/80 rounded-2xl">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-xs font-semibold text-emerald-400 truncate">{em.sender}</span>
                  <span suppressHydrationWarning className="text-[11px] text-zinc-500 font-mono">{timeAgo(em.receivedAt)}</span>
                </div>
                <h4 className="text-sm font-bold text-white">{em.subject}</h4>
                <p className="text-xs text-zinc-400 mt-1 line-clamp-2 leading-relaxed">{em.snippet}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

