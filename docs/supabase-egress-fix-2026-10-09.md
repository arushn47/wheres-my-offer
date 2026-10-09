# Supabase egress amplification: local fix

Implemented locally on October 9, 2026. No deployment, migration, production data change, cursor reset, sync request, or broad reprocessing was performed. Existing uncommitted recruitment, notification, venue and security work was preserved.

## Changes

- Selected-drive recalculation no longer downloads the full personal metadata/snippet catalogue or the full shared circular metadata catalogue on every pass. Private reads are scoped to the user and selected/sibling drive IDs, explicit links and conservative subject predicates. Only the selected company metadata is loaded when constructing the scope.
- Circular metadata is selected using explicit source/candidate links, personal canonical references, subject matches, and existing parsed routing keys. Generic sibling thread anchors remain available for the unchanged role, thread, exclusion and temporal-boundary checks. Missing or empty target scopes do not become archive scans.
- A narrow shared routing-key read (`id,parsed_company_name,parsed_drive_numbers`) is reused within the owning processing run and refreshed after canonical writes. This preserves the existing fuzzy company matcher and punctuation-insensitive historical drive numbers without adding a database function or approximating their semantics in SQL. It contains no subjects, snippets, bodies or candidate rosters. Full metadata and bodies are fetched for candidate evidence only. Normalized-number and fuzzy-name matching still use the original functions.
- Personal and circular canonical body IDs are combined and deduplicated before hydration. Bodies shared by a personal receipt and a circular are read once per recalculation. Routing reads are invalidated before and after canonical writes through the admin client, including reads begun while a write is in flight. No cache persists across users or processing runs; failed reads are not cached.
- Candidate identity is shared as a promise within the owning user run. Concurrent calculations reuse the same two identity reads; another user or run gets a fresh identity. Identity read failures propagate instead of supplying incomplete evidence. The redundant recalculation profile query was removed.
- Notification outbox drains recover persisted work on the first call, share concurrent dispatches, and skip redundant drains after an unchanged successful delivery. New committed notification keys trigger delivery immediately. A commit during delivery causes another drain before callers return. Incomplete delivery retries on the next invocation; superseded decisions are checked again when made eligible/current. Persisted database dedupe keys and delivery bookkeeping remain authoritative.
- Removed only the separate lease preflight from `commitDriveRoundVerdicts`. Every `commit_round_verdict` RPC still validates and locks the live lease in the same transaction as the verdict, application status, events and outbox. Other lease checks, acquisition, renewal, release, mutation headers and direct-write fencing remain in place. No RPC/schema definitions changed.
- Development, local production-mode previews and Vercel previews targeting either pinned production project require compact roster, dashboard and sync-progress readers. Missing compact RPCs throw instead of silently downloading legacy bodies. The actual Vercel production runtime still honors the three rollout flags, including explicit rollback. Isolated development databases retain the existing rollout/fallback behavior.

## Reproducible measurements

Run `npm run test:egress`. Tests use synthetic data and fixture HTTP responses, with the real Supabase/PostgREST request serializer for source acquisition. The before reference reproduces the pre-fix acquisition or request sequence. These are targeted local benchmarks, not measurements of total sync traffic, live response sizes, compressed network transfer or Supabase billed egress.

| Tested operation | Before | After |
| --- | ---: | ---: |
| Eight selected-drive source acquisitions in one processing run, with 1,882 circulars and 276 private receipts | 40 requests | 26 requests (35% fewer) |
| Decoded response bytes for those acquisitions | 5,943,864 | 306,258 (94.8% fewer) |
| Rows returned for those acquisitions, including routing keys | 17,312 | 2,001 |
| First acquisition in a fresh run | 5 requests / 742,983 bytes | 5 requests / 182,799 bytes (75.4% fewer bytes) |
| Eight candidate identity loads | 16 requests | 2 requests |
| Eight historical verdict commits, plus catch-up and engine completion drains | 26 requests | 9 requests |
| Lease preflights in that commit benchmark | 8 RPCs | 0 RPCs |
| Atomic verdict commits in that commit benchmark | 8 RPCs | 8 RPCs |
| Outbox reads in that commit benchmark | 10 requests | 1 request |

Each new eligible notification still incurs the required immediate delivery work. The outbox benchmark uses historical verdicts with no new alerts; its savings must not be interpreted as postponing or suppressing eight valid new alerts. Per-drive calculation, roster membership, actual notification delivery and unrelated application queries are outside the acquisition benchmark. Scope construction adds a sibling metadata read and is also outside that acquisition benchmark. Do not sum these rows into a claimed whole-sync percentage.

## Validation and limits

Final local validation: **776 tests passed; 3 opt-in database tests skipped**, TypeScript passed, lint passed for the changed helpers/readers/tests, and the production build passed with fixture database credentials. `git diff --check` found no whitespace errors. Live database tests were not enabled.

Regression coverage includes historical evidence, fuzzy/abbreviated names, normalized drive numbers, generic sibling thread anchors, explicit sources with missing parsed keys, private user isolation, shared drive links, empty scopes, short-brand overmatching, canonical write invalidation, identity isolation/failure recovery, outbox concurrency/incomplete delivery/dedupe, immediate new notifications, withdrawn/declined participation, lease loss and atomic event payloads. Existing recruitment and Gmail pipeline tests remain part of the full local suite.

The local build is tested with an invalid fixture database URL and keys to prevent production access. Build artifacts from that check must be rebuilt with the approved deployment environment before any future release.

The user confirmed all three Vercel Production optimization flags are set to `true`: `ROSTER_LOOKUP_ENABLED`, `COMPACT_DASHBOARD_READS_ENABLED`, `COMPACT_SYNC_PROGRESS_ENABLED`. The agent's read-only verification attempt reached a signed-out Vercel session, so this is user-confirmed configuration. Verify the effective values on the freshly built production deployment during rollout. Local guards do not change deployed environment variables.

The routing-key snapshot is still an archive-sized, narrow read once per run. Eliminating it entirely would require an indexed database-side routing interface or a versioned persistent index; neither was added without approval. Separate processing runs do not share it. Another worker's canonical changes are picked up by the next run, while explicit IDs and fresh subject reads remain uncached. A single cold acquisition therefore primarily saves bytes, not requests. Explicit full reprocessing retains its original whole-archive readers and behavior.

Deployment and a bounded observation of natural production traffic remain necessary before claiming a reduction in billed egress or diagnosing any remaining production amplification. They require separate approval; no live processing was invoked to generate these measurements.
