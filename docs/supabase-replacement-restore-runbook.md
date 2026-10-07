# Replacement-project restore rehearsal

The exact release sequence is in [Production cutover actions](production-cutover-actions.md). This document records the completed isolated restore and its supporting procedures.

Production is unchanged. Do not switch Vercel variables, local application variables, Google Pub/Sub, cron-job.org, or OAuth callbacks during this rehearsal. Do not use Aegis Watch as the destination.

## Rehearsal verified — 7 October 2026

Destination: `nvkxyeugonjevmbvxirm`, Where's My Offer, in Arush Nandakumar Menon's organization, Mumbai (`ap-south-1`). The user deleted the earlier Tokyo rehearsal project. The complete restore was repeated and verified on this replacement without changing production.

- All 61 application/Auth/Storage table counts and full COPY row-content hashes match the immutable source backup. The Auth refresh-token sequence state matches too.
- Public function signatures, RLS flags and policy expressions/roles match; constraints validate and actual foreign-key checks found no orphans. Public default privileges match the source.
- Two restored user identities each passed isolation checks on users, applications, Gmail accounts, notifications, personal emails and events. Service-role API access returns the expected 569 applications; anonymous API access returns zero private Gmail accounts.
- All 26 encrypted Gmail token fields decrypt with the retained application encryption key, without refreshing tokens or contacting Gmail.
- Source and destination managed table definitions and enums match. Platform default ACLs owned by `supabase_admin` already match and remain destination-managed. Empty managed tables are not copied, avoiding protected vector-table permissions; nonempty vector data would stop preparation.
- The separate `WMO_RESTORE_TOKEN` works for destination management access. The supplied `RESTORE_*`, `DB_PASS`, `host`, `port` and `user` variable names are supported by the tools alongside the documented `DESTINATION_*` names.

The user confirmed Vercel's Function Region is Mumbai (`bom1`) and Production environment variables remain unchanged on the existing source setup. `vercel.json` pins future deployments to `bom1`; actual runtime execution still needs verification on the later cutover deployment. No deployment was triggered here.

Remaining before cutover: compare application secrets with the production deployment, validate destination provider settings, complete isolated UI/login smoke tests, and take a final snapshot after controlling writers. The application currently authenticates through its own Google OAuth callback and signed session cookie; Supabase Google Auth settings are separate and should not be copied blindly. Production has continued receiving writes since this backup. No cron, Pub/Sub, calendar or notification delivery was switched or exercised on the restored copy.

## Cost changes verified on the Mumbai rehearsal

### Preview and final-refresh preparation — 7 October 2026

The updated isolated application preview passed 304 checks across all seven restored users, with 785 permitted read-only outbound requests and unchanged public data. It covers dashboard, analytics, search and compact-reader fallbacks as well as company pipelines. The opt-in `DATABASE_WRITES_PAUSED` request fence also passed HTTP checks: Pub/Sub, GET cron/OAuth callbacks and mutations return retryable 503 responses before dispatch, while authenticated company/progress reads continue working. The flag defaults off; it was not deployed or enabled in production.

The populated-destination data refresh was rehearsed and rolled back. Within the transaction, all 61 table counts, 34 full archived row-content comparisons (both directions, including duplicate multiplicity), and actual foreign keys pass. A temporary-row corruption exercise proved the content guard rejects incorrect data; an independent read-only export afterward confirms all 61 original table-content hashes and the sequence still match. Managed sequence finalization uses nontransactional `setval`; the rehearsal deliberately skips it. The preparer has no committing mode. The separate guarded finalizer supports explicitly authorized execution of the freshly regenerated artifact, requires fresh paused source and recovery archives, and never rewinds the sequence. Its committing path has not been run during preparation.

Supabase provider settings were compared read-only. Storage, Realtime and publication membership match; four GoTrue Google/redirect fields differ and were recorded securely for review. Real OAuth and deployed browser validation remain outstanding. See [Vercel checks and release gates](vercel-cutover-checklist.md) for the manual checks, current evidence and final cutover procedure. No Vercel token was requested or used.

