# Shared College Archive Refresh Runbook

This runbook is for the pre-launch archive refresh. **Do not run write mode until the dry-run reports and samples have been reviewed.** No live refresh or migration has been run by the code changes in this branch.

## Current behavior after the code change

- Per-user Gmail sync reads Personal inboxes only. College inboxes are not scanned by a user's Campus Radar sync.
- A central College ingestion worker is implemented in `src/lib/sync/shared-college-sync.ts`; it requires v35 and is invoked by Pub/Sub for the configured shared mailbox plus the scheduled cron safety net. Do not report it operational until v35 is applied and the new deployment is running.
- A College circular can enrich the global company/drive catalog, but alone can no longer create a user application, event, shortlist match, or notification.
- At the end of completed sync batches, shortlist matching checks already-parsed shared College workbooks for this user's tracked drives. Shared workbook matches are idempotent via `candidate_matches` uniqueness.
- Applications without Personal-email evidence, a genuine shortlist match, or a manual override are excluded during reprocessing. No historical application cleanup is run automatically.
- Admin System provides **Read-only Archive Audit** and **Refresh Preview · Dry Run**. These only read Gmail/database data and parse attachments in memory.

## 1. Preflight

1. Back up production and run the v32/v33/v35 preflight queries on a staging copy first.
2. Inspect counts and samples from the admin archive audit.
3. Verify that the specified connected College mailbox (`SHARED_COLLEGE_EMAIL`, defaulting to `arush.23bce10472@vitbhopal.ac.in`) is the intended shared source and contains the full `vitlions2027` feed.
4. Review `college_attachments` parse-state/error samples and existing `content_hash` collisions. Identical attachment files may legitimately appear on different circulars; they must not be deleted or merged across different parent messages.
5. Review the audit's unsupported per-user application samples. Keep them as a report; do not delete automatically.

## 2. Apply migrations (not applied by this code change)

Apply these in order in staging, verify, then production during a quiet window:

1. `supabase/migrations/migration_v32_shared_college_archive_refresh.sql`
   - Adds `received_at`, `parser_version`, per-circular attachment `content_key`, and `parse_error`.
   - Fails safely if duplicate `(college_email_id, attachment_id)` rows exist. It does not delete archive rows.
   - Removes the historical globally unique attachment hash constraint because the same file hash can occur on multiple circulars.
2. `supabase/migrations/migration_v33_shared_archive_refresh_lease.sql`
   - Adds a service-role-only singleton lease to prevent concurrent write refreshes.
3. `supabase/migrations/migration_v35_shared_college_sync.sql`
   - Adds a per-mailbox lease for central College history ingestion.

Verify the exact live project/database after applying migrations; do not infer success from the local migration files or a different Supabase project ref.

The older `supabase/schema.sql` remains a pre-rename snapshot using `canonical_*` table names. Do not use it to recreate production. The migrations above target the live post-v28 `college_*` names.

## 3. Preview

1. Open **Admin → System → Read-only Archive Audit** and save the report.
2. Run **Refresh Preview · Dry Run** through every Gmail page token. It pins a cutoff date and reports each page's canonical rows that would be reused/created and workbook attachment parse outcomes.
3. Review error samples, attachment sizes, and the final page. The current refresh code supports XLS/XLSX/CSV extraction up to 20 MiB per file. PDF/DOC/image attachments remain logged/deferred for workbook-row extraction; bodies can still be refreshed.
4. Confirm the connected source mailbox covers the full 1,866-message archive and that the drive/company parses match expected samples.

Dry-run fetches Gmail metadata, full message bodies, and attachments for parsing, so it consumes Gmail read quota and bandwidth; it performs no DB writes.

## 4. Controlled write refresh (separate explicit launch operation)

1. Configure a strong `ARCHIVE_REFRESH_CONFIRMATION` server secret.
2. After approving the preview, invoke `POST /api/admin/canonical/refresh` with `{ "dryRun": false, "limit": 50, "before": "<approved cutoff>" }` and header `x-archive-refresh-confirmation` containing the secret.
3. Continue with the returned Gmail page cursor, preserving the same cutoff. The database lease prevents overlapping write batches.
4. Save each batch result. Stop on unexpected error spikes; reruns are idempotent by canonical message/content key and per-circular attachment key.
5. Run the read-only audit again and compare missing bodies, parser versions, classifications, metadata, workbook rows, and errors.

The current admin UI intentionally exposes **preview only**, not write mode. The write endpoint is confirmation-gated but should be invoked only after manual review and a backup.

## 5. Enable central College ingestion

- Set `SHARED_COLLEGE_EMAIL=arush.23bce10472@vitbhopal.ac.in` in the server environment and verify its Gmail watch/Pub/Sub registration.
- Apply v35 before deploying/enabling the central sync worker.
- Verify duplicate Pub/Sub delivery is deduped, each circular is ingested once, and user fan-out only runs for Personal-receipt or confirmed-shortlist evidence.
- Set `SHARED_COLLEGE_SYNC_ENABLED=true` on the server for the daily central sweep after webhook validation.
- Do not re-enable College Gmail processing from a user's Campus Radar; College connections remain optional fallback accounts, not per-user sync input.

## 6. User-data cleanup (later launch step)

- Use audit output to produce a per-user/per-drive cleanup candidate list.
- Review every candidate with application status, manual override, Personal email receipts, confirmed shortlist matches, and notification/event references.
- Apply cleanup only after approval; never delete global companies, drives, circulars, or shared attachments as part of user cleanup.
- Existing user applications remain untouched until an explicit, reviewed cleanup is approved.
