# Shortlist, status, and extraction repair plan

Investigation date: 6 October 2026. Production database access during this investigation was read-only. Application code and production records have not been changed. This document is the implementation plan requested after investigating Ansh's Axxela alerts.

## Confirmed incident

Ansh's earlier game-round participation was reused as eligibility for the later Axxela test. The timeline evaluates individual circulars, while the application calculation uses positive matches from the entire drive. Those decisions disagree because there is no authoritative verdict for each round and roster version.

Identifiers for a targeted repair:

- User: `84b60449-594e-46c5-b338-7ee3d886a08a` (Ansh Singh).
- Drive: `b5ad22c1-da14-499b-809f-ea41666a523e`, `pat-pl-2026-1364` (Axxela Research & Analytics).
- Latest forwarded test circular: `3bf51fdf-2000-437d-9177-0bb26964b318`.
- Source circular referenced by the shortlist alert: `74baee60-45f7-4a0b-9b7e-05ac139a7de4`.

### Evidence from stored emails and records

| Evidence | Finding |
| --- | --- |
| Personal emails | An eligibility invitation and registration confirmation on 29 September. No direct personal test invitation exists among the two personal emails linked to this drive. |
| Game-round circulars on 5 October | Five original/reply circulars reference the same published Google Sheet. Five `candidate_matches` rows repeat the same sheet row, with `matched_round_type = test_r2`. The stored matched email belongs to Ansh's connected identity. This is credible historical game-round evidence; it does not establish eligibility for the next test. |
| Excel shortlist for 7 October | Three original/forwarded copies of `Axxela shortlist 07.10.2026.xlsx` are parsed successfully, each containing 625 rows including the header. Checking the cached workbook against Ansh's Neo ID and all stored account emails produces zero exact normalized identity hits. |
| Roster scope | The circular explicitly says `List 1`. This confirms absence from this published list, but does not prove that all lists for the round are complete. |
| Application | `test_scheduled`, confidence `high`, manual override `false`. `status_source_email_at` still points to the 29 September registration confirmation although the derived status concerns a later test. |
| Calendar event | 7 October, 10:00–12:00 IST, source linked to the latest forwarded test circular, `round_number = 1`. The source is a next-round test notice, and the stored venue is `Own Location`. |
| Venue instruction | The latest forward says `own location concept is not there`; the underlying circular requires reporting to CDC labs. The stored venue contradicts the instruction. |
| Mixed-company circular | `Axxela next round and schneider virtual students` describes Schneider's PPT and Axxela's gamified assessment. Its parsed PPT was assigned to Axxela and appears in Ansh's events. |

The notification sequence on 6 October, in Asia/Kolkata time, was:

1. 15:19:57 — `Not shortlisted for the next round` alert.
2. 15:42:58–15:42:59 — five game-round sheet matches were inserted.
3. 16:26:15 — `Shortlisted: Axxela Research & Analytics!`, with a dedupe key referencing the final 5 October reply, rather than the 7 October workbook.
4. 16:47:32 — test notification for 7 October at 10:00, venue `Own Location`.

The database establishes the alert's source and the contradictory derived records. Runtime logs were not inspected, so the exact historical caller and deployment revision responsible for each write cannot be established from this investigation alone.

## Major findings

