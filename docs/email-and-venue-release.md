# Direct Gmail opening and recruitment venue display

Implemented locally on 7 October 2026. No production migration, historical venue update, environment change or deployment has been performed for these features.

## Behavior

- Every timeline action uses an authenticated same-site resolver. Personal messages resolve only through their owner's connected account. Shared college circulars resolve in the clicking user's college account; shared-ingester Gmail IDs are never used for another recipient.
- Existing mailbox-local IDs open directly. Otherwise a click performs one exact RFC Message-ID Gmail lookup requesting only message/thread IDs, including archived/spam/trash mail. Missing, ambiguous, disconnected or quota-blocked results offer an explicit exact-search/inbox fallback. No subject guessing, bodies, sync dispatch, mailbox mutations or account-state changes.
- Private mappings are isolated by account/source and encrypted refresh-credential fingerprint. An atomic database claim coalesces clicks and limits lookup starts to 20 per account per minute. Failed/missing results wait five minutes; positive mappings expire after 30 days. Google handles browser account selection and sign-in. Gmail UI links still need a real signed-in browser acceptance check; the REST API does not promise a web permalink contract.
- Drive Mode uses only the exact drive's bounded `recruitment_venues` projection. Unknown locations display **To be announced**. No job-location/status-note/event-default/sibling-drive fallback. Explicit campus lab attendance wins over the word “online”; different stages at different confirmed venues display **Multiple locations**. Same-campus rooms deduplicate.
- Canonical ingestion caches deterministic venue extraction with existing job-detail parsing. Only high-confidence exact assignments can update the venue projection automatically. A company-name-only assignment is excluded. The database additionally requires the exact primary canonical anchor or matching explicit drive numbers; conflicting/pooled numbers and admin-excluded sources are rejected. Atomic row locking preserves newer same-stage instructions; venue updates do not modify activity timestamps or recruitment state.
- All pages use the same display resolver. Reads request only compact venue metadata in batches of 200; no new page-body reads, polling or Gmail calls while rendering. Existing admin-excluded source IDs are filtered out.

## Release sequence

On 8 October 2026 the user ended the egress observation hold and authorized pushing these updates. The assistant monitoring task is paused; production cron remains active. Pushing may trigger the existing Vercel Git deployment. Database migrations and historical venue updates remain separate actions; no database changes are performed by the application build. Until the migrations are applied, venue reads safely display **To be announced** and unresolved email links offer the existing exact-search fallback.

1. Review and apply the additive migrations in order: `supabase/migrations/migration_v44_drive_venues.sql`, then `migration_v45_original_email_links.sql`. These add a display field, a private mailbox-link cache and service-role-only functions; no status/calendar/notification/cursor changes. Use a short maintenance lock timeout for application. Before migrations, readers fail safely to TBA and click resolution offers the existing exact-search fallback.
2. Prepare a bounded, read-only review for each existing drive that needs venue data, using Node 24+: `node tools/prepare-drive-venues.mjs --drive EXACT_DRIVE_UUID`. Review source association, quotes, dates, before/after labels and the evidence hash. This deliberately excludes company-name-only historical matches and conflicts. It does not fetch another drive's bodies by company name.
3. Chargebee #1407 was verified read-only against its primary source `4415d4d3-2a4d-443b-8de9-68e043e6ca00`, received 7 October 2026. The stored sentence wraps across Gmail text lines; the extractor handles that wrapping. The review resolves **Company Office · Chennai**, detail **Interviews: Chargebee Chennai office**, with one exact source. #1324 contributes no evidence. Local review: `scratch/drive-venue-reviews/3af42209-1b59-4c75-87d0-70fa8dfea858.json`.
4. Only after authorization, apply that reviewed file: `node tools/prepare-drive-venues.mjs --apply-reviewed scratch/drive-venue-reviews/3af42209-1b59-4c75-87d0-70fa8dfea858.json`. The tool rereads the same bounded sources and rejects stale/edited evidence. It calls only the venue merge function, inside one transaction. No broad reprocess is necessary. Do not automatically loop through all drives.
5. Publish a fresh production build of the reviewed feature commit (or verify the build triggered by the authorized Git push). No environment flags or Vercel token are needed. Keep existing cron, locks, cursors, region and secrets unchanged.
6. In a real signed-in browser check personal and college timeline links with different Google account indices, an archived conversation, and Google sign-in/account selection. Verify Chargebee #1407 and #1324 independently; unknown venues remain TBA. Test fallback using a naturally absent/revoked message if one exists; do not deliberately revoke credentials or force a failure.

Rollback: restore the previous application deployment. Leave additive columns/cache in place; no recruitment data rollback or reprocessing is needed.

## Validation

Focused unit tests cover account ownership, recipient mapping, positive/negative cache paths, missing migration, exact Gmail query/projection, ambiguity, quota/revoked credentials, no mailbox mutation, maintenance fencing and escaped fallback HTML. Venue fixtures cover the actual Chargebee wrapping, same-company isolation, audience scoping, campus/office/remote combinations, quoted corrections, contradictions and unknown data. Reader tests check batching and no full-body reads. Existing status/round/catch-up regression tests pass.

Both migrations were executed and behavior-checked in an isolated in-memory PostgreSQL runtime under `scratch/`, with no production access. Checks include stale/idempotent updates, timestamps, sibling isolation, connection invalidation, private cache claims, rate limits and service-role privileges. Fresh Next.js production build and TypeScript checks pass. Actual Gmail browser routing remains a release acceptance check.

Reference: [Gmail users.messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list).
