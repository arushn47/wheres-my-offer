# Memory — NeoPAT Placement Tracker

> This file tracks the project's progress, decisions, and context so the AI doesn't lose track across sessions. Update this after every significant change.

---

## Current Phase

**Phase 6 — Complete & Production Ready!** 🎉

---

## Project Status

| Area                  | Status         | Notes                                    |
|-----------------------|----------------|------------------------------------------|
| Documentation         | ✅ Complete    | PRD, Architecture, Rules, Phases, Design, Memory all created |
| Next.js Setup         | ✅ Complete    | Next.js 15 + TypeScript + Tailwind v4    |
| Supabase Setup        | ✅ Complete    | Schema deployed, RLS enabled, permissions granted |
| Google Cloud Setup    | ✅ Complete    | OAuth 2.0 credentials configured         |
| OAuth Flow            | ✅ Complete    | Login, multi-account linking, session JWT |
| App Shell (UI)        | ✅ Complete    | Sidebar, Topbar, Mobile Nav, all routes  |
| Email Sync            | ✅ Complete    | Gmail client, classifier, sync engine, SSE API |
| Attachment Processing | ✅ Complete    | SheetJS Excel scanner (.xlsx/.xls/.csv) for Neo ID matches |
| Status Engine         | ✅ Complete    | Neo ID matcher, dynamic application status engine |
| Dashboard UI          | ✅ Complete    | Metrics, Upcoming Events, Neo ID prompt  |
| Companies View        | ✅ Complete    | Filterable table, search, status badges  |
| Company Detail UI     | ✅ Complete    | Profile, status override, timeline, emails |
| Calendar View         | ✅ Complete    | Month grid, event markers, modal preview |
| Global Search         | ✅ Complete    | Search across companies, emails, events  |
| AI Placement Bot      | ✅ Complete    | Natural language commands & status override |
| Notifications         | ✅ Complete    | Bell icon, unread counter, popover list  |
| Production Build      | ✅ Complete    | Clean Next.js production build (16/16 routes) |

---

## Key Decisions Made

| Decision                        | Choice                          | Date       |
|---------------------------------|---------------------------------|------------|
| Styling                         | Tailwind CSS v4 + shadcn/ui     | 2026-08-11 |
| Backend architecture            | Hybrid (Next.js API + FastAPI)  | 2026-08-11 |
| Database                        | Supabase (managed PostgreSQL)   | 2026-08-11 |
| Deployment (Frontend)           | Vercel                          | 2026-08-11 |
| Deployment (Parser)             | Railway                         | 2026-08-11 |
| Auth approach                   | JWT in HTTP-only cookies        | 2026-08-11 |
| Token encryption                | AES-256-GCM                     | 2026-08-11 |
| Multi-account linking           | Session-aware OAuth callback    | 2026-08-11 |
| Supabase URL typo fix           | `mltfzskewmpifnyleevb` (l not 1)| 2026-08-11 |

---

## Files Created

### Phase 1 Files

