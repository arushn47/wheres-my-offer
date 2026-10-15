# Supabase usage controls

Applied migration v49 to the Mumbai project on 2026-10-15. Measured database size went from 229,349,043 to 119,756,467 bytes. The derived roster cache went from 125,075,456 to 15,613,952 bytes, including the new shared payload table. All 550 references and payload hashes were preserved; counts of attachments (1,251), canonical emails (2,114), and applications (640) remained unchanged.

Identical roster token maps now share one SHA-256-addressed payload. Candidate lookup evaluates each distinct payload once per call. RPC signatures, revision checks, matching order, source documents and application records remain compatible. Publishing identical metadata does not rewrite the cache row. Both payload tables remain inaccessible to anonymous and authenticated clients; access is through service-role RPCs.

Daily cron prunes at most 100 unreferenced derived payloads. Cleanup and publication share per-payload advisory locks, and foreign keys protect referenced versions. This does not remove source documents or notification deduplication records. Existing sync leases, watch renewals, background delivery and deadline checks remain enabled.

Shared College Gmail ingestion requests added/deleted history, avoiding circular reprocessing after read/unread or label changes. Empty history batches still advance the cursor. Sheet snapshot hashes cover the exact parsed rows, including inspected tabs; identical snapshots are inserted only once while source check times continue updating.

## Verification and maintenance

`node tools/verify-roster-payload-migration.mjs` exercises temporary fixtures and checks the actual cache inside a rolled-back transaction. It checks active-sync refusal, stale revisions/policies, earliest matches, unchanged publications, bounded cleanup, idempotence and payload preservation. Roster contents are compared inside PostgreSQL rather than downloaded.

`--apply` additionally commits v49 and reclaims the former duplicate TOAST storage using a short-lock-timeout `VACUUM FULL` on the derived cache table. The migration refuses active user/shared sync leases, webhook claims and archive refresh leases. Local verification metadata is saved under ignored `backups/roster-dedup-*`; it contains no OAuth tokens or connection credentials.

Supabase usage is cumulative over the billing cycle and the dashboard defaults to all projects. Database shrinking does not erase earlier egress or log usage. Logs Query counts bytes scanned by log tools, so filter service/time ranges before opening or refreshing large log queries. PostgreSQL statement/duration/connection logging was already disabled; errors and slow-query diagnostics remain available.
