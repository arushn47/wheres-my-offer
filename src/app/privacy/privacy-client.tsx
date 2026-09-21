'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  ShieldCheck,
  Lock,
  CheckCircle2,
  Database,
  KeyRound,
  ExternalLink,
  ArrowLeft,
  ArrowUp,
  Mail,
  EyeOff,
  Server,
  Sparkles,
  UserCheck,
  Trash2,
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

export default function PrivacyClient() {
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
      {/* Animated Ambient Background */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -top-32 -left-32 h-[500px] w-[500px] rounded-full bg-emerald-500/[0.06] blur-[120px] animate-pulse" />
        <div className="absolute -bottom-32 -right-32 h-[600px] w-[600px] rounded-full bg-violet-500/[0.05] blur-[140px]" style={{ animationDuration: '8s' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[400px] w-[400px] rounded-full bg-emerald-500/[0.03] blur-[100px]" />
        {/* Subtle grid */}
        <div
          className="absolute inset-0 opacity-[0.025]"
          style={{
            backgroundImage: `linear-gradient(rgba(16,185,129,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(16,185,129,0.5) 1px, transparent 1px)`,
            backgroundSize: '60px 60px',
          }}
        />
      </div>

      {/* Sticky Top Header */}
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
                  PRIVACY
                </span>
              </div>
              <p className="text-[10px] font-mono text-zinc-500">Placement Radar · Live</p>
            </div>
          </Link>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
              <span className="px-2.5 sm:px-3 py-1 text-xs font-semibold text-white bg-zinc-800 rounded-md shadow-sm">
                Privacy
              </span>
              <Link
                href="/terms"
                className="px-2.5 sm:px-3 py-1 text-xs font-semibold text-zinc-400 hover:text-white rounded-md transition-colors"
              >
                Terms
              </Link>
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
              DATA PROTECTION · GOOGLE LIMITED USE COMPLIANT
            </div>

            <h1 className="text-4xl sm:text-6xl font-black text-white tracking-tight mb-4 font-display leading-tight">
              Privacy{' '}
              <span className="bg-gradient-to-r from-emerald-400 to-teal-300 bg-clip-text text-transparent">
                Policy
              </span>
            </h1>

            <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-zinc-400 mb-8">
              <span>
                Effective: <span className="text-zinc-200 font-semibold">{LAST_UPDATED}</span>
              </span>
              <span className="text-zinc-700">·</span>
              <span>Platform: {APP_NAME}</span>
              <span className="text-zinc-700">·</span>
              <span className="text-emerald-400 font-semibold">Zero Advertising · Zero Data Selling</span>
            </div>

            {/* Human Summary Card (TL;DR) */}
            <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-950/20 via-[#101014]/90 to-[#0c1410]/90 backdrop-blur-md p-6 shadow-2xl shadow-emerald-950/20">
              <div className="flex items-center gap-2.5 mb-3 text-emerald-400 font-semibold text-sm font-display tracking-tight">
                <Sparkles className="h-4 w-4" />
                <span>The Plain-English Summary (The TL;DR)</span>
              </div>
              <p className="text-sm leading-relaxed text-zinc-300 mb-4">
                We built <strong className="text-white">{APP_NAME}</strong> because campus placements are stressful enough without losing track of crucial test links, CTC sheets, and shortlist circulars. We treat your inbox with absolute respect:
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-zinc-300">
                <div className="flex items-start gap-2 rounded-lg bg-zinc-900/60 p-3 border border-zinc-800/80">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span><strong>Only placement emails:</strong> We only read emails from official university placement addresses (CDC &amp; NeoPAT). Your personal emails are never touched.</span>
                </div>
                <div className="flex items-start gap-2 rounded-lg bg-zinc-900/60 p-3 border border-zinc-800/80">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span><strong>No human eyes:</strong> Ingestion and shortlist matching are 100% automated by code. No human reads your email messages.</span>
                </div>
                <div className="flex items-start gap-2 rounded-lg bg-zinc-900/60 p-3 border border-zinc-800/80">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span><strong>Never sold, never used for AI training:</strong> We do not sell your data, run ads, or train generalized public AI/LLM models on your emails.</span>
                </div>
                <div className="flex items-start gap-2 rounded-lg bg-zinc-900/60 p-3 border border-zinc-800/80">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span><strong>Instant self-service wipe:</strong> You can disconnect and permanently delete your entire profile and history at any moment in Settings.</span>
                </div>
              </div>
            </div>
          </div>
        </AnimatedSection>

        {/* Detailed Sections */}
        <div className="space-y-6">
          {/* 1. What We Collect */}
          <AnimatedSection delay={40}>
            <section className="rounded-2xl border border-zinc-800/70 bg-[#101014]/80 backdrop-blur-sm p-6 sm:p-8 shadow-xl shadow-black/40 hover:border-zinc-700/60 transition-all duration-300">
              <div className="flex items-center gap-3 mb-5">
                <span className="font-mono text-xs font-bold text-emerald-400 tracking-wider border border-emerald-500/30 bg-emerald-500/10 rounded-lg px-2.5 py-1">01</span>
                <h2 className="text-lg font-bold text-white">Information We Collect (And What We Ignore)</h2>
              </div>

              <div className="space-y-3.5 text-sm leading-relaxed text-zinc-400">
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
                  <h3 className="text-xs font-semibold text-zinc-200 uppercase tracking-wider font-mono mb-1.5 flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    1. Basic Account Identity
                  </h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    When you sign in with Google OAuth, we receive your name, email address, and profile image. We use this exclusively to authenticate you, keep your dashboard session alive, and render your avatar in the app topbar.
                  </p>
                </div>

                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <h3 className="text-xs font-semibold text-zinc-200 uppercase tracking-wider font-mono flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      2. Placement Emails &amp; Attachments
                    </h3>
                    <code className="text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded font-mono text-[10px]">
                      gmail.readonly
                    </code>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed mb-3">
                    To automate your recruitment radar, {APP_NAME} searches specifically for placement dispatches from designated campus senders (such as <code className="text-zinc-300 font-mono text-[11px]">noreply.cdcinfo@vitstudent.ac.in</code> and official placement office broadcasts). We parse:
                  </p>
                  <ul className="space-y-2 ml-1 text-xs text-zinc-300">
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                      <span>Company announcement titles, job profiles, eligibility criteria, and CTC package details.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                      <span>Drive milestone timelines: Pre-Placement Talks (PPT), coding assessments, technical interviews, and HR rounds.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                      <span>Shortlist rosters (PDFs and Excel sheets) to cross-reference whether your specific Registration ID is shortlisted.</span>
                    </li>
                  </ul>
                  <div className="mt-3 rounded-lg border border-zinc-800 bg-black/40 p-3 text-[11px] text-zinc-400">
                    🛡️ <strong>What we deliberately ignore:</strong> We do NOT read your personal conversations, OTPs, bank statements, receipts, academic course emails, or newsletters. Our query engine filters exclusively by verified placement sender addresses.
                  </div>
                </div>

                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                    <h3 className="text-xs font-semibold text-zinc-200 uppercase tracking-wider font-mono flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      3. Google Calendar (Optional)
                    </h3>
                    <code className="text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded font-mono text-[10px]">
                      calendar.events.owned
                    </code>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    If you enable Google Calendar integration in Settings, we use calendar permissions strictly to add, update, and manage your placement events (test windows, PPTs, interview slots). We do not read your non-placement calendar appointments.
                  </p>
                </div>

                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
                  <h3 className="text-xs font-semibold text-zinc-200 uppercase tracking-wider font-mono mb-1.5 flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    4. Student Registration ID
                  </h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    During onboarding or in Settings, you provide your Candidate Registration ID (e.g., your NeoPAT ID) and college email. We use this strictly to match your name on shortlist spreadsheets so you receive immediate shortlist alerts.
                  </p>
                </div>
              </div>
            </section>
          </AnimatedSection>

          {/* 2. Google Limited Use Compliance */}
          <AnimatedSection delay={60}>
            <section className="rounded-2xl border border-emerald-500/30 bg-gradient-to-b from-[#101014]/90 to-[#0a120e]/90 backdrop-blur-sm p-6 sm:p-8 shadow-xl shadow-black/40 hover:border-emerald-500/50 transition-all duration-300">
              <div className="flex items-center gap-3 mb-5">
                <ShieldCheck className="h-6 w-6 text-emerald-400" />
                <h2 className="text-lg font-bold text-white">Google API Services — Limited Use Disclosure</h2>
              </div>
              <p className="text-sm leading-relaxed text-zinc-300 mb-4">
                {APP_NAME}&apos;s use and transfer to any other app of information received from Google APIs adheres to the{' '}
                <a
                  href="https://developers.google.com/terms/api-services-user-data-policy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300 inline-flex items-center gap-1 font-semibold transition-colors"
                >
                  Google API Services User Data Policy <ExternalLink className="h-3.5 w-3.5 inline" />
                </a>
                , including the strict <strong>Limited Use</strong> requirements:
              </p>

              <div className="space-y-2.5">
                {[
                  'We only use read access to your Gmail messages to provide placement tracking and scheduling features directly visible to you within the application interface.',
                  'We do not transfer your Gmail data to third parties, unless necessary to provide these placement features, comply with applicable laws, or as part of a merger/acquisition.',
                  'We do not use or transfer your Gmail data for serving advertisements, personalized retargeting, or consumer profiling.',
                  'We do not use your Gmail data to train generalized artificial intelligence (AI) and/or machine learning (ML) models.',
                  'Human eyes are strictly prohibited: No employee, developer, or contractor reads your emails, except with your explicit affirmative permission for troubleshooting a specific issue, for security investigations, or when required by law.',
                ].map((clause, i) => (
                  <div key={i} className="flex items-start gap-2.5 rounded-lg bg-zinc-900/70 border border-zinc-800/80 p-3 text-xs text-zinc-300">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                    <span>{clause}</span>
                  </div>
                ))}
              </div>
            </section>
          </AnimatedSection>

          {/* 3. Data Storage & Security */}
          <AnimatedSection delay={80}>
            <section className="rounded-2xl border border-zinc-800/70 bg-[#101014]/80 backdrop-blur-sm p-6 sm:p-8 shadow-xl shadow-black/40 hover:border-zinc-700/60 transition-all duration-300">
              <div className="flex items-center gap-3 mb-5">
                <span className="font-mono text-xs font-bold text-emerald-400 tracking-wider border border-emerald-500/30 bg-emerald-500/10 rounded-lg px-2.5 py-1">03</span>
                <h2 className="text-lg font-bold text-white">How Your Data Is Stored &amp; Protected</h2>
              </div>
              <p className="text-sm leading-relaxed text-zinc-400 mb-4">
                We implement modern, defense-in-depth architectural security to safeguard your personal credentials and indexed placement entries:
              </p>

              <div className="space-y-3">
                {[
                  {
                    icon: <KeyRound className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />,
                    title: 'Cryptographic Token Encryption (AES-256-GCM)',
                    desc: 'OAuth access and refresh tokens are encrypted at rest using industry-standard AES-256-GCM authenticated encryption before being saved to the database. Decryption keys are managed via isolated server environment variables.',
                  },
                  {
                    icon: <Database className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />,
                    title: 'PostgreSQL Row-Level Security (RLS)',
                    desc: 'Our database enforces strict Row-Level Security on every single table. Even authenticated requests can only query and view data belonging strictly to their own unique user ID.',
                  },
                  {
                    icon: <Server className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />,
                    title: 'Zero Password Storage',
                    desc: 'We never see or store your Google account password. All access is handled via standardized OAuth 2.0 tokens that you can revoke at any second from your Google Account security center.',
                  },
                ].map((item, i) => (
                  <div key={i} className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5 flex items-start gap-3">
                    {item.icon}
                    <div>
                      <h3 className="text-xs font-semibold text-zinc-200">{item.title}</h3>
                      <p className="text-xs text-zinc-400 mt-0.5">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </AnimatedSection>

          {/* 4. Third-Party Infrastructure */}
          <AnimatedSection delay={100}>
            <section className="rounded-2xl border border-zinc-800/70 bg-[#101014]/80 backdrop-blur-sm p-6 sm:p-8 shadow-xl shadow-black/40 hover:border-zinc-700/60 transition-all duration-300">
              <div className="flex items-center gap-3 mb-5">
                <span className="font-mono text-xs font-bold text-emerald-400 tracking-wider border border-emerald-500/30 bg-emerald-500/10 rounded-lg px-2.5 py-1">04</span>
                <h2 className="text-lg font-bold text-white">Infrastructure &amp; Sub-Processors</h2>
              </div>
              <p className="text-sm leading-relaxed text-zinc-400 mb-4">
                To provide a high-performance, real-time tracking experience, {APP_NAME} utilizes trusted, enterprise-grade cloud providers under strict security contracts:
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
                  <h3 className="font-semibold text-white mb-1">Vercel Inc.</h3>
                  <p className="text-[11px] text-zinc-400">Hosting and edge compute execution for application frontends and API routes.</p>
                </div>
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
                  <h3 className="font-semibold text-white mb-1">Supabase Inc.</h3>
                  <p className="text-[11px] text-zinc-400">SOC 2 compliant managed PostgreSQL database hosting with encrypted storage at rest.</p>
                </div>
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
                  <h3 className="font-semibold text-white mb-1">Google Cloud</h3>
                  <p className="text-[11px] text-zinc-400">Official OAuth 2.0 identity verification, Gmail API ingestion, and Google Calendar sync.</p>
                </div>
              </div>
            </section>
          </AnimatedSection>

          {/* 5. Your Rights & Account Deletion */}
          <AnimatedSection delay={120}>
            <section className="rounded-2xl border border-zinc-800/70 bg-[#101014]/80 backdrop-blur-sm p-6 sm:p-8 shadow-xl shadow-black/40 hover:border-zinc-700/60 transition-all duration-300">
              <div className="flex items-center gap-3 mb-5">
                <span className="font-mono text-xs font-bold text-emerald-400 tracking-wider border border-emerald-500/30 bg-emerald-500/10 rounded-lg px-2.5 py-1">05</span>
                <h2 className="text-lg font-bold text-white">Your Rights &amp; Immediate Data Erasure</h2>
              </div>
              <p className="text-sm leading-relaxed text-zinc-400 mb-4">
                You retain complete, unconditional control over your data. We never lock you in:
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-bold text-rose-300 mb-1.5">
                      <Trash2 className="h-4 w-4 text-rose-400" />
                      1-Click Full Erasure
                    </div>
                    <p className="text-[11px] text-zinc-400 mb-3 leading-relaxed">
                      Permanently wipes all indexed emails, companies, applications, and OAuth credentials from our database.
                    </p>
                  </div>
                  <Link href="/settings" className="text-xs font-semibold text-rose-400 hover:text-rose-300 transition-colors">
                    Settings → Danger Zone →
                  </Link>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-bold text-emerald-300 mb-1.5">
                      <Lock className="h-4 w-4 text-emerald-400" />
                      Revoke Google Access
                    </div>
                    <p className="text-[11px] text-zinc-400 mb-3 leading-relaxed">
                      Revoke our app&apos;s permissions directly from your central Google Account security dashboard at any time.
                    </p>
                  </div>
                  <a
                    href="https://myaccount.google.com/permissions"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1 transition-colors"
                  >
                    Google Permissions <ExternalLink className="h-3 w-3 inline" />
                  </a>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-bold text-sky-300 mb-1.5">
                      <UserCheck className="h-4 w-4 text-sky-400" />
                      Data Export
                    </div>
                    <p className="text-[11px] text-zinc-400 mb-3 leading-relaxed">
                      Request a full JSON/CSV export of your tracked applications, company CTC tiers, and interview timeline.
                    </p>
                  </div>
                  <Link href="/feedback" className="text-xs font-semibold text-sky-400 hover:text-sky-300 transition-colors">
                    Request via Feedback →
                  </Link>
                </div>
              </div>
            </section>
          </AnimatedSection>

          {/* 6. Contact Support */}
          <AnimatedSection delay={140}>
            <section className="rounded-2xl border border-zinc-800/70 bg-[#101014]/80 backdrop-blur-sm p-6 sm:p-8 shadow-xl shadow-black/40 hover:border-zinc-700/60 transition-all duration-300">
              <div className="flex items-center gap-3 mb-4">
                <Mail className="h-5 w-5 text-emerald-400" />
                <h2 className="text-lg font-bold text-white">Questions or Privacy Concerns?</h2>
              </div>
              <p className="text-sm leading-relaxed text-zinc-400 mb-4">
                If you have any questions about this Privacy Policy, our automated indexing algorithms, or would like to report a security question, feel free to reach out to our team directly:
              </p>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-white">{APP_NAME} Developer &amp; Security Desk</p>
                  <p className="text-[11px] text-zinc-500 font-mono">Student Platform · VIT Bhopal University</p>
                </div>
                <Link
                  href="/feedback"
                  className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                >
                  <span>Submit Inquiry or Feedback →</span>
                </Link>
              </div>
            </section>
          </AnimatedSection>
        </div>

        {/* Footer */}
        <AnimatedSection delay={160}>
          <div className="mt-16 pt-8 border-t border-zinc-800/60 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs font-mono text-zinc-500">
            <p>© {new Date().getFullYear()} {APP_NAME}. Built for students, with privacy first.</p>
            <div className="flex items-center justify-center gap-3 sm:gap-4 whitespace-nowrap text-[11px]">
              <Link href="/terms" className="hover:text-zinc-200 transition-colors whitespace-nowrap">
                Terms of Service
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