- Applied additive migrations `migration_v41_roster_lookup.sql`, `migration_v42_compact_sync_progress.sql` and `migration_v43_compact_dashboard_reads.sql` only on the Mumbai replacement. Canonical rows and all original application columns still match the archive after these migrations. The comparison tool projects destination COPY data onto every original column, so additive columns do not hide changes to archived fields.
- The roster cache contains 438 attachment/sheet sources. Across seven users, 9,562 context/membership comparisons matched the canonical row evaluator. Warm response payloads totaled 3,273,207 bytes versus 79,138,059 baseline bytes for that workload (96% reduction). These are decoded test response sizes, not organization-wide billing or a daily usage forecast. The hashed location maps occupy approximately 48.3 MB before database compression.
- Shared membership hashes and lookup RPCs are service-role-only. Corrected roster data invalidates its cached revision; stale publication was rejected in a rolled-back transaction. Private user tables also passed 12 cross-user isolation checks; all 26 encrypted Gmail token fields decrypt.
- Optional readers default off: enable `ROSTER_LOOKUP_ENABLED=true` only with v41 installed, `COMPACT_SYNC_PROGRESS_ENABLED=true` only with v42 installed, and `COMPACT_DASHBOARD_READS_ENABLED=true` only with v43 installed. Missing RPCs fall back to the canonical reader. Rollback is disabling those flags; retain the additive schema and canonical data.
- Compact dashboard/status/activity reads preserve all 1,513 round rows' consumed fields and identical displays for 569 applications across seven users, reducing that workload from 1,592,970 to 512,645 response bytes (68%). Shared search preserves the latest 40 results and snippets while reducing response bytes from 127,030 to 36,831 (71%). The activity fallback follows actual personal/canonical IDs without the invalid direct relationship that caused `PGRST200`.
- Incremental new-drive syncs now restrict scanning and recalculation to touched drives, without changing eligibility or removing sibling-drive context. Completed onboarding and missing processing context retain the full-history fallback. A six-user scanner replay reduced that workload's response bytes by 11%; no new matches were produced in this recorded workload. Positive recovery and ambiguous sibling behavior are covered by separate integration tests.
- The app has 495 passing tests and a successful production build; five optional live-database tests skip in the normal suite. Five Node cutover-policy tests and the separate recorded-data rehearsals passed too. Existing recruitment labels and pipeline rendering are unchanged.
- Production has not received these optimizations. Daily egress, CPU and memory savings require a preview validation and subsequent authorized deployment, followed by at least 48 hours of provider measurements.

## Backup package

- Source: `mltfzskewmpifnyleevb`, Where'sMyOffer.
- Consistent full PostgreSQL archive: `backups/supabase-mltfzskewmpifnyleevb-2026-10-06T20-35-24-809Z/database.dump`. Manifest includes SHA-256 checksums, 64 table counts, public function signatures, extensions and RLS policies.
- Database/role archive checksums verified and SQL extracted successfully with official PostgreSQL 17.11 tools. The snapshot contains 28 public tables, seven Auth users, eight Auth identities, 13 Gmail accounts, 120 drives and 569 applications.
- Restore preparation includes application definitions/grants/RLS/data, nonempty Auth/Storage data and sequence values, and managed-schema reference SQL. Supabase-managed definitions and platform migration tables are excluded from execution. No custom Auth/Storage triggers or policies were found. Vault and Storage object data are empty; there are no Edge Functions.
- Source Auth, Storage and Realtime configuration exported securely beside the archive. Application environment values, including the token encryption key, are saved in `application-secrets.json`; these local values still need comparison with production before cutover. Treat the entire backup directory as sensitive. It is ignored by Git. Store an additional encrypted copy outside this machine before final cutover.
- All 61 extracted application/Auth/Storage COPY table counts match the consistent archive manifest. Platform migration history and empty Vault data are handled separately as described above.
- The database restore has been rehearsed on the destination above. Provider configuration, UI/login smoke tests and production cutover remain separate work.

