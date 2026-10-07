# Supabase continuity and infrastructure cost reduction

Prepared 7 October 2026. Scope: preserve the existing application and its corrected recruitment outcomes, prevent interruption, and reduce recurring resource consumption. The implementation below remains local or on the isolated replacement; no production deployment or database cutover has been performed.

## Implementation progress — 7 October 2026

Transfer was blocked by Supabase's source-organization grace-period restriction. A full, consistent backup was restored and verified on the replacement `nvkxyeugonjevmbvxirm` in Mumbai. The user reports selecting Mumbai for Vercel too; the next deployment is pinned to `bom1`. See the [restore runbook](supabase-replacement-restore-runbook.md) for evidence and remaining cutover gates.

Implemented and tested locally: opt-in aggregate query metrics, scoped email-body reads for selected-drive recalculation, versioned roster membership lookup with safe canonical fallback, compact progress and dashboard/status/search RPCs, and one cron orchestrator sharing a deadline across wait/background modes. New-drive incremental syncs pass their touched drives to both scanning and recalculation. The scanner intersects that scope with existing participation evidence while retaining global sibling-drive metadata; onboarding and missing-context recovery retain the full scan. Watch renewal, per-user leases, checkpoint resume, and existing recruitment decisions are preserved. Additive migrations v41/v42/v43 were tested only on the replacement. The activity reader also fixes the invalid direct email relationship query reported during local testing.

The roster rehearsal compared 9,562 cases across seven users and reduced that workload's warm response payloads by 96%. A separate read-only scanner replay across six users reduced response payloads from 5,400,068 to 4,779,942 bytes (11%) when scoped to Axxela, UBS and Myntra. That recorded workload produced no new matches; mocked integration tests separately verify positive match equivalence and ambiguous sibling rejection. Compact dashboard/status/activity reads reduced response bytes 68%, preserving all 569 application displays and consumed fields from 1,513 round rows; shared search reduced response bytes 71% with identical snippets. These independent measurements do not establish daily Supabase egress or Vercel CPU/memory savings. All 495 application tests, five Node cutover-policy tests and the production build pass; five optional live-database tests skip in the ordinary suite. The isolated preview passed 304 checks and 785 permitted reads without data changes. Guarded final-refresh tooling is ready; the committing path is deliberately unexecuted. Follow [Production cutover actions](production-cutover-actions.md) for exact release commands. Remaining release work includes real OAuth/browser verification, production-secret preservation, coordinated final snapshot/cutover and measured organization-wide usage. Folder restructuring remains deferred.

## 1. Decisions and immediate priorities

