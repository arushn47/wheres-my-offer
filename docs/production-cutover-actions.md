# Production cutover actions

Prepared 7 October 2026. Local preparation is complete; production has not been deployed, paused, switched or modified by these tools. Source is `mltfzskewmpifnyleevb`; replacement is `nvkxyeugonjevmbvxirm` in Mumbai. Vercel `bom1` is already confirmed. No Vercel token is needed.

## Verified release evidence

- 499 application tests pass; five optional database tests skip in the ordinary suite. Five Node cutover-policy tests pass. Production build/type checking and targeted lint pass. This includes the later Foodhub correction: the interview shortlist after the assessment is not a PPT-only screening list, and earlier verified test participation is retained for existing stored evidence.
- Read-only recorded-data tests compare all 1,513 round rows and all 569 application displays across seven users. Round summaries, detail roster states, selected-drive scope, and activity timestamps match the canonical readers. The activity fallback uses the actual `email_drive_links -> personal_emails -> college_emails` path with explicit reads, avoiding the invalid direct PostgREST relationship.
- Dashboard/status/activity response payloads fall from 1,592,970 to 512,645 bytes (68%) in that workload. The latest 40 shared search rows fall from 127,030 to 36,831 bytes (71%), with identical displayed/searchable snippets. Earlier warm roster lookup measurements showed 96% less response data for the recorded matching workload. These percentages are separate workload measurements, not additive and not a daily billing forecast.
- The isolated destination application passes 304 HTTP/build/bundle/privacy/fence checks across seven users, including compact and canonical fallback page reads. All 785 outbound runtime calls are allowed reads and public rows remain unchanged. These synthetic sessions do not prove browser hydration or real Google OAuth.
- Full populated refresh rehearses inside a transaction ending in rollback. Counts, 34 full archived row-content comparisons and actual foreign keys pass. A corruption exercise changes only a temporary expected row and proves the full-content guard aborts the transaction. Independent original-column hashes and the managed sequence match afterward.
- Migrations v41/v42/v43 are installed only on the replacement. The roster cache is derived and cleared during final refresh; it warms lazily from canonical data using the unchanged matching policy.

## 1. Begin a controlled maintenance window

The tested code is still local. Publishing it is a release action; do not redeploy an older revision and assume the new pause flag will work there.

1. In **Vercel -> this project -> Settings -> Environment Variables -> Production**, set `DATABASE_WRITES_PAUSED=true`. Keep the three current production Supabase URL/key values and all application secrets unchanged. Keep the optimization flags false/unset on this source deployment.
2. Publish/deploy the tested revision containing the proxy writer fence, using the normal Git/Vercel release process. Setting the environment variable alone does not pause an existing deployment. Keep `bom1`.
3. Protect/disable older deployment URLs and stop local source-connected development servers, scripts and integrations that can write directly. Let active work finish; do not forcibly clear live locks. Check Vercel's in-flight invocations, including OAuth/admin/calendar/notification requests. The database lease check cannot detect every possible direct writer.
4. Pause the existing **cron-job.org job 8265126** during the window. Keep the Google Pub/Sub push URL/topic/audience unchanged. Before the pause, check the subscription's retention/retry/dead-letter configuration can retain deliveries for the maintenance window; do not acknowledge/discard queued deliveries or create a second webhook.
5. Run the preflight below. It requires actual maintenance 503 responses on anonymous cron/OAuth/sync probes and zero source/destination sync, shared, Pub/Sub and archive leases. If it fails, keep the source variables and wait/resolve the named condition.

```powershell
node tools/cutover-preflight.mjs --require-paused
```

Tools parse `.env.local` and `.env.restore.local` separately. Do not combine them into one process environment: on Windows, source `db_pass` and destination `DB_PASS` collide case-insensitively. Neither local file needs modification for the refresh commands below.

## 2. Capture final source and destination recovery archives

Only after the pause is verified and other writers are drained:

```powershell
node tools/supabase-backup.mjs --bin scratch/postgres-tools/bin --cutover --writers-drained
node tools/supabase-backup.mjs --bin scratch/postgres-tools/bin --destination --cutover --writers-drained
```

Record each command's **backupDirectory** output. The first is the final source snapshot; the second is replacement recovery. `--writers-drained` is an explicit attestation that the manual older-deployment/direct-writer checks above are complete, not a way to bypass them. The backup tool also verifies the HTTP pause and database leases itself. Keep an encrypted off-machine copy of recovery material and retain the encryption key separately. Backups contain private user/mail data and must stay out of Git.