| Priority | Issue and consequence | Code locations |
| --- | --- | --- |
| P0 | The archive scan aggregates every roster for a drive: any historical positive produces `verified_present`. Existing matches also override new absence. A previous-round match can keep a later-round candidate eligible indefinitely. | `src/lib/sync/attachment-scanner.ts`, `src/lib/sync/shortlist-verification.ts` |
| P0 | Holistic recalculation falls back from the latest shortlist to any historical `test`/`test_r2` match. It then checks all extracted future test events for the drive. This promotes an old game-round match into `test_scheduled` for the 7 October test. | `src/app/api/sync/reprocess/route.ts`, especially `isMatchedInTest`, `hasPositiveCandidateEvidence`, and the `isMatchedInTest` status branch |
| P0 | Status, event insertion, archive verification, alert replay, and timeline rendering use separate rules. A status can be promoted before the relevant round is verified, and incremental notifications are sent before the application write succeeds. | `status-engine.ts`, reprocess route, notification service, company detail client |
| P0 | Reprocess has no shared per-user sync lease at its mutation entry point. Its job lookup does not coordinate with `runSync`. Additionally, `runSync({ force: true })` clears database locking state without checking whether the existing lease is still live. These are concurrency risks; they are not proven as the cause of this incident. | `src/lib/sync/engine.ts`, user/admin reprocess routes |
| P1 | Quoted reply history is scanned repeatedly as fresh shortlist evidence. `classifyEmail` calculates current-message text for some conflict checks but passes the full canonical body to its ordered rules. Status and GSheet scans likewise consume quoted history. | `classifier.ts`, `body.ts`, `status-engine.ts`, reprocess route |
| P1 | The timeline infers absence from a missing candidate-match row and the existence of a roster link/name. It does not require a persisted successful negative scan for that exact roster. Pending display helpers currently always return `false`/`null`. | company detail client, `src/lib/sync/status-display.ts` |
| P1 | The cached shortlist evaluator uses a limited identity set, while other parsers use broader account identities and name fallbacks. Common names can confirm the wrong student, and omitted college emails can miss the right student. String normalization also strips punctuation from emails and IDs alike. | `user-identity.ts`, `shortlist-verification.ts`, `attachment-scanner.ts`, `gsheet-parser.ts`, `excel-parser.ts` |
| P1 | Workbook matching can treat a hit in an Applied, Eligible, or Waitlist tab as a positive shortlist because tab ordering does not exclude those tabs. The cached evaluator scans all tabs without tab purpose. | `xlsx-matcher.ts`, `shortlist-verification.ts`, `excel-parser.ts` |
| P1 | Parsed attachment reuse uses filename plus byte size, which does not establish identical content. Different roster revisions can have the same filename and size. | `attachment-scanner.ts`, `resolveRosterContent` |
| P1 | `game round` is classified as `test_r2`, while the announced process separately includes game round and Test 2. Reprocess keeps one event per broad type, deletes/rebuilds automatic events, and writes every rebuilt event with `round_number = 1`. Round history and reschedule identity are lost. | `round-identity.ts`, reprocess route |
| P1 | Venue negation only catches forms such as `not own location`; it misses `own location concept is not there`. Multi-company text is parsed without associating each event clause with its company. Time-only notices can acquire a guessed received-day date. | `events.ts`, classifier/company extraction, reprocess route |
| P1 | Negative decisions do not consistently distinguish a parsed list from a complete round population. `List 1`, campus subsets, multiple roles, and supplementary/revised lists need explicit scope. Conversely, announcement-only notices can drive absence/rejection during holistic status calculation without a parsed roster. | verification utilities, reprocess route |
| P1 | Catch-up shortlist lookup selects `personal_email_id`, but the actual column is `email_id`. It ignores the query error. It also uses match insertion time as freshness, which can turn historical backfills into new alerts once the schema bug is corrected. Dedupe is based on reply email rather than canonical roster/round. | reprocess route, `notifyMissingNotifications`, `src/lib/notifications/service.ts` |
| P1 | The status engine can infer `interview_completed` from elapsed scheduling and `rejected` from a 14-day delay without a selection result. Scheduling proves an invitation, not attendance or rejection. Metadata is merged without consistent field-level provenance; the Axxela registration deadline is null despite its original circular containing a deadline. | reprocess route, event reconciliation, extraction helpers |

## Target behavior and data model

Create one decision per `(user, placement drive, round, roster scope/version)`. Keep historical decisions so earlier participation remains visible without granting later-round eligibility.

Use these separate concepts:

- **Roster identity:** stable sheet/document identity, attachment content hash, source message, source received time, parser version, tab and row location.
- **Roster purpose:** applied, eligible, shortlist, waitlist, rejected, or unknown, evaluated per tab/section.
- **Round identity:** a stable round key, label/type, ordinal when explicit, and predecessor relationship. Game round and Test 2 must have distinct keys.
- **Scope:** company/drive, role, campus, batch, list number, completeness, and whether a revision replaces a previous list or supplements it.
- **Verification:** pending/deferred, verified present, verified absent in this roster, or not published. Absence from a partial list is not a final negative verdict for the round.
- **Participation:** invited/eligible, scheduled, elapsed, explicitly attended/completed, eliminated, or selected. A scheduled event becoming past must not fabricate attendance or rejection.
- **Provenance:** matched identity type/value, strength, exact source, reason code, decision version, and superseded/retracted state.

