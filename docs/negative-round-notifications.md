Negative round notifications
============================

The previous path persisted negative round verdicts but only queued and dispatched positive eligibility. The application and v47 RPC gates now allow current, confirmed negative verdicts for participating users. A confirmed absence requires `verified_absent`, `finalNegative=true`, `complete_list_absence`, and a verified absent scan (or an explicit personal rejection). Withdrawn, declined, not-applied, registration-open, unknown, and manually overridden applications are excluded. Partial and deferred lists cannot notify. Shortlist preferences govern both outcomes; positive keys and delivery behavior stay intact.

Negative alerts use `shortlist_absent:<user>:<drive>`, the existing legacy identity. One elimination alert per user/pipeline is retained even if read, dismissed, superseded, or recomputed from another roster. Sibling drives remain separate. Positive requalification supersedes the negative display; it does not delete the dedupe ledger. Both delivery and the push claim recheck current outcome and participation. Negative alerts display a negative icon/neutral warning toast instead of congratulations.

The existing 48-hour notification freshness window remains. Shared outbox dispatch stays coalesced and immediate, including when a pending negative is moved to a new current decision. No Gmail watch, cursor, sync schedule, event reconciliation, or status mapping changes were made. The partial-list recognizer additionally handles “Additional Selection List”, “(Additional)”, and “Set-1”. No historical verdicts are rewritten by the migration.

Local verification
------------------

Application regression tests cover immediate delivery, positive delivery, preferences, retry, current outcome changes, inactive users, partial evidence, and replay. The local PostgreSQL tests apply the actual v47 migration twice over the previous commit RPC in an in-memory WASM database. They test queue/claim gates, status/verdict/outbox rollback, lease loss, overrides, legacy dedupe, recovery, and service-only privileges. No production credentials are read by these SQL tests.

To install the isolated test runtime and run SQL tests:

```powershell
npm install --prefix scratch/sql-test-runtime --no-save --package-lock=false @electric-sql/pglite@0.3.14
node --test tools/negative-round-rpcs.test.mjs
```

The SQL test explicitly reports skipped if that optional scratch runtime is absent. Application tests use the normal Vitest suite. Do not enable live database integration tests for local validation.

Production sequence — requires approval
---------------------------------------

1. Review and apply `supabase/migrations/migration_v47_negative_round_notifications.sql`, then deploy the application changes. This migration is separate from the pending v46 security migration. It only replaces/adds notification functions; it does not backfill records. Applying SQL first is compatible with the old application, which still cannot construct negative payloads. Keep the application fix and v47 together: a new app against the old RPCs would still drop negative outbox entries.
2. Verify a natural confirmed result: one notification per pipeline, correct in-app outcome, and successful push when enabled/subscribed. A provider delivery timestamp means the push service accepted delivery, not proof the OS displayed a banner.
3. Preview missed alerts with an explicit interval of at most 24 hours:

```powershell
node tools/preview-negative-round-recovery.mjs 2026-10-08T18:30:00Z 2026-10-09T18:30:00Z
```

This tool is read-only, pins the configured Mumbai destination, enforces the 48-hour freshness limit, excludes earlier elimination verdicts, inactive users, existing negative alert ledgers, and partial/unverifiable college sources. It writes a private manifest under ignored `scratch/`. It has no enqueue/send mode. At the October 9 review it returned five user/drive candidates: Tata Technologies (two), Malomatia (two), and Valeo (one).

4. Review the exact decision/source IDs and roster identity in that manifest. Re-run the preview before recovery; candidates may age out, become superseded, or be delivered naturally by a normal sync after deployment. Approval is needed before sending recovery alerts.
5. Under a normally acquired persisted per-user lease, invoke `recoverNegativeRoundNotifications` with only the approved saved decision IDs (maximum 20 per call). No endpoint or automatic recovery job was added. The helper calls `enqueue_negative_round_notification` and the ordinary dispatcher. SQL rechecks current verdict, participation, freshness and dedupe under the same lock order as a normal commit. It queues existing decisions only; it does not reset cursors, parse rosters, reprocess drives, update applications/events, or start sync. Call it from an approved maintenance wrapper that acquires/releases the normal lease; never invent a run ID or clear an active lease.

No migration, deployment, enqueue, or recovery send was executed during local implementation. Old alerts outside 48 hours are intentionally excluded. If recovery is delayed beyond that window, review a separate explicit policy; do not edit source timestamps to force eligibility.