Archives must be under 30 minutes old when final refresh starts. If the window runs longer, capture fresh paused backups. A nonempty Vault or newly added Storage objects requires a separate supported secrets/object-byte migration; the preparer stops rather than silently restoring only metadata.

## 3. Refresh and verify the replacement

Use the freshly printed directories, not yesterday's rehearsal archive. Replace the two uppercase placeholders with those actual paths:

```powershell
node tools/finalize-replacement-refresh.mjs --backup "FINAL_SOURCE_BACKUP_DIRECTORY" --recovery-backup "DESTINATION_RECOVERY_BACKUP_DIRECTORY" --bin scratch/postgres-tools/bin --apply --writers-drained
```

Without `--apply`, the tool only rehearses and rolls back. The committing path checks both archive identities/ages/pause attestations/checksums, verifies the production HTTP fence, checks both databases' live leases, regenerates/rehearses the final SQL, and rechecks the fence immediately before execution. Only the pinned replacement can be modified. It preserves source tables' original data, destination-managed schema/migrations and additive optimizations; it clears only derived roster indexes. The managed Auth sequence advances to at least the archive/imported/current high-water mark and never rewinds.

After commit, the tool verifies table counts, original-column content hashes, functions/RLS/FKs, sequence safety, private-user isolation, token decryption, API counts, and service-only cost RPCs. Success explicitly reports `validated:true`, `deploymentChanged:false`, `writersReleased:false`. A failure requires inspecting the ignored backup diagnostics while keeping production paused; do not automatically flip databases or open writes. The committing path has intentionally not been executed during preparation.

## 4. Switch Vercel while keeping writes paused

Only after the final refresh reports success, change these **Production** values together, using the values already in `.env.restore.local`:

| Vercel variable | Replacement value from local file |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `RESTORE_SUPABASE_URL` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `RESTORE_SUPABASE_ANON_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` | `RESTORE_SUPABASE_SERVICE_ROLE_KEY` |

Also set:

```dotenv
DATABASE_WRITES_PAUSED=true
ROSTER_LOOKUP_ENABLED=true
COMPACT_SYNC_PROGRESS_ENABLED=true
COMPACT_DASHBOARD_READS_ENABLED=true
SUPABASE_QUERY_METRICS=false
```

Retain `TOKEN_ENCRYPTION_KEY`, Google OAuth credentials/redirect URI, Pub/Sub configuration, `CRON_SECRET`, VAPID keys and existing application settings exactly. Do not add database passwords or management tokens to public variables. Application runtime code uses only the three Supabase URL/key values above for its database clients.

Create a **fresh build/deployment** with these values; public Supabase values are embedded at build time. Do not promote an old source-bound or synthetic preview build. Check actual function execution is `bom1`. Using existing signed-in sessions, verify company lists/details, the screening/post-PPT/Game round markers, timeline and progress. Writes and OAuth callbacks should still return maintenance responses at this stage; test real OAuth after release, when token writes are allowed.

## 5. Release writers and measure

1. Set Production `DATABASE_WRITES_PAUSED=false` and deploy again, retaining replacement URL/keys and optimization flags.
2. Resume the same cron-job.org job and run it once as the controlled catch-up/watch-renewal pass. Let the existing Pub/Sub subscription retry retained deliveries. Do not reset mailbox cursors, replay all historical emails, or run an all-user reprocess.
3. Verify real sign-in, one normal incremental sync, progress restoration, watch renewal, notifications and calendar behavior. Check for duplicate deliveries and runtime/database errors. Retain the source and backups; after destination writes start, rollback requires reconciling new state rather than simply changing environment variables.
4. Measure organization-wide Supabase egress and Vercel CPU/memory rates for at least 48 hours. Target <=120 MB/day normally, with 150 MB/day as the ceiling including Aegis Watch/other organization traffic. The exact daily target is not proven until deployed provider measurements are available.

No new credential is needed for the prepared database work. The remaining human actions are the Vercel release/environment changes, older-writer protection, Pub/Sub retention review, temporary cron pause/resume, and deployed browser/OAuth checks. Database capture/refresh/verification can be run by the agent during the explicitly authorized maintenance window.