Positive shortlist claims require a strong match for the target round and scope. Names alone produce a reviewable possible match, never an automatic positive alert. A complete, authoritative negative for a later round cannot be overridden by an earlier-round positive. An ambiguous mapping or failed parse remains deferred.

Personal NeoPAT emails remain the master records for registration and drive identity. Shared college broadcasts enrich the catalog and provide scoped participation evidence. Manual overrides remain authoritative and are never overwritten by repair.

## Implementation sequence

### 1. Reproduce and contain incorrect promotion

Add sanitized fixtures representing Ansh's exact sequence: registration, game-round sheet, quoted replies, later `List 1` workbook exclusion, mixed-company PPT, and the negated venue forward. Do not commit real student rows or account addresses.

Introduce a common verdict type and eligibility gate. Require the same target-round decision for status promotion, candidate calendar insertion, positive shortlist alerts, and event alerts. Suppress positive promotion while a relevant round is unresolved. Keep the announced company schedule separately visible as a broadcast.

Remove the drive-wide historical-match fallback as eligibility for a later round. Change archive aggregation from a drive-wide OR to scoped evaluation. Preserve earlier confirmed history. Add a provisional round verdict for `List 1` exclusion without turning it into a final rejection.

### 2. Normalize evidence ingestion

Make cached and live XLSX, Google Sheets, PDF/body roster scans use the same loaded candidate identity and matching contract. Use exact Neo ID, registration number, or exact known email with normalization appropriate to each type. Allow OCR correction only when corroborated; record it as lower confidence.

Classify workbook tabs and roster sections before matching. Exclude Applied, Eligible, Registered, Waitlist, and rejection lists from positive shortlist decisions. A shortlist email carrying several documents must not make every document a shortlist.

Cache parsed document content by content hash. Store a snapshot/version of mutable Google Sheets with source URL, fetch time, parse completeness, and matched row coordinates. Bound cache lifetime and distinguish fetch failure from a successfully parsed absence.

Split message content into current text, forwarded original, quoted reply history, and signature. A forwarded original can supply the real circular; a reply quoting it refers to existing evidence rather than creating a new round/list. Canonicalize identical sheet URLs and attachment hashes across forwarded copies.

### 3. Correct classifier and extraction

Pass the appropriate message segment to all classification rules and retain multiple event intents where an email announces several rounds. Return extraction results with clause/segment provenance and associated company/drive candidates.

For multi-company notices, assign an event only when its clause is tied to that company. Defer ambiguous clauses instead of attaching every event to the subject's first company. Schneider's PPT must never become an Axxela PPT.

Implement explicit venue negation and correction handling. Separate delivery mode from physical venue: an online assessment can require attendance at a campus lab. Resolve campus-specific instructions using the user's college context. Prefer a current `LC 102` instruction when it applies to the target round; otherwise retain the scoped CDC-lab instruction.

Resolve time-only revisions against the existing round date when justified by thread/round evidence. Store unknown dates/times as unknown. Extract numeric registration deadlines with received-year and Asia/Kolkata anchoring. Retain field-level confidence and source references for deadline, CTC, stipend, eligibility, role, venue, and dates; conversion-dependent CTC and one-time relocation allowance must retain their meaning.

### 4. Consolidate status and event calculation

Move domain calculation out of the API route into pure library modules. Incremental sync, archive rescans, reprocess, and backfills must call the same decision function. Feed it normalized evidence and an explicit evaluation time so replay can be tested deterministically.

Replace rank-based status preservation with evidence/version precedence for each round. Never use an arbitrary future event elsewhere in the drive as proof of eligibility. Derive the displayed application summary from round decisions, preserve manual overrides, and write the actual decision's source timestamp.

Persist events by round identity; update the same event on a reschedule and preserve prior rounds. Replace broad type-based deletion/recreation with a calculated diff. Keep stable event IDs and Google Calendar references. Remove automatic personal events only when their supporting eligibility is invalidated; preserve manual events and relevant history.

Do not infer rejection from elapsed time or a broadcast alone. A past invitation can be shown as a past round with unconfirmed completion; explicit result/participation evidence establishes actual completion or elimination.

