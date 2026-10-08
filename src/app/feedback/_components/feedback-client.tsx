'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bug,
  Lightbulb,
  RefreshCw,
  MessageSquare,
  CheckCircle2,
  AlertCircle,
  ArrowLeft,
  Send,
  ShieldCheck,
  Terminal,
  Sparkles,
  HelpCircle,
  ChevronDown,
  User,
  Check,
} from 'lucide-react';
import { AppLogoMark } from '@/components/brand/logo';
import type { SessionPayload } from '@/lib/auth';

interface FeedbackClientProps {
  session: SessionPayload | null;
}

type CategoryType = 'bug' | 'feature' | 'sync_issue' | 'general';
type SeverityType = 'low' | 'normal' | 'high' | 'critical';

const CATEGORIES: {
  id: CategoryType;
  label: string;
  desc: string;
  icon: typeof Bug;
  activeColor: string;
  activeBorder: string;
}[] = [
  {
    id: 'bug',
    label: 'Bug / Glitch',
    desc: 'Broken UI, sync freeze, or error message',
    icon: Bug,
    activeColor: 'text-rose-400 bg-rose-500/15',
    activeBorder: 'border-rose-500/50 bg-rose-500/5',
  },
  {
    id: 'feature',
    label: 'Feature Request',
    desc: 'Ideas for new tools, filters, or improvements',
    icon: Lightbulb,
    activeColor: 'text-amber-400 bg-amber-500/15',
    activeBorder: 'border-amber-500/50 bg-amber-500/5',
  },
  {
    id: 'sync_issue',
    label: 'Drive / Shortlist',
    desc: 'Unmatched company or unparsed Excel attachment',
    icon: RefreshCw,
    activeColor: 'text-emerald-400 bg-emerald-500/15',
    activeBorder: 'border-emerald-500/50 bg-emerald-500/5',
  },
  {
    id: 'general',
    label: 'General Feedback',
    desc: 'Thoughts on the radar experience & design',
    icon: MessageSquare,
    activeColor: 'text-cyan-400 bg-cyan-500/15',
    activeBorder: 'border-cyan-500/50 bg-cyan-500/5',
  },
];

const SEVERITIES: { id: SeverityType; label: string; badgeClass: string }[] = [
  { id: 'low', label: 'Low', badgeClass: 'text-zinc-400 bg-zinc-800/80 border-zinc-700' },
  { id: 'normal', label: 'Normal', badgeClass: 'text-blue-400 bg-blue-500/15 border-blue-500/40' },
  { id: 'high', label: 'High', badgeClass: 'text-amber-400 bg-amber-500/15 border-amber-500/40' },
  { id: 'critical', label: 'Critical / Blocker', badgeClass: 'text-rose-400 bg-rose-500/15 border-rose-500/40' },
];

const FAQS = [
  {
    q: 'How frequently does email scanning run?',
    a: 'Email scanning runs automatically 24/7 every 15 minutes via our background sync engine, and can also be manually triggered anytime via the "Scan Now" button on your topbar.',
  },
  {
    q: 'What if a company shortlist Excel file was not parsed?',
    a: 'Choose "Drive / Shortlist" above and provide the company name and approximate email date. Our system will analyze the attachment structure and improve parsing rules.',
  },
  {
    q: 'Is my data and email access safe?',
    a: 'Yes. Where\'s My Offer uses Google OAuth strictly in read-only mode for placement-related messages. We never store raw non-placement emails, and access can be revoked instantly from Settings.',
  },
];

