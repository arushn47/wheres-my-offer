'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  AlertTriangle,
  Lock,
  ArrowLeft,
  ArrowUp,
  Mail,
  ExternalLink,
  Scale,
  XCircle,
  Sparkles,
  Shield,
  Clock,
} from 'lucide-react';
import { AppLogoMark } from '@/components/brand/logo';

const LAST_UPDATED = 'September 16, 2026';
const APP_NAME = "Where's My Offer?";
const APP_URL = 'https://www.wheresmyoffer.in';

function AnimatedSection({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.style.transitionDelay = `${delay}ms`;
          el.classList.add('opacity-100', 'translate-y-0');
          el.classList.remove('opacity-0', 'translate-y-6');
          observer.disconnect();
        }
      },
      { threshold: 0.08 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [delay]);

  return (
    <div
      ref={ref}
      className="opacity-0 translate-y-6 transition-all duration-700 ease-out"
    >
      {children}
    </div>
  );
}

export default function TermsClient() {
  const [showScrollTop, setShowScrollTop] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setShowScrollTop(window.scrollY > 300);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-300 selection:bg-emerald-500/20 font-sans overflow-x-hidden">
      {/* Ambient Background */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -top-32 -right-32 h-[500px] w-[500px] rounded-full bg-violet-500/[0.06] blur-[120px] animate-pulse" />
        <div className="absolute -bottom-32 -left-32 h-[600px] w-[600px] rounded-full bg-emerald-500/[0.05] blur-[140px]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[400px] w-[400px] rounded-full bg-teal-500/[0.03] blur-[100px]" />
        {/* Subtle grid */}
        <div
          className="absolute inset-0 opacity-[0.025]"
          style={{
            backgroundImage: `linear-gradient(rgba(16,185,129,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(16,185,129,0.5) 1px, transparent 1px)`,
            backgroundSize: '60px 60px',
          }}
        />
      </div>

      {/* Sticky Header */}
      <header className="sticky top-0 z-40 bg-[#09090b]/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 sm:px-8 py-3.5">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 group">
            <AppLogoMark size={36} className="transition-transform group-hover:scale-105" />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-display font-bold text-white text-sm sm:text-base tracking-tight">
                  {APP_NAME}
                </span>
                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-emerald-400 border border-emerald-500/20">
                  TERMS
                </span>
              </div>
              <p className="text-[10px] font-mono text-zinc-500">Placement Radar · Live</p>
            </div>
          </Link>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
              <Link
                href="/privacy"
                className="px-2.5 sm:px-3 py-1 text-xs font-semibold text-zinc-400 hover:text-white rounded-md transition-colors"
              >
                Privacy
              </Link>
              <span className="px-2.5 sm:px-3 py-1 text-xs font-semibold text-white bg-zinc-800 rounded-md shadow-sm">
                Terms
              </span>
            </div>
            <Link
              href="/"
              className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:text-white hover:bg-zinc-800 transition-all"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Back to App</span>
            </Link>
          </div>
        </div>
      </header>

      {/* Main Legal Content */}
      <main className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
        {/* Hero Header */}
        <AnimatedSection>
          <div className="mb-12">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs font-mono text-emerald-400 mb-5">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              TRANSPARENT TERMS · STUDENT PLATFORM
            </div>

            <h1 className="text-4xl sm:text-6xl font-black text-white tracking-tight mb-4 font-display leading-tight">
              Terms of{' '}
              <span className="bg-gradient-to-r from-emerald-400 to-teal-300 bg-clip-text text-transparent">
                Service
              </span>
            </h1>

            <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-zinc-400 mb-8">
              <span>
                Effective: <span className="text-zinc-200 font-semibold">{LAST_UPDATED}</span>
              </span>
              <span className="text-zinc-700">·</span>
              <span>Platform: {APP_NAME}</span>
              <span className="text-zinc-700">·</span>
              <span className="text-emerald-400 font-semibold">Clear &amp; Enforceable</span>
            </div>

            {/* Plain English TL;DR */}
            <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-950/20 via-[#101014]/90 to-[#0c1410]/90 backdrop-blur-md p-6 shadow-2xl shadow-emerald-950/20">
              <div className="flex items-center gap-2.5 mb-3 text-emerald-400 font-semibold text-sm font-display tracking-tight">
                <Sparkles className="h-4 w-4" />
                <span>The Plain-English Summary (The TL;DR)</span>
              </div>
              <p className="text-sm leading-relaxed text-zinc-300 mb-4">
                We designed <strong className="text-white">{APP_NAME}</strong> as a student companion to help you organize campus placement drives, track interview slots, and never miss an eligibility deadline. Here is the bottom line:
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-zinc-300">
                <div className="flex items-start gap-2 rounded-lg bg-zinc-900/60 p-3 border border-zinc-800/80">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span><strong>Personal companion:</strong> Use it to track your drives and applications. Please don&apos;t share accounts or scrape candidate data belonging to classmates.</span>
                </div>
                <div className="flex items-start gap-2 rounded-lg bg-zinc-900/60 p-3 border border-zinc-800/80">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span><strong>Always check official emails:</strong> We parse dates and links automatically, but official university circulars are always your ultimate source of truth.</span>
                </div>
                <div className="flex items-start gap-2 rounded-lg bg-zinc-900/60 p-3 border border-zinc-800/80">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span><strong>Respect the platform:</strong> Don&apos;t attempt to probe endpoints, spam the sync engine, or overload our background worker jobs.</span>
                </div>
                <div className="flex items-start gap-2 rounded-lg bg-zinc-900/60 p-3 border border-zinc-800/80">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span><strong>Your data, your call:</strong> You can wipe your account and all tracked entries with one click in Settings at any time.</span>
                </div>
              </div>
            </div>
          </div>
        </AnimatedSection>

        {/* Legal Sections */}
        <div className="space-y-6">
          {/* 1. Acceptance & Eligibility */}
          <AnimatedSection delay={40}>
            <section className="rounded-2xl border border-zinc-800/70 bg-[#101014]/80 backdrop-blur-sm p-6 sm:p-8 shadow-xl shadow-black/40 hover:border-zinc-700/60 transition-all duration-300">
              <div className="flex items-center gap-3 mb-5">
                <span className="font-mono text-xs font-bold text-emerald-400 tracking-wider border border-emerald-500/30 bg-emerald-500/10 rounded-lg px-2.5 py-1">01</span>
                <h2 className="text-lg font-bold text-white">Acceptance of Terms &amp; Eligibility</h2>
              </div>
              <p className="text-sm leading-relaxed text-zinc-400">
                By logging into or accessing {APP_NAME} (<a href={APP_URL} className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300 font-mono text-xs">{APP_URL}</a>), you agree to be bound by these Terms and our companion{' '}
                <Link href="/privacy" className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300 transition-colors">
                  Privacy Policy
                </Link>
                . To use the platform, you must be a current or prospective student of VIT Bhopal University (or affiliated VIT campuses) participating in campus placements. If you do not agree with these terms, you should not use the platform.
              </p>
            </section>
          </AnimatedSection>

          {/* 2. Nature of Service */}
          <AnimatedSection delay={60}>
            <section className="rounded-2xl border border-zinc-800/70 bg-[#101014]/80 backdrop-blur-sm p-6 sm:p-8 shadow-xl shadow-black/40 hover:border-zinc-700/60 transition-all duration-300">
              <div className="flex items-center gap-3 mb-5">
                <span className="font-mono text-xs font-bold text-emerald-400 tracking-wider border border-emerald-500/30 bg-emerald-500/10 rounded-lg px-2.5 py-1">02</span>
                <h2 className="text-lg font-bold text-white">The Service &amp; What It Does</h2>
              </div>
              <p className="text-sm leading-relaxed text-zinc-400 mb-4">
                {APP_NAME} is an automated personal productivity assistant that helps candidates organize incoming placement data into an intuitive visual command center:
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
                  <div className="flex items-center gap-2 font-semibold text-zinc-200 mb-1">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    Automated Email Parsing
                  </div>
                  <p className="text-zinc-400 text-[11px] leading-relaxed">
                    Indexes incoming CDC circulars and NeoPAT confirmation emails, extracting company names, job profiles, CTC packages, and deadlines.
                  </p>
                </div>

                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
                  <div className="flex items-center gap-2 font-semibold text-zinc-200 mb-1">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    Shortlist Verification
                  </div>
                  <p className="text-zinc-400 text-[11px] leading-relaxed">
                    Automatically scans attached PDF and Excel rosters to alert you the moment your candidate registration ID is shortlisted for subsequent rounds.
                  </p>
                </div>

                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
                  <div className="flex items-center gap-2 font-semibold text-zinc-200 mb-1">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    Timeline &amp; Calendar Sync
                  </div>
                  <p className="text-zinc-400 text-[11px] leading-relaxed">
                    Organizes your upcoming online tests, coding challenges, PPT sessions, and interview windows, with optional sync to Google Calendar.
                  </p>
                </div>

                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
                  <div className="flex items-center gap-2 font-semibold text-zinc-200 mb-1">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    Proactive Alerts
                  </div>
                  <p className="text-zinc-400 text-[11px] leading-relaxed">
                    Dispatches instant browser notifications when tests are commencing or urgent shortlists are released.
                  </p>
                </div>
              </div>
            </section>
          </AnimatedSection>

          {/* 3. Official Email Priority Disclaimer */}
          <AnimatedSection delay={80}>
            <section className="rounded-2xl border border-amber-500/30 bg-gradient-to-b from-[#141210]/90 to-[#0f0e0a]/90 backdrop-blur-sm p-6 sm:p-8 shadow-xl shadow-black/40 hover:border-amber-500/50 transition-all duration-300">
              <div className="flex items-center gap-3 mb-4">
                <AlertTriangle className="h-5 w-5 text-amber-400" />
                <h2 className="text-lg font-bold text-white">Important Campus Disclaimer — Official Emails Take Precedence</h2>
              </div>
              <p className="text-sm leading-relaxed text-zinc-300 mb-3">
                {APP_NAME} is an auxiliary companion engineered to assist you. However, campus recruitment drives move fast, and placement cells may alter assessment links, reporting halls, or interview schedules with short notice.
              </p>
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs text-amber-300/90 leading-relaxed font-mono">
                ⚠️ <strong>Golden Rule:</strong> Always cross-reference your actual inbox for official CDC emails before tests or interviews. {APP_NAME} does not guarantee that third-party servers, email deliverability, or university dispatch portals will remain error-free.
              </div>
            </section>
          </AnimatedSection>

          {/* 4. Acceptable Use */}
          <AnimatedSection delay={100}>
            <section className="rounded-2xl border border-zinc-800/70 bg-[#101014]/80 backdrop-blur-sm p-6 sm:p-8 shadow-xl shadow-black/40 hover:border-zinc-700/60 transition-all duration-300">
              <div className="flex items-center gap-3 mb-5">
                <span className="font-mono text-xs font-bold text-emerald-400 tracking-wider border border-emerald-500/30 bg-emerald-500/10 rounded-lg px-2.5 py-1">04</span>
                <h2 className="text-lg font-bold text-white">Community &amp; Acceptable Use Policy</h2>
              </div>
              <p className="text-sm leading-relaxed text-zinc-400 mb-4">
                To keep the service reliable, secure, and fair for all students, you agree not to:
              </p>

              <div className="space-y-2.5 text-xs text-zinc-300">
                {[
                  'Attempt to access, crawl, or scrape data belonging to any other candidate or student.',
                  'Abuse, hammer, or flood API routes or background sync mechanisms beyond standard user limits.',
                  'Probe, scan, or test the vulnerability of the system without explicit developer authorization.',
                  'Share your authenticated account with unauthorized parties or use dummy profiles to bypass quotas.',
                  'Use automated bots or crawlers to manipulate application statuses or simulate fake accounts.',
                ].map((rule, i) => (
                  <div key={i} className="flex items-start gap-2.5 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3 hover:border-zinc-700/60 transition-colors">
                    <XCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
                    <span>{rule}</span>
                  </div>
                ))}
              </div>
            </section>
          </AnimatedSection>

          {/* 5. Google Permissions & Revocation */}
          <AnimatedSection delay={120}>
            <section className="rounded-2xl border border-zinc-800/70 bg-[#101014]/80 backdrop-blur-sm p-6 sm:p-8 shadow-xl shadow-black/40 hover:border-zinc-700/60 transition-all duration-300">
              <div className="flex items-center gap-3 mb-5">
                <span className="font-mono text-xs font-bold text-emerald-400 tracking-wider border border-emerald-500/30 bg-emerald-500/10 rounded-lg px-2.5 py-1">05</span>
                <h2 className="text-lg font-bold text-white">Google OAuth &amp; API Permissions</h2>
              </div>
              <p className="text-sm leading-relaxed text-zinc-400 mb-4">
                {APP_NAME} interacts with Google APIs under the explicit scopes you grant upon signing in:
              </p>

              <div className="space-y-2.5 mb-4 text-xs">
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-mono font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                      gmail.readonly
                    </span>
                    <span className="font-mono text-zinc-500 text-[10px]">Restricted Scope</span>
                  </div>
                  <p className="text-zinc-400 leading-relaxed">
                    Used strictly to detect and parse placement correspondence from recognized campus senders. We never alter, delete, or compose emails.
                  </p>
                </div>

                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-mono font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                      calendar.events.owned
                    </span>
                    <span className="font-mono text-zinc-500 text-[10px]">Optional Scope</span>
                  </div>
                  <p className="text-zinc-400 leading-relaxed">
                    Used strictly to place scheduled recruitment rounds and assessments onto your personal Google Calendar.
                  </p>
                </div>
              </div>

              <p className="text-xs text-zinc-400 leading-relaxed">
                You can revoke access anytime through your{' '}
                <a
                  href="https://myaccount.google.com/permissions"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300 inline-flex items-center gap-1 font-mono text-[11px] transition-colors"
                >
                  Google Account Permissions <ExternalLink className="h-3 w-3 inline" />
                </a>
                .
              </p>
            </section>
          </AnimatedSection>

          {/* 6. Limitation of Liability */}
          <AnimatedSection delay={140}>
            <section className="rounded-2xl border border-zinc-800/70 bg-[#101014]/80 backdrop-blur-sm p-6 sm:p-8 shadow-xl shadow-black/40 hover:border-zinc-700/60 transition-all duration-300">
              <div className="flex items-center gap-3 mb-5">
                <Scale className="h-5 w-5 text-emerald-400" />
                <h2 className="text-lg font-bold text-white">Limitation of Liability &amp; Warranty</h2>
              </div>
              <p className="text-sm leading-relaxed text-zinc-400 mb-3">
                {APP_NAME} is provided &quot;as is&quot; and &quot;as available&quot; without warranties of any kind, whether express or implied. To the maximum extent permitted by applicable law, the developers and contributors shall not be liable for any indirect, incidental, special, or consequential damages resulting from:
              </p>
              <ul className="space-y-1.5 text-xs text-zinc-400 list-disc list-inside ml-2">
                <li>Missed assessments, interview rounds, or deadline submissions.</li>
                <li>Temporary service outages, cloud maintenance, or network connectivity failures.</li>
                <li>Inaccuracies originating from malformed email bodies or third-party format changes.</li>
              </ul>
            </section>
          </AnimatedSection>

          {/* 7. Termination & Deletion */}
          <AnimatedSection delay={160}>
            <section className="rounded-2xl border border-zinc-800/70 bg-[#101014]/80 backdrop-blur-sm p-6 sm:p-8 shadow-xl shadow-black/40 hover:border-zinc-700/60 transition-all duration-300">
              <div className="flex items-center gap-3 mb-4">
                <Lock className="h-5 w-5 text-emerald-400" />
                <h2 className="text-lg font-bold text-white">Account Deletion &amp; Data Wipe</h2>
              </div>
              <p className="text-sm leading-relaxed text-zinc-400 mb-3">
                You can delete your account and completely erase all stored emails, company profiles, and application statuses whenever you choose:
              </p>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-white">Self-Service Immediate Deletion</p>
                  <p className="text-[11px] text-zinc-500 font-mono">Irreversibly deletes your account from our PostgreSQL database.</p>
                </div>
                <Link
                  href="/settings"
                  className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/20 transition-colors whitespace-nowrap"
                >
                  Settings → Danger Zone →
                </Link>
              </div>
            </section>
          </AnimatedSection>

          {/* 8. Contact & Feedback */}
          <AnimatedSection delay={180}>
            <section className="rounded-2xl border border-zinc-800/70 bg-[#101014]/80 backdrop-blur-sm p-6 sm:p-8 shadow-xl shadow-black/40 hover:border-zinc-700/60 transition-all duration-300">
              <div className="flex items-center gap-3 mb-4">
                <Mail className="h-5 w-5 text-emerald-400" />
                <h2 className="text-lg font-bold text-white">Questions &amp; Contact Desk</h2>
              </div>
              <p className="text-sm leading-relaxed text-zinc-400 mb-4">
                If you have questions about these Terms, need support, or wish to suggest improvements, our student team is always open to feedback:
              </p>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-white">{APP_NAME} Team</p>
                  <p className="text-[11px] text-zinc-500 font-mono">VIT Bhopal University · Student Project</p>
                </div>
                <Link
                  href="/feedback"
                  className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                >
                  <span>Open Feedback &amp; Support →</span>
                </Link>
              </div>
            </section>
          </AnimatedSection>
        </div>

        {/* Footer */}
        <AnimatedSection delay={200}>
          <div className="mt-16 pt-8 border-t border-zinc-800/60 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs font-mono text-zinc-500">
            <p>© {new Date().getFullYear()} {APP_NAME}. Built for students, with fairness and transparency.</p>
            <div className="flex items-center justify-center gap-3 sm:gap-4 whitespace-nowrap text-[11px]">
              <Link href="/privacy" className="hover:text-zinc-200 transition-colors whitespace-nowrap">
                Privacy Policy
              </Link>
              <span className="text-zinc-700">·</span>
              <Link href="/feedback" className="hover:text-zinc-200 transition-colors whitespace-nowrap">
                Feedback &amp; Support
              </Link>
            </div>
          </div>
        </AnimatedSection>
      </main>

      {/* Floating Scroll to Top */}
      <button
        type="button"
        onClick={scrollToTop}
        aria-label="Scroll to top"
        title="Scroll to top"
        className={`fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-zinc-700/80 bg-zinc-900/90 text-zinc-300 shadow-2xl backdrop-blur-md transition-all duration-300 hover:border-emerald-500/50 hover:bg-zinc-800 hover:text-white active:scale-95 cursor-pointer ${
          showScrollTop ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 translate-y-4 pointer-events-none'
        }`}
      >
        <ArrowUp className="h-5 w-5" />
      </button>
    </div>
  );
}