### 5. Commit decisions before dispatching alerts

Atomically persist the round decision, application summary, event diff, and a notification outbox record. Dispatch push/calendar side effects after commit. Use the same decision IDs for live notifications and catch-up.

Dedupe by user, drive, round, canonical roster/version, and transition. Repeated forwarded copies must not create additional shortlist alerts. A genuine reschedule needs its own update transition. Message text should identify the relevant round and whether the candidate matched by ID or email.

Fix `personal_email_id` to `email_id`, check all query errors, and paginate beyond the arbitrary five matches. Freshness must use the evidence's effective/source date and transition, never merely the backfill insertion time. Preserve retries for failed push delivery without creating duplicate in-app messages.

Give notifications a decision reference and superseded/retracted state. Existing positive alerts that no longer support the current round can be marked historical or corrected rather than silently continuing to imply current eligibility.

### 6. Coordinate all writers and repair data

Use one atomic per-user mutation lease for manual sync, cron, Pub/Sub fan-out, reprocess, and repair jobs. Reprocess must acquire or reuse an owned lease; an internal recalculation during sync must not reacquire it. Live leases skip/queue cleanly. Force recovery can reclaim only an expired/stale lease, with owner fencing so an old worker cannot write after reclamation.

Preserve shared-college archive locking, database/cached sync progress, Gmail Pub/Sub watch renewal, and the existing daily cron responsibilities. Keep onboarding requirements from `AGENTS.md`: personal Gmail, college Gmail, and NeoPAT ID. The current engine's setup check only requires personal Gmail and Neo ID, so reconcile this mismatch explicitly rather than letting entry points enforce different prerequisites.

Add additive schema migrations after inspecting the deployed schema, including the older drive-wide `shortlist_verification_state` table. Store scoped verification instead of relying solely on `applications.status`. Grant users read access to their own decisions; reserve automatic verdict writes for the server.

Build a targeted repair command with a read-only preview and an apply mode under the mutation lease. Snapshot affected records first. Preview changed decisions, application status, event removals/updates, and notification corrections. Run Ansh/Axxela first, then audit other drives for old matches supporting newer restricted rounds, duplicate sheet evidence, and unverified negative verdicts.

Retain Ansh's valid game-round evidence, consolidate its duplicate source references, mark the 7 October list exclusion accurately, remove the unsupported automatic 7 October personal test invitation, and remove the misassigned Schneider PPT from Axxela. Do not mark Ansh finally rejected unless the round's complete scope or an explicit rejection provides that evidence. Suppress new outbound notifications during replay; any correction should follow the committed repaired decision.

## Verification and rollout

The investigation ran 102 existing tests across shortlist verification, candidate identity, round identity, classifier registration rules, venue extraction, extraction planning, and catch-up notifications. All passed. They do not cover the observed historical-match/later-roster conflict end to end.

Required regressions before repair:

1. Old game-round present + later test roster absent never schedules/notifies the later test.
2. Original sheet plus four quoted replies yields one canonical evidence record and one round-specific alert.
3. `List 1` exclusion, incomplete archives, failed parses, and ambiguous drive mappings remain non-final.
4. Complete applicable round exclusion supersedes earlier participation without erasing history; a supplementary list with a valid same-round match updates the decision.
5. Known college email, personal email, Neo ID, and registration number produce consistent results across cached/live parsers; common-name collisions cannot promote status.
6. Waitlist/applied/eligible tabs, blank allocations, and rejected lists cannot generate positive shortlist evidence.
7. Multi-company PPT and negated own-location instructions produce the correct scoped events and venue.
8. Time-only revisions preserve an established date or remain unknown; game round and Test 2 remain distinct through reschedule/reprocess.
9. Incremental, chronological, reverse-order, repeated, and repair replays converge to identical decisions/events with no duplicate alerts.
10. Application write failure produces no positive alert; retry delivers once; failed push can retry independently.
11. Cron/manual/PubSub/reprocess collisions skip or queue, stale recovery fences old writers, and live force requests cannot clear valid locks.
12. Manual application/event overrides survive repair, and automatic Google Calendar diffs preserve stable links.

Run targeted tests, `npm run typecheck`, lint for affected files, then the required repository checks. Validate route changes against the installed Next.js 16.3 documentation in `node_modules/next/dist/docs/` before implementation.

