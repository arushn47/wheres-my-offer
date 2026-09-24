'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { motion, useMotionValue, useSpring } from 'framer-motion';
import Lenis from 'lenis';
import { cn } from '@/lib/utils';
import { AppLogo, AppLogoMark } from '@/components/brand/logo';
import {
  Radar,
  ShieldCheck,
  Lock,
  Server,
  ArrowRight,
  FileSpreadsheet,
  Mail,
  Inbox,
  CheckCheck,
  Zap,
  AlertCircle,
} from 'lucide-react';

const FEED = [
  { t: '09:41:02', text: 'gmail/personal → fetching page 2 of 5 …', tone: 'text-zinc-500' },
  { t: '09:41:04', text: 'attachment found: Amazon_OA_Shortlist.xlsx (14.2 MB)', tone: 'text-amber-300' },
  { t: '09:41:06', text: 'excel.scan("21BCE0492") → row 1,847 · MATCH', tone: 'text-violet-300' },
  { t: '09:41:06', text: 'AMAZON status → SHORTLISTED', tone: 'text-emerald-300' },
  { t: '09:41:09', text: 'circular: Razorpay OA window opens 6:00 PM today', tone: 'text-zinc-400' },
  { t: '09:41:09', text: 'calendar.sync → "Razorpay Online Assessment" created', tone: 'text-sky-300' },
  { t: '09:41:12', text: 'gmail/college → 12 new CDC circulars queued', tone: 'text-zinc-500' },
  { t: '09:41:15', text: 'all inboxes caught up · next sweep in 60s', tone: 'text-emerald-400' },
];

const MARQUEE = [
  'GOLDMAN SACHS',
  'AMAZON',
  'MICROSOFT',
  'D.E. SHAW',
  'J.P. MORGAN',
  'RAZORPAY',
  'CRED',
  'TEXAS INSTRUMENTS',
  'MYNTRA',
  'WELLS FARGO',
  'ATLASSIAN',
  'ADOBE',
];

const ERROR_MESSAGES: Record<string, string> = {
  no_code: 'Google authentication was cancelled. Please try again.',
  no_email: 'Could not retrieve your email address from Google.',
  db_error: 'Unable to initialize user session in database. Please retry.',
  auth_failed: 'Authentication failed. Please verify your Google account.',
  college_as_primary:
    'Please sign in with your Personal Gmail address (where NeoPAT registration emails arrive). You will connect your VIT College email in the next step.',
};