1. Complete a recoverable backup and choose the continuity path on **7 October**, before the restriction date shown in the dashboard, **8 October 2026**. The screenshot warns about restrictions and possible HTTP 402 responses; it does not announce deletion. Restrictions can include read-only mode, pausing, and disabled transfers. [Supabase billing FAQ](https://supabase.com/docs/guides/platform/billing-faq)
2. Prefer **transferring the existing Where's My Offer project** to the intended organization if its eligibility and the resulting restriction status are confirmed. An organization transfer avoids creating a replacement database and changing application database identity. Verify URL, keys, connection endpoint, and service health afterward. The target screenshot shows **Arush Nandakumar Menon**, containing **Aegis Watch**; preserve that project. [Supabase project transfers](https://supabase.com/docs/guides/platform/project-transfer)
3. If transfer is unavailable or does not resolve continuity, restore into a **dedicated new Where's My Offer project**, with a rehearsed cutover. Confirm free-project capacity first. Do not rely on a transfer or a second account to guarantee restriction removal, reset historical usage, or exempt the application from provider limits.
4. Check **Vercel availability and enforcement immediately too**. CPU is already above the displayed allowance. Moving Supabase will not clear Vercel consumption. If enforcement prevents continuity before fixes can take effect, select a provider-supported bridge, such as an approved plan upgrade or support resolution. [Vercel plan behavior](https://vercel.com/docs/plans)
5. Prioritize data reads and background work. Defer the folder reorganization until continuity and usage are verified.

## 2. Evidence collected

### Dashboard evidence supplied by the owner

| Resource | Observed | Implication |
| --- | --- | --- |
| Supabase egress, current cycle | 13.188 GB / 5 GB | Already over the monthly allowance |
| 6 October PostgREST egress | 661.205 MB, 96.8% of the daily breakdown | REST response volume is the first optimization target |
| Shared pooler egress that day | 21.781 MB | Direct PostgreSQL also contributes; changing protocol alone is not a solution |
| Realtime egress that day | 424.743 KB | Disabling realtime is unlikely to address the main problem |
| Vercel Active CPU, team total | 8h 59m / 4h | The metric is CPU, not GPU; Where's My Offer accounts for almost all usage |
| Vercel provisioned memory, team total | 307.4 GB-hours / 360 | Approximately 85% consumed; other projects also use the team allowance |

Supabase quotas aggregate across projects in an organization. Reserve capacity for Aegis Watch if the projects share the destination organization. [Supabase billing model](https://supabase.com/docs/guides/platform/billing-on-supabase)

### Read-only database audit on 7 October

Queries ran inside read-only transactions and returned aggregates, not email contents or credentials.

- 7 application users, 6 with a NeoPAT ID; 7 connected personal accounts and 5 connected college accounts.
- 120 placement drives, 569 applications, 1,309 personal email records.
- 1,767 canonical college emails; their `body_text` values total **5.91 MB** before response serialization.
- 1,060 attachment records; `extracted_rows` values total **11.18 MB** as JSON text. The largest single value is approximately **980 KB**.
- 8 sheet snapshots containing **1.36 MB** of extracted JSON text.
- 1,513 round verdict records containing **1.06 MB** of verdict JSON text.
- 28 public tables, 31 public functions, 27 public RLS policies, and 7 Supabase Auth users.
- No Storage buckets or objects at audit time. Recheck at cutover; the screenshot's storage usage does not prove that files currently exist.
- Extensions include `pg_stat_statements`, `pgcrypto`, `supabase_vault`, and `uuid-ossp`.

These are current source sizes, not measured daily transfer attribution. The recurring REST traffic is much larger than the source dataset. Endpoint-level measurements are still required to establish how much each caller contributes.

### Confirmed code paths that need work

| Priority | Code location | Finding | Planned correction |
| --- | --- | --- | --- |
| P1 | `src/lib/sync/reprocess.ts`, `recalculateApplicationStatusesUnlocked`, approximately lines 108–226 and 451 | Personal email history and all canonical college bodies are loaded before `targetPlacementDriveIds` restricts processing | Apply drive/source selection before database reads; preserve the complete evidence needed for each selected drive |
| P1 | `src/lib/sync/engine.ts`, approximately lines 2648–2725 | A new company or completed initial page can still trigger broad candidate scanning and full recalculation; queued drive updates invoke the same expensive loader | Incremental jobs must process changed drives, changed evidence versions, and explicitly unresolved links only |
| P1 | `src/lib/sync/round-verdict-service.ts`, approximately lines 24–31; `attachment-scanner.ts`, approximately line 488 | Candidate decisions fetch entire attachment rosters and sheet snapshots into Node | Persist reusable identity/membership facts per roster version; return compact facts to the existing verdict resolver |
| P1 | `src/lib/sync/shared-college-ingest.ts`, `fanOutSharedCollegeArchiveToUser` | Reads the complete archive catalog, then matching bodies and extracted rows per user; nested drive/circular comparisons | Resolve canonical source-to-drive links once; replay only relevant sources for onboarding or repair |
| P2 | `src/app/(dashboard)/companies/page.tsx`, approximately lines 34–80 | Loads global companies/drives and multiple user histories; retrieves full verdict JSON | A compact user-scoped list query and compact round summaries, with legacy/shared metadata behavior preserved |
| P2 | `src/context/sync-context.tsx`, line 201; sync status routes | Active fallback polling runs every 2.5 seconds; status reads include complete message-ID arrays just to compute counts | Return counts/progress directly; coalesce visible-tab polling and share authorized status snapshots briefly |
| P2 | `src/app/api/webhooks/gmail/route.ts` | Returns success before `after()` processing; background failure therefore does not automatically cause Pub/Sub redelivery | Durable queue recovery for acknowledged failures, coalesced mailbox history ranges, bounded retries |
| P2 | `src/app/api/cron/sync/route.ts` | Async path has a shared budget; `wait=true` follows a separate serial path without that shared deadline/renewal routine | Use one bounded orchestration path while retaining watch renewal, deadline alerts, cleanup, and user locks |
| P0 | `scripts/backup-db.js`, `scripts/restore-db.js` | Current backup is public data INSERTs only; both scripts hardcode the existing project connection, and restore SQL truncates tables | Do not use these as migration assurance; prepare a verified complete export/restore procedure |

Existing improvements should stay: hidden-tab polling guards, idle-stop behavior in Campus Radar, throttled progress writes, canonical parsing, mutation leases, and the no-new-mail heavy-work gate. They do not eliminate the remaining broad reads.

## 3. Continuity runbook — finish before 8 October

### A. Secure a complete recovery package

Before any transfer or cutover:

1. Record the deployed Git commit, provider cycle dates, current service health, source project identity, destination membership/capacity, and enabled integrations.
2. Export schema, data, relevant roles/grants, migration history, and custom managed-schema changes using the official Supabase CLI/PostgreSQL process. Include Auth records and identities; compare them explicitly after restoration. Check triggers, RLS, sequences, extensions, publications, and every RPC used for locks, outboxes, and event reconciliation. A public-table data dump is insufficient. [Official backup and restore procedure](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
3. Use a consistent data snapshot. Separate CLI exports must not be assumed to represent one point in time while live writes continue. Rehearsal can use an earlier backup; a replacement-project cutover needs a final frozen snapshot or a verified delta process.
4. Inventory Vault usage and encrypted columns. Preserve or migrate required database encryption keys through the documented procedure. Never print decrypted values. The presence of the Vault extension alone does not establish that the app uses Vault secrets.
5. Inventory Storage separately; if objects appear, export their bytes and metadata/policies. Recreating `storage.objects` records is not a file transfer.
6. Store timestamped dumps, checksums, a schema manifest, and a securely stored configuration inventory outside version control. Account for the one-time backup/restore traffic separately from normal daily consumption.

### B. Prefer a verified organization transfer

- The source account must own the source organization. Grant the appropriate destination membership through the provider's account controls.
- Check transfer eligibility: integrations, log drains, roles, free-project limits, and any restriction on project transfers.
- Back up first, transfer through the supported dashboard workflow, and confirm source/target billing behavior and actual target service availability. Usage before transfer is assigned to the source organization and subsequent usage to the target under the documented billing rules. [Transfer requirements and billing](https://supabase.com/docs/guides/platform/project-transfer)
- Verify the project endpoint, keys, encrypted Gmail access, application sessions, persisted cursors, cron, and Pub/Sub processing. Do not change database environment variables if the project identity remains unchanged.
- Abort this path if provider checks indicate it will not preserve availability. Do not delete the source project.

### C. Replacement project fallback

1. Create a dedicated destination project. The replacement is now in Mumbai (`ap-south-1`); the user confirmed Vercel `bom1`, and `vercel.json` pins future deployments there. A transfer keeps the current project region; a new project can use a different region.
2. Restore the recovery package into that destination and validate it before pointing any production deployment at it. Preserve UUIDs and foreign-key relationships, canonical identities, user outcomes, manual overrides, candidate matches, notification dedupe records, calendar IDs, inbox/outbox state, watch expiry, Gmail history cursors, and sync checkpoints.
3. Preserve these configuration values securely: `TOKEN_ENCRYPTION_KEY`, Google client credentials/redirects, Pub/Sub topic/audience/service account, designated shared college inbox and its sync flag, cron secret, VAPID keys, and other enabled integrations. Change only project-specific Supabase URL/API keys/database connection values. Search all scripts/tools for hardcoded source connections.
4. The app's session JWT and AES-GCM Gmail token encryption both use `TOKEN_ENCRYPTION_KEY`. Keep it byte-for-byte identical during cutover. The app also has 7 Supabase Auth users, so migrate both application records and managed Auth data; do not assume custom sessions make Auth data disposable. Supabase-issued sessions may require reauthentication if project signing configuration changes. [Auth migration considerations](https://supabase.com/docs/guides/troubleshooting/migrating-auth-users-between-projects)
5. Rehearse on an isolated deployment. Reads are allowed; disable outbound notifications/calendar mutations and real sync triggers until validation passes. A preview deployment must not consume production webhook work or renew watches against a rehearsal database.
6. Implement and verify a temporary write-maintenance gate before the final snapshot. Cover manual/admin sync, settings and status edits, OAuth callbacks, calendar/notification writes, webhooks, and cron. Drain running work; do not clear valid locks underneath active jobs. Temporarily suspend the external cron with a recorded restart step.
7. During the freeze, return retryable non-success responses for valid new webhook deliveries that cannot be durably accepted. Do not return success and discard them. Existing deliveries already acknowledged into `gmail_pubsub_inbox` require migration and explicit recovery; Pub/Sub will not replay them just because an `after()` task failed.
8. Export/restore the final consistent state and update all production database environment variables together. Rebuild/redeploy for changed `NEXT_PUBLIC_*` values. Keep the public app URL, Google callback, and Pub/Sub destination unchanged where possible.
9. After the new deployment is healthy, open writes, replay pending durable jobs under leases, and catch up Gmail history incrementally. Preserve watch renewal and restart cron. Do not reset all mailbox cursors or replay historical notifications.
10. Retain the original project and backup. Before new writes, rollback is a configuration/deployment switch if the old service is available. After new writes, rollback requires controlled queue/data reconciliation; blindly switching databases loses updates. If the source is restricted, restoration elsewhere or provider assistance is the fallback, not an unavailable source endpoint.

### Cutover acceptance gate

- Compare actual source and destination counts/checksums, UUIDs, foreign keys, sequences, function signatures, policies, and indexes, not just the migration files in Git.
- Confirm both users from the shortlist incidents retain identical statuses, evidence, crossed pipeline bubbles, manual overrides, and drive identities.
- Verify one representative sign-in/session, encrypted Gmail token decryption, one personal eligibility/registration update, one shared circular, and one duplicate webhook.
- Verify concurrent cron/manual/webhook requests skip live leases safely; interrupted work resumes from checkpoints.
- Verify no historical push/calendar replay, existing calendar IDs remain linked, and all watches/cron recover.
- Recheck counts at the final freeze; the audit numbers above are a baseline, not immutable expected counts.

## 4. Resource targets and instrumentation

| Metric | Normal operating target | Upper budget / acceptance |
| --- | --- | --- |
| Total destination-org egress | **120 MB/day or less** | **150 MB/day**, with a monthly forecast below 5 GB including all projects |
| Vercel team Active CPU | **3 hours/month or less** | Below 4 hours/month; roughly 6 minutes/day average for the 3-hour target |
| Vercel team provisioned memory | **270 GB-hours/month or less** | Below 360 GB-hours/month; roughly 9 GB-hours/day for the target |
| Warm drive-specific status update | Only selected drive evidence | No whole-archive body or roster fetch; identical verdicts and side effects |
| Idle/no-placement-data sync | Small account/cursor/lease/due-work reads | No archive-body scans, roster downloads, or historical classification |

At 150 decimal MB/day, 31 days consume about 4.65 GB, leaving little organization-wide headroom. A suggested initial allocation is 90 MB/day for Where's My Offer, 20 MB/day for other projects, and 10 MB/day reserve inside the 120 MB target; revise using measured traffic. Around 700 to 150 MB/day requires approximately **79% reduction**. Targets are acceptance criteria, not a promised result at every user count.

Instrument the central transport in `src/lib/supabase/admin.ts` and the direct PostgreSQL tools:

- Record operation label, table/RPC, caller route/job type, query count, response-size estimate, latency, rows when available, cache hit/miss, and run ID. Strip filters, tokens, email addresses, and bodies from metrics.
- For large responses, count bytes as the response is consumed without buffering an additional full copy. Distinguish application payload estimates from provider-metered traffic and reconcile with the dashboard.
- Aggregate per invocation and emit sampled summaries, not a log entry per cell/query. Instrument Vercel wall time, active CPU samples, peak RSS, processed messages, and changed drives; use provider metrics for billed instance time.
- Inspect current Vercel function regions, execution durations, invocation counts, errors, and top paths. Include admin activity, local tools hitting production, and pending/failed queue recovery in attribution.
- Compare equivalent workloads before/after. Keep emergency backup/reprocess traffic outside the recurring baseline and include it in monthly totals.

## 5. Implementation order for egress and compute

### P1 — Make targeted updates genuinely targeted

First measure a one-drive queued recalculation, then change only its data acquisition layer.

- Build the selected drive set before querying. Fetch personal evidence for those drives and canonical sources referenced by resolved links, source IDs, round evidence, and a bounded unresolved-correlation fallback.
- Persist canonical source-to-drive resolution so ambiguous shared sources are not repeatedly matched against the full archive. Preserve role/drive separation and admin exclusions. Handle onboarding and newly eligible drives explicitly so incremental cursors do not miss older relevant evidence.
- A new drive needs a backfill for that drive, not every drive belonging to that user. A new circular needs only affected users/drives. Coalesce `pending_drive_recalculations` with evidence revisions under the existing mutation lease.
- Cache immutable source data by content hash/parser version, but recalculate user outcomes when identity, scope, source linkage, manual overrides, or mutable sheet versions change.
- Retain the current verdict resolver and its notifications/events commit transaction. Use a shadow comparison on recorded fixtures before replacing broad reads.

**Acceptance:** warm one-drive updates do not request unrelated email bodies; new eligible drives still receive historical relevant circulars; duplicate/idle syncs do no historical work; old and new verdict outputs match.

### P1 — Stop sending full rosters to Node for every user

- Keep raw rosters for provenance and repair. During the existing once-per-version parse, index strong normalized candidate identities and preserve row disposition, round/role scope, parse completeness, source hash, and provenance.
- Use a restricted batched server query/RPC to return compact membership evidence for a user and selected sources. A successful absence decision requires a complete applicable roster; an incomplete parse or different role must retain the resolver's existing uncertainty behavior.
- Index NeoPAT IDs, registration numbers, and email tokens with the exact matching normalization already used. Names alone must not introduce shortlist positives.
- Compare indexed facts against the existing matcher on real recorded cases before activation. Unindexed sources use a bounded compatibility path; backfill the index once in controlled batches.
- Reuse matching facts across shared ingestion, candidate scanning, and round calculation. Do not download the same snapshot again in the same job.

**Acceptance:** repeated checks of an unchanged indexed roster transfer compact facts only, including scoped absence; no new status labels or change to elimination-stage rules.

### P2 — Compact reads and safe cache invalidation

- Return list-ready drive cards and compact round summaries through a user-scoped read model. Fetch only referenced shared companies/drives. Preserve legacy application rows and metadata fallback semantics.
- Compute latest circular timestamps, counts, and next events in SQL rather than returning histories that Node reduces. Replace broad `select('*')` where it materially affects payloads.
- On detail pages, avoid duplicate canonical-body reads. Load additional timeline content only when needed while preserving the current visible content and access controls.
- Use request-level deduplication and a bounded shared cache for canonical metadata. Cache private summaries with explicit user identity and evidence/data revision keys; invalidate after actual changes, manual edits, and time-based transitions. Shared cache entries must never contain private tokens or another user's outcomes.
- Follow the installed Next.js 16.3 guides. `staleTimes` in `next.config.ts` is client router caching, not an established persistent database cache. Ordinary `use cache` needs Cache Components and defaults to memory storage; do not assume cross-instance persistence. Evaluate a compatible cache boundary without enabling a broad application rewrite. `unstable_cache` is marked replaced in the installed guide, so select the implementation deliberately and test it.
- Keep active sync progress uncached or very briefly coalesced; compute page/pending counts in a narrow query instead of returning message-ID arrays. One visible tab per user should poll; maintain hidden/idle stop behavior. Avoid redundant `router.refresh()` calls for unchanged data.

**Acceptance:** user isolation passes, updates and deadline transitions invalidate correctly, card/pipeline text stays identical, and repeated navigation does not redownload the same histories.

### P2 — Bound job duration and recover acknowledged work

- Preserve DB leases and checkpoint every batch. Coalesce repeated mailbox notifications into a persisted highest pending Gmail history cursor, advancing the committed cursor only after work succeeds.
- Add a bounded recovery drain for pending/failed inbox/outbox records already acknowledged by the webhook. Ensure its retry scheduling works independently of a browser and within the recovery latency target. Do not rely only on the next day's cron for urgent placement alerts.
- Use one wall-clock deadline for shared ingestion, per-user sync, status calculation, and maintenance, including cron's `wait=true` path. Propagate it into inner parsing/fan-out loops; a check between large batches alone does not stop an overlong batch.
- Keep daily 00:00 IST watch renewal, deadline/live-event alerts, stale page cleanup, and persisted progress. Do not remove these to make resource graphs look better.
- Parse XLSX/PDF and classify canonical college content once per changed version. Release batch references promptly and avoid building unbounded full-history maps. Do not retry malformed/terminal records indefinitely.
- Keep SSE only while useful work executes and close all timers/streams reliably. `after()` moves work past the response; it does not remove billed work or create an independent durable worker.

Vercel counts active code execution toward CPU and in-flight instance lifetime toward provisioned memory, including external waits. Reducing unnecessary parsing helps CPU; reducing long database/network waits and repeated work helps both duration and memory. [Fluid compute billing](https://vercel.com/docs/functions/usage-and-pricing)

Hobby Fluid functions use the default **2 GB / 1 vCPU** configuration and cannot be resized by setting `memory` in `vercel.json`. Focus on finishing work sooner, aligning the function/database regions where supported, and avoiding duplicate invocations. Lowering actual JavaScript heap usage alone does not reduce the fixed allocation rate. [Vercel memory configuration](https://vercel.com/docs/functions/configuring-functions/memory)

If measured workload still cannot meet the budget, prepare a separate bounded worker deployment for canonical ingestion and queue processing, with its own verified provider costs and limits. Keep webhooks/auth/UI on the web app where appropriate. Moving work is a later measured architecture decision; it does not eliminate the work or justify another unbounded polling loop.

## 6. Validation, rollout, and rollback

Deliver separate changes in this order:

1. **Continuity package/transfer or rehearsed cutover**, before 8 October.
2. **Low-volume instrumentation and SQL-level drive filtering**, first implementation priority.
3. **Indexed roster facts and shared source linking**, additive schema and controlled backfill.
4. **Compact dashboard reads, caching, and status polling**.
5. **Bounded orchestration, durable recovery, and CPU parsing improvements**; fix any cutover-critical recovery gate earlier.

Each behavioral implementation runs type checking, the relevant sync/status/matching tests, and a production build. Test migration restoration separately. Add meaningful regression/performance checks for selected-drive query scope, positive/negative roster equivalence, cache isolation/invalidation, duplicate delivery, lease contention, and checkpoint resume. Do not run an all-user production reprocess as a performance test.

Replay representative captured workloads offline or in a side-effect-disabled staging environment: idle sync, irrelevant new mail, one eligible drive, one shared roster across six onboarded users, mutable-sheet revision, a duplicate webhook burst, and interrupted jobs. Preserve screening versus post-PPT rejection, test participation requirements, and Axxela's game-round cross placement exactly.

Roll out behind separate feature switches where behavior changes. Compare the old and new decisions without sending duplicate notifications. Revert an optimization's reader/worker implementation if equivalence fails while retaining additive indexes and raw evidence. For database cutover, use the stricter rollback procedure above.

Measure at least 48 hours after deployment, accounting for dashboard reporting lag. Reconcile per-route bytes and CPU with provider usage; report actual reductions, not assumed savings. Forecast usage for the remaining billing period as well as the next full month. Reduced future usage does not erase the 13.188 GB or 8h 59m already recorded.

For growth, measure the shared daily baseline and incremental cost per active user/job. Forecast `shared work + active users × private work + onboarding/repair bursts + other-project usage`. Exercise 6-, 20-, and 100-user equivalent workloads in staging; do not promise that a fixed free allowance supports arbitrary scale. If the forecast exceeds the target, reduce measured amplification further or choose an explicit infrastructure budget.

## 7. Information needed when executing

The Mumbai application preview and rolled-back populated refresh are now verified. The opt-in cutover writer fence defaults off and is not deployed. Continue using [the Vercel checklist and release gates](vercel-cutover-checklist.md); no Vercel token is needed. Real OAuth/browser validation, final source capture, committed refresh, deployment and live cost measurements remain release steps.

- Source-owner and destination-member access; confirm that the target is the organization shown as **Arush Nandakumar Menon** and whether transfer is allowed there.
- Provider dashboard verification of current restriction/enforcement status, cycle/reset dates, destination capacity, and Vercel function regions/top consumers.
- Secure destination project credentials only if using a new project; enter them through the environment/secret manager, not a public document or chat transcript.
- An agreed maintenance window and a provider-supported continuity bridge if either platform restricts service before cutover or quota recovery.

The source audit and backup use read-only database transactions. Rehearsal restores and additive cache migrations wrote only to the supplied replacement project. The production app, cron-job.org schedule, database environment values, recruitment labels and folder structure remain unchanged by this implementation. The user's Vercel region change is recorded above.