Roll out additive schema and shadow decision calculation first. Compare old/new decisions on the targeted drive and a representative sample of multi-role/multi-campus drives. Enable committed decisions and outbox dispatch together, apply the previewed Ansh repair, then expand repair scope. Record parser version, decision reason, source references, and lease owner in diagnostic logs; report mismatches and deferred-verification counts without logging full student rosters.

Acceptance requires Ansh's current round, calendar, alert center, timeline, and recruitment stages to agree; replay must not recreate the unsupported 7 October test or promote an old game-round match into current shortlisting.

## Implementation and validation — 6 October 2026

Implemented scoped round verdicts, exact account/ID matching, roster-purpose checks, mutable sheet snapshots, reply isolation, company-scoped extraction, date/venue corrections, metadata provenance, stable event diffs, transactional decisions and notification outbox, push retry claims, and shared user leases with stale-writer fencing. Domain reprocessing now lives outside the API route. Busy Pub/Sub fan-out persists a retry for subsequent sync/cron; watch renewal remains unchanged.

Applied the additive v40 migration. Repaired Ansh's Axxela application from test_scheduled to applied with pending verification for the partial 7 October list; consolidated five game roster receipts into one match retaining all source references, removed unsupported events, superseded two alerts, and restored the 29 September 6 PM IST registration deadline. The audit found one other current Axxela invitation contradicted by the same complete workbook; its targeted replay produced the same provisional decision. Each repair was snapshotted under ignored backups/.

Validation: production build including TypeScript, regression suite, focused core-module lint, and an opt-in database transaction test covering lock collisions, expired lease recovery, stale-write rejection, stable calendar IDs, manual overrides, failed commits, and notification replay. Delivery regressions cover stale decisions, persistence failure, failed push retry, and competing push claims. The database test rolls back every fixture and schema change.

The application code has not been deployed. Deploy these changes before relying on the running production sync to retain repaired decisions. Do not disable the independent daily cron or Gmail watch renewal.

Targeted repair preview (apply only after reviewing its scope):

~~~powershell
node --env-file=.env.local node_modules/vite-node/vite-node.mjs --config tools/vite-node.config.mts tools/repair-shortlists.ts USER_UUID DRIVE_UUID
node --env-file=.env.local node_modules/vite-node/vite-node.mjs --config tools/vite-node.config.mts tools/repair-shortlists.ts USER_UUID DRIVE_UUID --apply
~~~

## Status regression correction — 6 October 2026

The first implementation wrongly recognized "Congratulations ... Super Dream Offer" in a NeoPAT eligibility template as hiring selection, omitted absence checks for inline Neo ID tables, interpreted "2027 Batch" as a partial roster, and reset pending decisions to Applied. These rules are corrected; registration/JD boilerplate cannot create shortlist decisions, inline tables retain row outcomes such as Waitlisted, and unavailable lists preserve earlier verified progress. Parser version 2 supersedes erroneous earlier decisions, including decisions whose source must move backwards after removing a bogus email classification. Full evidence recalculation uses backups and per-user leases and suppresses notification delivery.

The authoritative flow is: a personal NeoPAT eligibility receipt establishes eligibility for that numbered drive; a confirmation establishes registration; the latest personal withdrawal/decline overrides participation; shared college circulars supply drive metadata and schedules; published candidate lists establish only the listed candidate's progression in the applicable round. Receiving a broadcast never establishes candidate eligibility or shortlist presence.

Recalculated the existing applications across all six onboarded accounts with snapshots under ignored backups/. Follow-up verification found no eligibility-based offers, no positive current statuses contradicted by a verified-absent decision, and no changed manual overrides. Validation passed: 402 tests, the production build, and the opt-in rollback-only database transaction test including duplicate extracted events with conflicting round metadata.

College messages and parsed rosters should remain shared canonical records. NeoPAT messages should retain per-user receipt, Gmail message ID, timestamps, and participation state. Common template content can be stored once per drive/message kind/template version, with recipient-specific data kept on receipts; test passwords, personalized links, and outcomes must remain user scoped. A storage normalization migration is separate from repairing the decision rules and has not been implemented here. Pub/Sub and the independent daily cron retain their existing lease enforcement and watch renewal.