const Reveal = ({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) => (
  <span className={`block overflow-hidden ${className}`}>
    <motion.span
      className="block"
      initial={{ y: '112%' }}
      animate={{ y: 0 }}
      transition={{ duration: 1, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.span>
  </span>
);

const GoogleMark = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
    <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z" />
  </svg>
);

const TerminalCard = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState([FEED[0]]);
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const srx = useSpring(rx, { stiffness: 120, damping: 18 });
  const sry = useSpring(ry, { stiffness: 120, damping: 18 });

  useEffect(() => {
    let i = 0;
    setLines([FEED[0]]);
    const id = setInterval(() => {
      i += 1;
      setLines((prev) => [...prev.slice(-6), FEED[i % FEED.length]]);
    }, 1500);
    return () => clearInterval(id);
  }, []);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    ry.set(((e.clientX - r.left) / r.width - 0.5) * 10);
    rx.set(-((e.clientY - r.top) / r.height - 0.5) * 8);
  };

  return (
    <div style={{ perspective: 1200 }} className="relative w-full max-w-full overflow-hidden sm:overflow-visible">
      <div className="absolute -inset-4 sm:-inset-8 rounded-full bg-emerald-500/10 blur-2xl sm:blur-3xl pointer-events-none" />
      <motion.div
        ref={ref}
        onMouseMove={onMove}
        onMouseLeave={() => {
          rx.set(0);
          ry.set(0);
        }}
        style={{ rotateX: srx, rotateY: sry, transformStyle: 'preserve-3d' }}
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.1, delay: 0.55, ease: [0.16, 1, 0.3, 1] }}
        className="scanline relative overflow-hidden rounded-2xl border border-zinc-800 bg-[#0d0f14]/95 shadow-2xl shadow-black/60 w-full max-w-full"
        data-testid="sync-terminal"
      >
        <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 sm:px-4 py-2.5 sm:py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70 shrink-0" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70 shrink-0" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70 shrink-0" />
          <span className="ml-2 sm:ml-3 font-mono text-[10px] sm:text-[11px] text-zinc-500 truncate max-w-[150px] sm:max-w-none">
            wmo://sync-engine — live
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-emerald-300">
            <span className="h-1 w-1 animate-pulse rounded-full bg-emerald-400" /> parsing
          </span>
        </div>
        <div className="h-56 sm:h-64 space-y-2 sm:space-y-2.5 overflow-hidden px-3 sm:px-4 py-3 sm:py-4 font-mono text-[10px] leading-relaxed sm:text-xs">
          {lines.map((l, i) => (
            <motion.div
              key={`${l.t}-${i}-${l.text}`}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3 }}
              className="flex gap-2 sm:gap-3 min-w-0"
            >
              <span className="shrink-0 text-zinc-600">{l.t}</span>
              <span className={cn('truncate sm:break-normal min-w-0 flex-1', l.tone)}>{l.text}</span>
            </motion.div>
          ))}
          <span className="cursor-blink text-emerald-400">▍</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800/80 px-3 sm:px-4 py-2.5 sm:py-3 font-mono text-[9px] sm:text-[10px] text-zinc-500">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <CheckCheck className="h-3 w-3 text-emerald-400 shrink-0" /> personal
            </span>
            <span className="flex items-center gap-1">
              <CheckCheck className="h-3 w-3 text-emerald-400 shrink-0" /> college
            </span>
          </div>
          <span className="flex items-center gap-1 text-violet-300">
            <FileSpreadsheet className="h-3 w-3 shrink-0" /> excel scanner armed
          </span>
        </div>
      </motion.div>

      <motion.div
        animate={{ y: [0, -10, 0] }}
        transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
        className="absolute -right-3 -top-6 hidden rounded-xl border border-violet-500/30 bg-[#12101a]/95 px-4 py-3 shadow-xl backdrop-blur-md sm:block"
        style={{ transform: 'translateZ(50px)' }}
      >
        <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">status flip</div>
        <div className="mt-1 flex items-center gap-2 text-xs font-semibold text-zinc-200">
          AMAZON <ArrowRight className="h-3 w-3 text-zinc-600" /> <span className="text-violet-300">SHORTLISTED</span>
        </div>
      </motion.div>

      <motion.div
        animate={{ y: [0, 8, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
        className="absolute -bottom-5 -left-4 hidden rounded-xl border border-amber-500/30 bg-[#14110a]/95 px-4 py-3 shadow-xl backdrop-blur-md sm:block"
      >
        <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">next event</div>
        <div className="mt-1 flex items-center gap-2 text-xs font-semibold text-zinc-200">
          <Zap className="h-3 w-3 text-amber-400" /> Razorpay OA · <span className="font-tabular text-amber-300">in 4 hrs</span>
        </div>
      </motion.div>
    </div>
  );
};

const chapters = [
  {
    n: '01',
    title: 'The Inbox Chaos',
    copy: 'Placement season fires 30+ emails a day at you — across two Gmail accounts. Official registrations land on personal mail. Test links and CDC circulars land on college mail. Miss one, miss a drive.',
    visual: (
      <div className="space-y-2">
        {[
          { from: 'cdc@vit.ac.in', sub: '[URGENT] Razorpay OA — tonight 6 PM', tone: 'text-amber-300', hot: true },
          { from: 'noreply@amazon.jobs', sub: 'Your application confirmation', tone: 'text-zinc-400' },
          { from: 'cdc@vit.ac.in', sub: 'FW: Revised PPT schedule — 14 circulars', tone: 'text-zinc-400' },
          { from: 'placements@...', sub: 'Shortlist_R2_FINAL_v3 (1).xlsx', tone: 'text-violet-300', hot: true },
        ].map((m, i) => (
          <div
            key={i}
            className={`flex items-center gap-2 sm:gap-3 rounded-lg border px-2.5 sm:px-3 py-2 sm:py-2.5 font-mono text-[10px] sm:text-[11px] min-w-0 overflow-hidden ${
              m.hot ? 'border-zinc-700 bg-zinc-900' : 'border-zinc-800/60 bg-zinc-900/40'
            }`}
          >
            <Mail className={`h-3.5 w-3.5 shrink-0 ${m.hot ? 'text-amber-400' : 'text-zinc-600'}`} />
            <span className="w-24 sm:w-32 shrink-0 truncate text-zinc-500">{m.from}</span>
            <span className={`truncate min-w-0 flex-1 ${m.tone}`}>{m.sub}</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    n: '02',
    title: 'The Excel Agony',
    copy: "Every shortlist is a 15 MB spreadsheet with 4,000 roll numbers. On your phone. Outside an exam hall. Where's My Offer? scans every attachment the second it lands and flips your status automatically.",
    visual: (
      <div className="overflow-x-auto rounded-lg border border-zinc-800 font-mono text-[10px] sm:text-[11px]">
        <div className="grid grid-cols-4 min-w-[280px] gap-px bg-zinc-800/70 text-zinc-500">
          {['NEO ID', 'NAME', 'BRANCH', 'STATUS'].map((h) => (
            <div key={h} className="bg-[#0d0f14] px-2.5 sm:px-3 py-1.5 text-[8px] sm:text-[9px] tracking-widest">
              {h}
            </div>
          ))}
          {['23BCE10811', '23BCE10933', '23BCE10472', '23BCE11207'].map((id, i) => (
            <div key={id} className="contents">
              <div
                className={`px-2.5 sm:px-3 py-2 ${
                  id === '23BCE10472' ? 'bg-violet-500/15 text-violet-300' : 'bg-[#0b0d11] text-zinc-500'
                }`}
              >
                {id}
              </div>
              <div
                className={`px-2.5 sm:px-3 py-2 ${
                  id === '23BCE10472' ? 'bg-violet-500/15 text-zinc-200' : 'bg-[#0b0d11] text-zinc-600'
                }`}
              >
                {['K. Iyer', 'S. Menon', 'Arush N.', 'R. Das'][i]}
              </div>
              <div
                className={`px-2.5 sm:px-3 py-2 ${
                  id === '23BCE10472' ? 'bg-violet-500/15 text-zinc-300' : 'bg-[#0b0d11] text-zinc-600'
                }`}
              >
                CSE
              </div>
              <div
                className={`px-2.5 sm:px-3 py-2 ${
                  id === '23BCE10472' ? 'bg-violet-500/15 font-bold text-violet-300' : 'bg-[#0b0d11] text-zinc-600'
                }`}
              >
                {id === '23BCE10472' ? 'MATCH ✓' : '—'}
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    n: '03',
    title: 'The Parser Engine',
    copy: 'A recency-first sync engine reads every circular the moment it arrives — extracting dates, venues, deadlines and eligibility — then writes them straight onto your calendar.',
    visual: (
      <div className="space-y-2 rounded-lg border border-zinc-800 bg-[#0b0d11] p-3 sm:p-3.5 font-mono text-[10px] sm:text-[11px] min-w-0 overflow-hidden">
        <div className="text-zinc-500 truncate">$ wmo parse --inbox college --latest</div>
        <div className="text-zinc-400 truncate">→ circular: "TI Digital Design — R1 interview"</div>
        <div className="text-sky-300 truncate">→ extracted: venue=TT Lab 1 · report=8:30 AM</div>
        <div className="text-emerald-300">→ calendar event created ✓</div>
      </div>
    ),
  },
  {
    n: '04',
    title: 'The Offer Radar',
    copy: "One canonical pipeline across every drive on campus. No more 'did I apply?' — just open the radar and know exactly where you stand, from registration to offer letter.",
    visual: (
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
        {['Applied', 'Shortlisted', 'Test', 'Interview', 'Offer'].map((s, i) => (
          <div key={s} className="flex items-center gap-1.5 sm:gap-2">
            <span
              className={`rounded-full border px-2.5 sm:px-3 py-1 font-mono text-[9px] sm:text-[10px] tracking-wider ${
                i === 4
                  ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300 shadow-[0_0_24px_rgba(16,185,129,0.25)]'
                  : i === 1
                    ? 'border-violet-500/40 bg-violet-500/10 text-violet-300'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-400'
              }`}
            >
              {s}
            </span>
            {i < 4 && <span className="hidden xs:inline-block h-px w-3 sm:w-4 bg-zinc-700" />}
          </div>
        ))}
      </div>
    ),
  },
];

export default function LoginClient() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error');

  const lenisRef = useRef<Lenis | null>(null);

  useEffect(() => {
    const lenis = new Lenis({ duration: 1.15, smoothWheel: true });
    lenisRef.current = lenis;
    let raf: number;
    const loop = (t: number) => {
      lenis.raf(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
      lenisRef.current = null;
    };
  }, []);

  const handleScrollToManifesto = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (lenisRef.current) {
      lenisRef.current.scrollTo('#manifesto', {
        duration: 1.8,
        easing: (t: number) => 1 - Math.pow(1 - t, 3),
        offset: 30,
      });
    } else {
      const target = document.getElementById('manifesto');
      if (target) {
        const top = target.getBoundingClientRect().top + window.scrollY + 80;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    }
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 selection:bg-emerald-500/28 selection:text-zinc-100 max-w-full overflow-x-hidden">
      {/* Top Bar */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-zinc-800/60 bg-[#09090b]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 sm:h-16 max-w-7xl items-center justify-between px-3 sm:px-6">
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0" data-testid="landing-logo">
            <AppLogoMark size={28} className="transition-transform duration-200 hover:scale-105 shrink-0" />
            <span className="font-display text-xs sm:text-sm font-bold tracking-tight text-white truncate">
              Where&apos;s My Offer<span className="text-emerald-400 font-extrabold ml-0.5 drop-shadow-[0_0_6px_rgba(52,211,153,0.55)]">?</span>
            </span>
          </div>
          <div className="flex items-center gap-3 sm:gap-5 shrink-0">
            <span className="hidden font-mono text-[10px] uppercase tracking-widest text-zinc-600 sm:block">
              placement radar · live
            </span>
            <a
              data-testid="nav-signin-btn"
              href="/api/auth/google"
              className="rounded-full border border-zinc-700 px-3.5 sm:px-4 py-1 sm:py-1.5 text-xs font-semibold text-zinc-300 transition-colors duration-200 hover:border-zinc-500 hover:text-white"
            >
              Sign in
            </a>
          </div>
        </div>
      </header>

      {/* Auth Error Banner */}
      {error && (
        <div className="fixed top-16 sm:top-20 left-1/2 -translate-x-1/2 z-50 w-full max-w-md px-4">
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 backdrop-blur-md p-3.5 sm:p-4 text-xs text-rose-300 flex items-center gap-3 shadow-2xl">
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
            <span>{ERROR_MESSAGES[error] || decodeURIComponent(error)}</span>
          </div>
        </div>
      )}

      {/* Hero */}
      <section className="relative mx-auto grid max-w-7xl gap-8 sm:gap-10 lg:gap-14 px-4 pb-12 pt-20 sm:pb-16 sm:px-6 sm:pt-24 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:pt-28">
        <div className="pointer-events-none absolute -top-20 left-1/4 h-72 w-72 rounded-full bg-violet-600/10 blur-3xl" />
        <div className="min-w-0">
          <Reveal delay={0.1}>
            <span className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.25em] sm:tracking-[0.3em] text-emerald-400">
              {'// placement season 2026 · vit bhopal'}
            </span>
          </Reveal>
          <h1 className="mt-3 sm:mt-4 font-display text-4xl xs:text-5xl font-black leading-[0.95] tracking-tight sm:text-7xl lg:text-8xl">
            <Reveal delay={0.22}>WHERE&apos;S</Reveal>
            <Reveal delay={0.34}>MY</Reveal>
            <Reveal delay={0.46}>
              <span className="text-emerald-400">OFFER?</span>
            </Reveal>
          </h1>
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.7 }}
            className="mt-3 sm:mt-4 max-w-md text-sm leading-relaxed text-zinc-400 sm:text-lg"
          >
            From chaotic CDC circulars to your final offer letter — tracked in real time. Both inboxes, every Excel shortlist, one radar.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.85 }}
            className="mt-6 sm:mt-7"
          >
            <div className="flex flex-col xs:flex-row items-stretch xs:items-center gap-3 sm:gap-5">
              <a
                href="/api/auth/google"
                data-testid="hero-google-btn"
                className="group flex items-center justify-center gap-3 rounded-full bg-zinc-100 px-5 sm:px-6 py-2.5 sm:py-3 text-sm font-bold text-zinc-900 transition-transform duration-200 hover:scale-[1.03] active:scale-[0.98]"
              >
                <GoogleMark />
                <span>Continue with Google</span>
                <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
              </a>
              <a
                href="#manifesto"
                onClick={handleScrollToManifesto}
                data-testid="hero-manifesto-link"
                className="text-center text-xs sm:text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-200 cursor-pointer select-none py-1"
              >
                Read the manifesto ↓
              </a>
            </div>
            <div className="mt-3 inline-flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3.5 py-1.5 text-xs text-emerald-300">
              <span className="font-bold text-white text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-500/20">Step 1</span>
              <span>Sign in with your <strong>Personal Gmail</strong> (where NeoPAT registration emails arrive). Link VIT email later.</span>
            </div>
            <p className="mt-2.5 text-[10px] sm:text-[11px] text-zinc-500 font-mono">
              By connecting, you agree to our{' '}
              <Link href="/terms" className="underline underline-offset-2 hover:text-zinc-300">
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link href="/privacy" className="underline underline-offset-2 hover:text-zinc-300">
                Privacy Policy
              </Link>.
            </p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, delay: 1.05 }}
            className="mt-6 sm:mt-8 flex flex-wrap gap-2 sm:gap-2.5"
          >
            {[
              { icon: ShieldCheck, text: 'Read-only Gmail scope' },
              { icon: Lock, text: 'AES-256 token vault' },
              { icon: Server, text: 'Your data stays on your cloud' },
            ].map(({ icon: Icon, text }) => (
              <span
                key={text}
                data-testid={`trust-chip-${text.split(' ')[0].toLowerCase()}`}
                className="flex items-center gap-1.5 sm:gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-2.5 sm:px-3 py-1 sm:py-1.5 text-[10px] sm:text-[11px] text-zinc-400"
              >
                <Icon className="h-3 sm:h-3.5 w-3 sm:w-3.5 text-emerald-400 shrink-0" /> {text}
              </span>
            ))}
          </motion.div>
        </div>
        <TerminalCard />
      </section>

      {/* Marquee */}
      <section className="overflow-hidden border-y border-zinc-800/70 bg-[#0b0b0e] py-4 sm:py-5 max-w-full" data-testid="company-marquee">
        <div className="animate-marquee flex w-max items-center gap-12 whitespace-nowrap">
          {[...MARQUEE, ...MARQUEE].map((c, i) => (
            <span key={i} className="flex items-center gap-12 font-mono text-xs tracking-[0.35em] text-zinc-600">
              {c} <span className="text-emerald-500/60">✦</span>
            </span>
          ))}
        </div>
      </section>

      {/* Manifesto chapters */}
      <section id="manifesto" className="mx-auto max-w-7xl px-4 py-16 sm:py-28 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7 }}
          className="mb-10 sm:mb-16"
        >
          <span className="font-mono text-[11px] uppercase tracking-[0.3em] text-zinc-500">the manifesto</span>
          <h2 className="mt-3 sm:mt-4 max-w-2xl font-display text-2xl sm:text-4xl font-extrabold tracking-tight">
            Built in a hostel room.{' '}
            <span className="text-zinc-500">Battle-tested in placement season.</span>
          </h2>
        </motion.div>
        <div className="grid gap-4 sm:gap-6 md:grid-cols-2">
          {chapters.map((ch, i) => (
            <motion.div
              key={ch.n}
              data-testid={`chapter-${ch.n}`}
              initial={{ opacity: 0, y: 32 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ duration: 0.7, delay: (i % 2) * 0.12 }}
              className="group rounded-2xl border border-zinc-800 bg-[#0d0f14]/80 p-4 sm:p-7 transition-colors duration-300 hover:border-zinc-700 min-w-0 overflow-hidden"
            >
              <div className="text-outline font-display text-6xl font-black leading-none">{ch.n}</div>
              <h3 className="mt-5 font-display text-xl font-bold tracking-tight">{ch.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-zinc-400">{ch.copy}</p>
              <div className="mt-6">{ch.visual}</div>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-zinc-800/70 bg-[#0b0b0e]">
        <div className="mx-auto max-w-7xl px-4 py-24 text-center sm:px-6">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.7 }}
          >
            <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
              <Inbox className="h-5 w-5 text-emerald-400" />
            </div>
            <h2 className="mx-auto max-w-xl font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
              Stop hunting roll numbers.{' '}
              <span className="text-emerald-400">Start collecting offers.</span>
            </h2>
            <a
              href="/api/auth/google"
              data-testid="cta-google-btn"
              className="group mx-auto mt-8 flex items-center justify-center gap-3 rounded-full bg-zinc-100 px-7 py-3.5 text-sm font-bold text-zinc-900 transition-transform duration-200 hover:scale-[1.03] active:scale-[0.98] w-fit"
            >
              <GoogleMark />
              <span>Get started with Google</span>
              <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
            </a>
            <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3.5 py-1.5 text-xs text-emerald-300">
              <span className="font-bold text-white text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-500/20">Step 1</span>
              <span>Use your <strong>Personal Gmail</strong> to sign in · VIT College email connects later in Settings</span>
            </div>
            <p className="mt-5 font-mono text-[10px] uppercase tracking-widest text-zinc-600">
              read-only · revocable anytime · built by students, for students
            </p>
          </motion.div>
        </div>

        {/* Footer */}
        <footer className="border-t border-zinc-800/70 py-8">
          <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 font-mono text-[11px] text-zinc-600 sm:flex-row sm:px-6">
            <p className="tracking-wider uppercase text-[10px]">
              Where&apos;s My Offer? © 2026
            </p>
            <div className="flex items-center gap-6 text-[11px] text-zinc-500">
              <Link href="/privacy" className="transition-colors hover:text-zinc-300">
                Privacy Policy
              </Link>
              <span className="text-zinc-500">·</span>
              <Link href="/terms" className="transition-colors hover:text-zinc-300">
                Terms of Service
              </Link>
              <span className="text-zinc-500">·</span>
              <Link href="/feedback" className="transition-colors hover:text-zinc-300">
                Feedback & Support
              </Link>
            </div>
          </div>
        </footer>
      </section>
    </div>
  );
}
