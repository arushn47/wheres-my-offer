# Where's My Offer architecture

Current source layout and operating boundaries, reviewed 7 October 2026. Older implementation milestones in `memory.md`, phase plans and schema snapshots are historical; they do not override these boundaries or the current migration/runbooks.

## Runtime and entry points

The application runs on Next.js 16.3 App Router and React 19. Server pages and route handlers remain under `src/app`; `src/proxy.ts` handles request authentication, canonical-host redirects and the maintenance write fence. Google OAuth credentials are encrypted, and application sessions use an HTTP-only JWT cookie. Database access uses the existing Supabase clients. Document processing runs in Node with SheetJS and PDF extraction; there is no active FastAPI parser service.

Vercel Functions and the current production Supabase project are in Mumbai (`bom1` / `ap-south-1`). Deployment environment values are managed independently of local environment files.

## Folder ownership

```text
src/app/                         URL routes, layouts and HTTP handlers
src/app/**/_components/          Components used by their owning route
src/components/                 Shared UI: layout, admin, companies, notifications, ui, brand
src/context/, src/hooks/         Shared client state and hooks
src/lib/auth/, gmail/, supabase/ External integration and account/session access
src/lib/calendar/               Calendar synchronization and delivery outbox
src/lib/notifications/          Notification delivery and outbox
src/lib/sync/
  classification/               Deterministic email classification and gated AI extraction
  extraction/                   Text/PDF, details, dates, roles and venue extraction
  attachments/                  Roster scanning, candidate matching and compact lookups
  canonical/                    Shared college archive, ingestion and backfill
  identity/                     User identity, drive correlation and application scope
  recruitment/                  Recruitment evidence, rounds, verdicts and status display
  progress/                     Compact progress readers and shared-status polling
  engine.ts, reprocess.ts        Workflow orchestration
  mutation-lease.ts              Existing concurrency/mutation fencing
  lease-context.ts              Lease propagation to database calls
  dashboard-readers.ts          Compact dashboard projections
src/lib/migration/              Existing compatibility and migration operations
src/lib/crypto/, cutover/        Encryption and maintenance controls
src/types/                      Shared type-only declarations
public/                         Static assets and service worker
tools/                          Maintained, explicit operational commands
supabase/migrations/             Versioned schema changes
docs/                           Architecture, operations, release and audit documents
```

Next.js supports a `src` directory, route groups and private folders. It does not require a universal business-code hierarchy. This project keeps route entry points stable, colocates route-local UI and groups its existing large sync implementation by responsibility. Tests remain colocated, and `@/` resolves to `src/`. The refactor introduces no new service layer, barrels, public routes or forwarding compatibility files.

`scripts/`, `scratch/` and `backups/` contain ignored local diagnostics and recovery material. They are preserved, excluded from routine lint/test discovery and are not deployment inputs. Maintained `tools/` entry-point paths stay stable for documented operations.

## Placement flow and data ownership

Personal NeoPAT messages provide individual eligibility, registration and withdrawal evidence. An eligibility invitation alone is not an application or shortlist. College circulars are distributed broadly and provide shared drive details, schedules and rosters; receiving one alone is not candidate participation evidence.

Shared college mail is ingested canonically so its body, parsed attachments and rosters can be reused. Personal mail and candidate-specific participation remain scoped to the user. Companies may have multiple distinct placement drives; source links, candidate decisions and recruitment venues must resolve to the exact drive.

The existing recruitment engine derives outcomes from candidate evidence and round history. A file move or display-only venue change must not alter those decisions. Drive Mode uses explicit recruitment venue evidence, independently of job location. Original-email opening resolves a message in the clicking user's connected mailbox rather than borrowing the shared ingester's Gmail ID. See the separate feature release procedure for the pending additive migrations.

## Background delivery and concurrency

Google Pub/Sub delivers incoming Gmail changes to `/api/webhooks/gmail`. Cron-job.org job **8265126** calls `https://www.wheresmyoffer.in/api/cron/sync` daily at **00:00 Asia/Kolkata** for the safety net, deadline notifications, cleanup and expiring Gmail-watch renewal.

User syncs must acquire the existing concurrency lock and cleanly skip a still-active run. Shared ingestion has its own coordination. Mutation leases prevent stale workers from writing after ownership changes. Progress and cursors persist in the database; page reloads must not start an unchecked competing sync. Calendar and notification outboxes retain their dedupe, candidate-confirmed and retry semantics.

## Database and egress boundaries

The metadata-only audit found 29 public application tables and two compatibility views. Tables remain in use through application queries or database functions. In particular, roster lookup indexes, sync progress, account/session credentials, canonical source links and delivery outboxes are active architecture, not disposable generated scaffolding.

Compact projections and batched reads limit response bytes. Notification catch-up is scoped to affected drives and batches recency reads. Rendering must not fetch whole mail bodies or scan all-user history. The current 24–48 hour egress observation is left undisturbed by this local cleanup.

No database object is removed merely because it is empty or absent from a literal `.from()` search: RPCs, triggers, compatibility views, dynamic SQL and external consumers also matter. See [the audit](codebase-cleanup-audit.md) for retained objects and verification limits.

## Validation and release

TypeScript, the maintained Vitest suite, a fresh production build, the route manifest and public/auth-redirect HTTP smoke checks cover this restructuring. Existing lint debt is reported separately. Signed-in Google account routing still requires the feature release's real-browser acceptance check.

Production writes, migrations, deployment, OAuth flows and historical reprocessing are separate authorized actions. Use [production cutover actions](production-cutover-actions.md) and [email/venue release actions](email-and-venue-release.md), retaining the current region, secrets, cron configuration and cursors unless that procedure explicitly changes them.
