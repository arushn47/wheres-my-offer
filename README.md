# Where's My Offer

A Next.js 16 App Router application for tracking placement drives from personal NeoPAT mail and shared college circulars. It uses React 19, TypeScript, Tailwind CSS, Supabase, Google OAuth/Gmail and Google Pub/Sub.

## Development

Use Node.js 24 and the committed npm lockfile:

```sh
npm ci
npm run dev
```

Configure `.env.local` with the intended development database, Google OAuth credentials, token encryption key and application URL. Keep credentials out of Git. The local environment and Production are independent; verify the target project before running any database or sync tool. Do not reuse live database credentials for destructive tests.

## Structure

```text
src/
  app/                    Routes, layouts, API handlers and route-local _components/
  components/             Shared UI grouped by purpose
  context/                Shared React providers
  hooks/                  Shared client hooks
  lib/
    auth/                 Session and account access
    gmail/                Gmail integration and original-message resolution
    supabase/             Database clients and query measurements
    calendar/             Calendar delivery and event helpers
    notifications/        Notification delivery and outbox
    sync/
      classification/     Email classification and gated AI fallback
      extraction/         Body, document, event and venue extraction
      attachments/        Rosters, spreadsheets and candidate matching
      canonical/          Shared college ingestion and archive access
      identity/           Drive and candidate identity resolution
      recruitment/        Existing status, rounds and outcome rules
      progress/           Persisted progress and shared-status reads
      engine.ts           User sync orchestration
      reprocess.ts        Explicit reprocessing orchestration
    migration/            Compatibility and migration helpers
    crypto/               Credential encryption
    cutover/              Maintenance write fence
  types/                  Shared types without runtime behavior
public/                   Static assets and service worker
tools/                    Maintained operational entry points
supabase/migrations/      Versioned database migrations
docs/                     Architecture, release procedures and audit notes
```

Tests stay beside the code they exercise. Use `@/` for imports from `src`; do not create forwarding modules solely to hide a file move. `_components` directories are private to their route and do not introduce URLs. Shared components belong in `src/components` when multiple routes use them.

## Checks

```sh
npm run typecheck
npm test
npm run test:tools
npm run build
npm run lint
node tools/audit-codebase.mjs
```

Vitest discovers maintained `src/**/*.test.ts` tests; operational-tool tests use Node's separate test runner. Database integration tests skip unless their explicit isolated-test prerequisites are provided. The cleanup audit records existing lint debt separately from build/type failures. Ignored recovery backups and one-off local diagnostics are not lint or test targets.

## Production operations

Google Pub/Sub is the primary incoming-mail trigger. Cron-job.org job **8265126** calls `/api/cron/sync` daily at **00:00 Asia/Kolkata** as the safety net and Gmail-watch renewal mechanism. Keep user concurrency locks, mutation leases, persistent progress, cursors and delivery outboxes intact.

Code restructuring does not authorize database migrations, historical reprocessing, environment changes or deployment. Use the relevant release procedure explicitly:

- [Current architecture](docs/architecture.md)
- [Code and database cleanup audit](docs/codebase-cleanup-audit.md)
- [Production cutover actions](docs/production-cutover-actions.md)
- [Original email and Drive Mode release](docs/email-and-venue-release.md)
- [Agent architecture rules](AGENTS.md)