The procedure follows [Supabase's logical backup/restore guidance](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore), using portable PostgreSQL tooling instead of Docker. Managed-schema differences must be reviewed before loading Auth/Storage data. Retain destination-managed migration history.

## Destination credentials

Create a fresh replacement project in Arush Nandakumar Menon's organization in Mumbai, aligned with Vercel `bom1`. Put the following in a separate ignored `.env.restore.local` file; keep current production values untouched:

```dotenv
DESTINATION_PROJECT_REF=
DESTINATION_DB_HOST=
DESTINATION_DB_PORT=5432
DESTINATION_DB_USER=postgres.<destination-ref>
DESTINATION_DB_PASSWORD=
DESTINATION_SUPABASE_URL=
DESTINATION_SUPABASE_ANON_KEY=
DESTINATION_SUPABASE_SERVICE_ROLE_KEY=
```

Use the Dashboard Connect panel's **session pooler** connection on port 5432, not the transaction pooler. The database credentials are needed for rehearsal; URL and API keys are needed for isolated API/RLS checks. Do not paste secrets into chat.

## Preparation and destination preflight

Run from the repository root:

```powershell
node tools/prepare-supabase-restore.mjs --backup backups/supabase-mltfzskewmpifnyleevb-2026-10-06T20-35-24-809Z --bin scratch/postgres-tools/bin
node --env-file=.env.restore.local tools/verify-supabase-restore.mjs --backup backups/supabase-mltfzskewmpifnyleevb-2026-10-06T20-35-24-809Z
```

The preparer is offline. The verifier uses a read-only transaction, rejects the source and Aegis Watch, checks the connection's destination identity, requires a fresh public schema and empty managed user tables, and checks managed COPY columns/extensions. If any check fails, stop and resolve it before restoring. Compare managed column types, enums, defaults and required destination-only columns against `managed-schema-reference.sql`; column-name checks alone are insufficient. Review `roles.sql`: platform roles already exist, so do not replay the full role file. Recreate only actual application custom roles if needed. Enable required source extensions on the destination.

Check Supabase-managed Auth/Storage version compatibility and application function dependencies. Review default privileges and grants in `application-schema.sql`. Recreate source Realtime publication membership explicitly on the destination; avoid importing platform publications or event triggers. No provider configuration is applied automatically.

## Rehearsal restore

Only after the preflight passes, use the guarded runner on a fresh destination:

```powershell
node --env-file=.env.restore.local tools/rehearse-supabase-restore.mjs --backup backups/supabase-mltfzskewmpifnyleevb-2026-10-06T20-35-24-809Z --bin scratch/postgres-tools/bin --apply
```

Without `--apply`, it performs read-only preflight. It rejects existing application tables, regenerates files from the checked archive, executes `restore.sql` with `psql --single-transaction --set ON_ERROR_STOP=1`, and runs database verification. Credentials stay in environment variables. Never put the password in command history or a database URL argument. A successful rehearsal cannot be rerun over the now-populated destination; do not erase it to make preflight pass.

The script uses `session_replication_role=replica` within the transaction to suppress restore-time triggers, creates application schema, copies managed data and application data, and reloads PostgREST. Any SQL error must roll back the transaction. Do not use `--clean`, drop schemas, truncate tables, or ignore SQL errors. If platform permissions reject a statement, diagnose it rather than removing arbitrary grant/RLS/constraint statements.

Then run:

```powershell
node --env-file=.env.restore.local tools/verify-supabase-restore.mjs --backup backups/supabase-mltfzskewmpifnyleevb-2026-10-06T20-35-24-809Z --verify
```

This compares copied table counts, public function signatures, exact RLS policy expressions/roles, source-equivalent public RLS flags, validated constraints and actual foreign-key orphans. Compare full row contents and sequences using:

```powershell
node --env-file=.env.restore.local tools/compare-restored-data.mjs --backup backups/supabase-mltfzskewmpifnyleevb-2026-10-06T20-35-24-809Z --bin scratch/postgres-tools/bin
```

The comparison checks sorted COPY row-content hashes, including roster JSON, round decisions, Gmail token ciphertext, user identifiers and event timestamps. Check application role privileges and user isolation too; no service-role-only check proves RLS isolation.

Run the read-only runtime checks without dispatching restored jobs:

```powershell
node --env-file=.env.restore.local tools/verify-restored-runtime.mjs
```

This uses destination database/API credentials explicitly and loads the retained application encryption key from `.env.local`. It does not refresh tokens, renew watches or send notifications.

## Application and configuration rehearsal

- Preserve `TOKEN_ENCRYPTION_KEY` exactly: it decrypts stored Gmail tokens and signs this application's session cookies. Retain Google OAuth credentials, Pub/Sub configuration, cron secret and Web Push VAPID keys securely. A replacement Supabase project's API keys are different. Supabase Auth sessions may require sign-in again; this app also uses its own signed session cookie.
- Review exported Auth configuration; apply only approved settings and destination-specific redirect URLs. Do not copy old project URLs/JWT secrets blindly. Storage is empty now; recheck at final snapshot in case files have been added.
- Recreate Realtime publication membership for the same application tables. Check shared progress and user notifications, preserving user isolation.
- Run the local/staging application against destination variables only after external side effects are disabled. Never trigger sync, watch renewal, notification delivery, calendar reconciliation or queue recovery against the rehearsal copy. Restored leases, pending inbox/outbox rows and watch history are historical state, not permission to dispatch.
- Check login, company list/details, timeline, screening/post-PPT/test statuses and Axxela round markers with no recomputation of production data. Confirm Gmail tokens can decrypt locally without printing them or refreshing them.
- Record every verification result and the tested destination project reference before marking the restore rehearsed.

## Later cutover, separately authorized

The source continues receiving writes, so this backup is a rehearsal baseline. A final cutover requires a short controlled pause of all writers, final consistent backup/restore, validation, destination-specific state normalization and coordinated Vercel/Google/cron configuration. Pub/Sub deliveries must remain durably captured during the pause; never let both databases dispatch the same jobs. Keep the source and encrypted backup for rollback. After destination writes begin, rollback requires reconciliation rather than a simple environment flip.

The database rehearsal wrote only to the explicitly supplied replacement project. No production deployment, provider-configuration mutation or cutover has been performed by these tools.