| File                                         | Purpose                                      |
|----------------------------------------------|----------------------------------------------|
| `docs/prd.md`                                | Product Requirements Document                |
| `docs/architecture.md`                       | System architecture & tech stack             |
| `docs/rules.md`                              | AI coding rules & conventions                |
| `docs/phases.md`                             | Implementation phases breakdown              |
| `docs/design.md`                             | Design system (colors, fonts, etc.)          |
| `docs/memory.md`                             | This file — project state tracker            |
| `supabase/schema.sql`                        | Full database schema (11 tables, RLS, indexes)|
| `src/lib/auth.ts`                            | Session management (JWT verify, getSession)  |
| `src/lib/crypto/tokens.ts`                   | AES-256-GCM encrypt/decrypt for OAuth tokens |
| `src/lib/supabase/admin.ts`                  | Supabase service-role admin client           |
| `src/lib/supabase/client.ts`                 | Supabase browser client                      |
| `src/lib/utils.ts`                           | Utility helpers (cn, timeAgo, etc.)          |
| `src/app/api/auth/google/route.ts`           | OAuth initiation endpoint                    |
| `src/app/api/auth/callback/route.ts`         | OAuth callback — multi-account aware         |
| `src/app/api/auth/disconnect/route.ts`       | Account disconnect / logout                  |
| `src/app/api/sync/route.ts`                  | Sync endpoint (stub — Phase 2 will fill in)  |
| `src/app/login/page.tsx`                     | Login page (server component)                |
| `src/app/login/login-client.tsx`             | Login page (client component)                |
| `src/app/(dashboard)/page.tsx`               | Dashboard page (server component)            |
| `src/app/(dashboard)/dashboard-client.tsx`    | Dashboard page (client component)            |
| `src/app/(dashboard)/settings/page.tsx`       | Settings page (server component)             |
| `src/app/(dashboard)/settings/settings-client.tsx` | Settings page (client component)        |
| `src/app/(dashboard)/layout.tsx`              | Dashboard layout (sidebar + topbar)          |
| `src/components/layout/sidebar.tsx`           | Navigation sidebar                           |
| `src/components/layout/topbar.tsx`            | Top bar with sync button, notifications      |
| `src/components/layout/mobile-nav.tsx`        | Mobile bottom navigation                     |
| `src/constants/`                              | App constants, status enums                  |
| `src/types/`                                  | TypeScript type definitions                  |
| `middleware.ts`                               | Route protection middleware                  |

### Phase 2 Files

| File                                         | Purpose                                      |
|----------------------------------------------|----------------------------------------------|
| `src/lib/gmail/client.ts`                     | Gmail API client, token decrypt, email fetch |
| `src/lib/sync/classifier.ts`                  | Rules-based email classifier, company extractor |
| `src/lib/sync/engine.ts`                      | Sync orchestrator (all accounts → DB)        |
| `src/app/api/sync/route.ts`                   | SSE streaming sync API endpoint              |
| `src/components/layout/topbar.tsx`            | Updated with real-time sync progress bar     |

---

## Known Issues / Blockers

- [x] ~~Supabase URL typo (`1` vs `l`) caused connection failures~~ — Fixed
- [x] ~~Database permission denied for service_role~~ — Fixed with GRANT ALL
- [x] ~~Multi-account linking created duplicate users~~ — Fixed with session-aware callback
- [ ] Next.js 16 deprecated `middleware` in favor of `proxy` — non-blocking warning

---

## Recent Changes

### 2026-08-12 (Phase 2 Complete)
- Built Gmail API client with token decryption, auto-refresh, and placement-focused search queries
- Built deterministic email classifier with 15+ priority-ordered rules
- Built company name extractor with 40+ Indian IT company aliases
- Built sync engine orchestrator with deduplication and rate limiting
- Replaced stub sync API with SSE streaming endpoint
- Updated Topbar with real-time progress bar and success/error toasts
- TypeScript compiles cleanly with zero errors

### 2026-08-11 (Phase 1 Complete)
- Created all project documentation
- Initialized Next.js 15 project with TypeScript and Tailwind CSS v4
- Created Supabase schema (11 tables, RLS, indexes, triggers)
- Built Google OAuth flow with multi-account linking
- Implemented AES-256-GCM token encryption
- Built app shell: Sidebar, Topbar, Mobile Nav
- Created Dashboard, Settings, Login pages
- Fixed Supabase URL typo, permission issues, multi-account linking bug
- Both Gmail accounts successfully connected (personal + college)

---

## Context for AI

- **User**: VIT Bhopal student (`arush.23bce10472@vitbhopal.ac.in`)
- **Neo ID**: Configured per user in Settings (e.g. 6-12 alphanumeric characters)
- **Primary use case**: Track campus placement drives from NeoPAT portal and VIT placement emails
- **External Cron Job (CRITICAL)**: Configured on [cron-job.org](https://console.cron-job.org/jobs/8265126) running `GET https://neopat-tracker.vercel.app/api/cron/sync` **every 15 minutes** (`*/15 * * * *`). Sync MUST be concurrency-locked per user so background cron never collides with manual or ongoing initial syncs.
- **Project location**: `d:\CODING\Web Development\Projects\Fullstack\NeoTrack`
- **OS**: Windows
- **Package manager**: npm
- **Dev server**: `npm run dev` (Next.js 16.3.0 with Turbopack)