export default function FeedbackClient({ session }: FeedbackClientProps) {
  const [category, setCategory] = useState<CategoryType>('bug');
  const [severity, setSeverity] = useState<SeverityType>('normal');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [clientMetadata, setClientMetadata] = useState<Record<string, unknown>>({});
  const [showFaqs, setShowFaqs] = useState(!session); // Expand by default only if logged out
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setClientMetadata({
        path: window.location.pathname,
        referrer: document.referrer || 'direct',
        screen: `${window.innerWidth}x${window.innerHeight}`,
        userAgent: navigator.userAgent,
        os: getOSName(navigator.userAgent),
        browser: getBrowserName(navigator.userAgent),
      });
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) {
      setErrorMessage('Please fill in both a subject and a detailed description.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          severity,
          subject: subject.trim(),
          message: message.trim(),
          metadata: clientMetadata,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to submit feedback.');
      }

      setIsSuccess(true);
      setSubject('');
      setMessage('');
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'An unexpected error occurred. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 selection:bg-emerald-500/30 selection:text-emerald-200">
      {/* Background Ambience */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[700px] h-[350px] bg-gradient-to-b from-emerald-500/10 via-teal-500/5 to-transparent blur-3xl opacity-60" />
        <div className="absolute top-1/3 -right-40 w-[400px] h-[300px] bg-cyan-500/5 blur-3xl" />
      </div>

      {/* Top Navbar — Solid z-50 to eliminate any scroll/overlap bleed */}
      <header className="sticky top-0 z-50 border-b border-zinc-800/80 bg-[#09090b]/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <Link href="/" className="flex items-center gap-2 sm:gap-2.5 group shrink-0">
              <AppLogoMark size={28} className="transition-transform group-hover:scale-105 shrink-0" />
              <span className="font-bold text-xs sm:text-sm tracking-tight text-white group-hover:text-emerald-300 transition-colors truncate">
                Where&apos;s My Offer<span className="text-emerald-400 font-extrabold ml-0.5">?</span>
              </span>
            </Link>
            <span className="text-zinc-700 hidden sm:inline">/</span>
            <span className="text-xs font-mono text-zinc-400 hidden sm:inline">Feedback & Support</span>
          </div>

          <div className="flex items-center gap-3">
            {session ? (
              <Link
                href="/"
                className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-700 hover:text-white transition-all shadow-sm"
              >
                <ArrowLeft className="h-3.5 w-3.5 text-emerald-400" />
                <span>Dashboard</span>
              </Link>
            ) : (
              <Link
                href="/login"
                className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 transition-all shadow-sm"
              >
                <span>Sign In</span>
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6 sm:py-8 sm:px-6">
        {/* LOGGED IN: Sleek compact page header */}
        {session ? (
          <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-850 pb-5">
            <div>
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
                Feedback & Bug Reporting
              </h1>
              <p className="mt-1 text-xs sm:text-sm text-zinc-400">
                Help improve your placement radar. Reports are delivered directly to the engineering team.
              </p>
            </div>
            <Link
              href="/"
              className="hidden sm:inline-flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-2 text-xs font-semibold text-zinc-300 hover:border-zinc-700 hover:text-white transition-all shadow-sm"
            >
              <ArrowLeft className="h-3.5 w-3.5 text-emerald-400" />
              <span>Back to Radar</span>
            </Link>
          </div>
        ) : (
          /* LOGGED OUT: Informational Hero */
          <div className="text-center max-w-2xl mx-auto mb-8">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-mono text-emerald-400 mb-3 shadow-sm">
              <Sparkles className="h-3.5 w-3.5" />
              <span>Developer Feedback & Support Desk</span>
            </div>
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white mb-2.5">
              Help Us Perfect Your Placement Radar
            </h1>
            <p className="text-sm sm:text-base text-zinc-400 leading-relaxed">
              Spotted a glitch, have a feature suggestion, or found an unmatched shortlist attachment?
              Submit your feedback below and our engineering team will look into it directly.
            </p>
          </div>
        )}

        {/* LOGGED OUT STATE */}
        {!session ? (
          <div className="rounded-2xl border border-zinc-800/90 bg-zinc-900/60 p-6 sm:p-10 backdrop-blur-xl shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />

            <div className="max-w-xl mx-auto text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 border border-emerald-500/30 mb-5">
                <ShieldCheck className="h-7 w-7 text-emerald-400" />
              </div>

              <h2 className="text-xl sm:text-2xl font-bold text-white mb-3">
                Authentication Required to Submit
              </h2>
              <p className="text-sm text-zinc-400 leading-relaxed mb-6">
                To eliminate spam bots and automatically attach your verified student profile (so we know which drive or email triggered your inquiry), please sign in with Google first.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8 text-left">
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3.5">
                  <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200 mb-1">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                    Verified Identity
                  </div>
                  <p className="text-[11px] text-zinc-500 leading-relaxed">
                    Zero spam bots. Links feedback to your active student session.
                  </p>
                </div>
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3.5">
                  <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200 mb-1">
                    <Send className="h-3.5 w-3.5 text-cyan-400" />
                    Direct Developer Ping
                  </div>
                  <p className="text-[11px] text-zinc-500 leading-relaxed">
                    Instantly alerts the lead engineer with full issue context.
                  </p>
                </div>
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3.5">
                  <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200 mb-1">
                    <Terminal className="h-3.5 w-3.5 text-amber-400" />
                    Device Diagnostics
                  </div>
                  <p className="text-[11px] text-zinc-500 leading-relaxed">
                    Attaches browser and screen specs to replicate bugs quickly.
                  </p>
                </div>
              </div>

              <a
                href="/api/auth/google?type=personal"
                className="inline-flex items-center justify-center gap-3 rounded-xl bg-white px-6 py-3.5 text-sm font-semibold text-zinc-950 hover:bg-zinc-100 transition-all shadow-lg hover:shadow-white/10 group cursor-pointer"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
                <span>Sign in with Google to Continue</span>
              </a>
            </div>
          </div>
        ) : isSuccess ? (
          /* SUCCESS STATE */
          <div className="rounded-2xl border border-emerald-500/30 bg-zinc-900/70 p-8 sm:p-12 text-center backdrop-blur-xl shadow-2xl">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/15 border border-emerald-500/30 mb-5">
              <CheckCircle2 className="h-8 w-8 text-emerald-400" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">Feedback Dispatched!</h2>
            <p className="text-sm text-zinc-400 max-w-md mx-auto leading-relaxed mb-6">
              Your submission has been securely recorded and emailed directly to the developer desk. We review reports continuously to maintain peak radar performance.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setIsSuccess(false)}
                className="w-full sm:w-auto rounded-xl border border-zinc-700 bg-zinc-800 px-5 py-2.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 transition-colors cursor-pointer"
              >
                Submit Another Report
              </button>
              <Link
                href="/"
                className="w-full sm:w-auto rounded-xl bg-emerald-500 px-5 py-2.5 text-xs font-semibold text-black hover:bg-emerald-400 transition-colors"
              >
                Return to Radar Dashboard
              </Link>
            </div>
          </div>
        ) : (
          /* LOGGED IN FORM */
          <div className="rounded-2xl border border-zinc-800/90 bg-zinc-900/60 p-5 sm:p-7 backdrop-blur-xl shadow-2xl">
            {/* User Session Bar */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 mb-6">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-semibold text-sm">
                  {session.name ? session.name[0].toUpperCase() : <User className="h-4 w-4" />}
                </div>
                <div className="min-w-0 truncate">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-white truncate">{session.name || 'Student User'}</span>
                    <span className="shrink-0 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-mono text-emerald-400">
                      Verified Session
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-zinc-400 block truncate">{session.email}</span>
                </div>
              </div>
              <div className="text-[11px] font-mono text-zinc-500 flex items-center gap-1.5 shrink-0 self-start sm:self-auto">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
                <span>Context Auto-Attached</span>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Category Picker */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-300 mb-2">
                  Report Category
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {CATEGORIES.map((cat) => {
                    const Icon = cat.icon;
                    const isSelected = category === cat.id;
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => setCategory(cat.id)}
                        className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-all cursor-pointer ${
                          isSelected
                            ? `${cat.activeBorder} shadow-sm ring-1 ring-emerald-500/20`
                            : 'border-zinc-800/80 bg-zinc-950/40 hover:border-zinc-700 hover:bg-zinc-900/40'
                        }`}
                      >
                        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${cat.activeColor}`}>
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between">
                            <span className={`text-xs font-bold ${isSelected ? 'text-white' : 'text-zinc-300'}`}>
                              {cat.label}
                            </span>
                            {isSelected && <Check className="h-3.5 w-3.5 text-emerald-400" />}
                          </div>
                          <div className="text-[11px] text-zinc-500 truncate mt-0.5">{cat.desc}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Severity & Priority */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-300 mb-2">
                  Impact / Severity Level
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {SEVERITIES.map((sev) => {
                    const isSelected = severity === sev.id;
                    return (
                      <button
                        key={sev.id}
                        type="button"
                        onClick={() => setSeverity(sev.id)}
                        className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-all cursor-pointer text-center ${
                          isSelected
                            ? `${sev.badgeClass} ring-1 ring-emerald-500/30 font-bold`
                            : 'border-zinc-800 bg-zinc-950/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                        }`}
                      >
                        {sev.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Subject Input */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-300 mb-1.5">
                  Subject / Summary
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={
                    category === 'bug'
                      ? 'e.g., Shortlist modal not displaying candidate matches'
                      : category === 'sync_issue'
                      ? 'e.g., Company XYZ announcement not reflecting in radar'
                      : category === 'feature'
                      ? 'e.g., Add export button for filtered placement drives'
                      : 'e.g., Feedback on calendar schedule view'
                  }
                  maxLength={150}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950/70 px-3.5 py-2.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
                  required
                />
              </div>

              {/* Description Input */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                    Detailed Explanation
                  </label>
                  <span className="text-[11px] font-mono text-zinc-500">
                    {message.length} / 2500
                  </span>
                </div>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={4}
                  maxLength={2500}
                  placeholder="Describe the situation clearly. If reporting a bug or sync discrepancy, include company name, date, or steps to reproduce..."
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950/70 px-3.5 py-2.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 resize-y"
                  required
                />
              </div>

              {/* Auto Diagnostics Capsule */}
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3 text-[11px] font-mono text-zinc-500 flex items-center justify-between gap-2 min-w-0">
                <div className="flex items-center gap-2 overflow-hidden truncate min-w-0">
                  <Terminal className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span className="truncate">
                    Client: {String(clientMetadata.browser || 'Browser')} · {String(clientMetadata.os || 'OS')} · {String(clientMetadata.screen || 'Desktop')}
                  </span>
                </div>
                <span className="text-emerald-400 shrink-0 text-[10px] uppercase font-bold tracking-wider ml-auto">
                  Auto-Attached
                </span>
              </div>

              {/* Error Banner */}
              <AnimatePresence>
                {errorMessage && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300"
                  >
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{errorMessage}</span>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Submit Button */}
              <div className="pt-1 flex items-center justify-end gap-3">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-6 py-2.5 text-xs font-semibold text-black hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-md cursor-pointer"
                >
                  {isSubmitting ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      <span>Sending to Developer...</span>
                    </>
                  ) : (
                    <>
                      <Send className="h-3.5 w-3.5" />
                      <span>Submit Feedback Ticket</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* FAQs Accordion Section */}
        <div className="mt-8 rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 sm:p-6 backdrop-blur-md">
          <button
            type="button"
            onClick={() => setShowFaqs(!showFaqs)}
            className="flex w-full items-center justify-between text-left cursor-pointer group"
          >
            <div>
              <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-emerald-400 mb-1">
                <HelpCircle className="h-3.5 w-3.5" />
                <span>Frequently Asked Questions</span>
              </div>
              <h3 className="text-sm font-bold text-white group-hover:text-zinc-200 transition-colors">
                Common Inquiries & Radar FAQ
              </h3>
            </div>
            <ChevronDown
              className={`h-4 w-4 text-zinc-500 transition-transform duration-200 ${
                showFaqs ? 'rotate-180 text-emerald-400' : ''
              }`}
            />
          </button>

          <AnimatePresence>
            {showFaqs && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-4 space-y-2.5 pt-2 border-t border-zinc-800/60"
              >
                {FAQS.map((faq, idx) => {
                  const isOpen = expandedFaq === idx;
                  return (
                    <div
                      key={idx}
                      className="rounded-xl border border-zinc-800/70 bg-zinc-950/40 overflow-hidden transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => setExpandedFaq(isOpen ? null : idx)}
                        className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-semibold text-zinc-200 hover:text-white transition-colors cursor-pointer"
                      >
                        <span>{faq.q}</span>
                        <ChevronDown
                          className={`h-3.5 w-3.5 text-zinc-500 transition-transform duration-200 ${
                            isOpen ? 'rotate-180 text-emerald-400' : ''
                          }`}
                        />
                      </button>
                      <AnimatePresence>
                        {isOpen && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            className="border-t border-zinc-800/60 px-4 py-2.5 text-xs leading-relaxed text-zinc-400 bg-zinc-900/20"
                          >
                            {faq.a}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer info */}
        <footer className="mt-8 border-t border-zinc-800/70 pt-5 flex flex-col sm:flex-row items-center justify-between gap-3 font-mono text-[11px] text-zinc-600">
          <p>© 2026 Where&apos;s My Offer? · Dedicated Placement Support Desk</p>
          <div className="flex items-center justify-center gap-3 sm:gap-4 text-zinc-500 whitespace-nowrap text-[11px]">
            <Link href="/privacy" className="hover:text-zinc-300 transition-colors whitespace-nowrap">
              Privacy Policy
            </Link>
            <span>·</span>
            <Link href="/terms" className="hover:text-zinc-300 transition-colors whitespace-nowrap">
              Terms of Service
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
}

function getOSName(userAgent: string): string {
  if (/windows/i.test(userAgent)) return 'Windows';
  if (/macintosh|mac os x/i.test(userAgent)) return 'macOS';
  if (/linux/i.test(userAgent)) return 'Linux';
  if (/android/i.test(userAgent)) return 'Android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'iOS';
  return 'Unknown OS';
}

function getBrowserName(userAgent: string): string {
  if (/edg/i.test(userAgent)) return 'Edge';
  if (/chrome|crios/i.test(userAgent)) return 'Chrome';
  if (/firefox|fxios/i.test(userAgent)) return 'Firefox';
  if (/safari/i.test(userAgent)) return 'Safari';
  return 'Browser';
}
