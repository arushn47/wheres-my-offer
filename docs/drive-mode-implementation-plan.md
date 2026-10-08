# Simple drive-specific travel display

Revised 7 October 2026. Planning only; this revision changes no application code, database, deployment or production settings. It replaces the previous round-delivery subsystem proposal. The independent Gmail-link plan below is retained separately.

## Purpose and fixed boundaries

Drive Mode answers: **Is attendance remote, or where would I need to go?** It summarizes announced recruitment venues for an exact placement drive. It does not claim the user is shortlisted or instructed to attend the next round.

Keep recruitment/status calculation, shortlist classification, candidate matching, participation rules, round ordering, cross bubbles, application notes, calendar behavior and notification delivery unchanged. Do not modify the existing travel extractor used by status processing as part of this display change. Replace only the Drive Mode display's dependency on ambiguous status notes.

## Display contract

| Explicit applicable recruitment evidence | Display | Optional short detail |
| --- | --- | --- |
| Remote attendance / own location | Online | Test: own location |
| Named VIT campus attendance, lab or auditorium | VIT Bhopal / VIT Vellore / VIT Chennai / VIT AP | Test: Bhopal LC |
| Named company office | Company Office · Chennai | Interviews: Chargebee Chennai office |
| Company office, no city stated | Company Office | Preserve the stated office name |
| Another named physical venue | The concise venue name | Preserve its address where useful |
| Different confirmed locations for different stages | Multiple locations | Test: VIT Bhopal; interviews: Chennai office |
| No explicit recruitment venue | To be announced | Omit speculative details |

Remote and physical stages together count as Multiple locations. An online assessment that explicitly requires campus-lab attendance counts as the campus venue. Different rooms on the same campus do not create Multiple locations. Unknown stages do not create a second location. An explicitly superseded venue does not count as an additional location.

Do not infer hostel attendance, flights or mandatory travel solely from a city or a user's home campus. If travel wording is shown, compare a known campus venue with a known user campus; otherwise let the venue label speak for itself. An office location does not establish where the user currently is.

**Chargebee #1407:** Company Office · Chennai, with Interviews: Chargebee Chennai office. Do not assume a Bhopal test venue. Show Multiple locations only if evidence for that exact drive explicitly confirms another applicable stage at a different location. Chargebee #1324 contributes nothing to #1407.

## Small implementation

1. **One optional compact JSON field on placement_drives**, e.g. recruitment_venues. Store only the current explicit venue instructions needed for this display. Include a format version and a small list of stage/venue entries, each carrying a canonical source ID, source date and short supporting quote. The containing row supplies the exact drive ID. Minimal stage scope is necessary to avoid overwriting an interview venue with a later test notice; reuse stage wording or existing identity where available, without changing recruitment rounds.
2. **One deterministic extractor** consumes an already-loaded, exactly assigned canonical circular. It returns venue kind/name/city/campus, applicable stage and explicit audience when present. No dedicated evidence table, source-history service, new queue, per-user AI request or calendar event is required.
3. **One pure display resolver** takes that drive's compact venue field and the user's known campus only for an explicit respective-campus instruction. It returns a label and optional short detail. All Drive Mode cards/badges on companies, details, dashboard and search use this resolver and the existing shared badge component. No page reads whole email bodies to render it.

Keep the JSON bounded to brief current venue instructions; no email bodies, roster rows, private invitations or user identifiers. Canonical email storage remains the source of historical evidence. Supporting quotes make the small projection auditable without a second evidence subsystem.

Use the existing authorized, exact-drive assignment path. Add/update the venue projection under the existing ingestion concurrency policy, with an atomic update or shared serialization to prevent lost updates. Only update venue metadata; do not advance recruitment/activity timestamps simply for this display field. Repeated ingestion must be idempotent. Ignore older announcements that would overwrite newer instructions for the same stage.

If there is no unambiguous exact-drive assignment, do not copy the venue to any sibling drive. A company-name match alone is insufficient. No changes to drive identity resolution are part of this work.

## Evidence rules

- Require an affirmative recruitment-attendance sentence or clearly labeled recruitment venue. Ignore Work Location, Job Location, office addresses in signatures, website domains and registration portals.
- Company Office · Chennai requires an office recruitment instruction; Chennai alone is not VIT Chennai. VIT campus labels require explicit campus identity or an explicit respective-campus instruction plus a known user campus.
- Preserve undated venue announcements; never invent a date or calendar event to store them.
- Extract from the relevant sentence/section rather than scanning every city in the email. Ignore quoted prior instructions when the current message explicitly replaces them.
- Apply a clear correction to its stated stage. Keep different stages separately; several interview stages at the same office deduplicate to one location.
- Apply explicit audience restrictions before summarizing. A venue for another campus's students must not become the current user's venue. Ambiguous assignments stay To be announced rather than guessing.
- Do not treat legacy notes or potentially defaulted event venues as explicit evidence. Never use job-location fields or another drive's data as a fallback.
- Where contradictory text cannot be resolved safely, leave that stage unconfirmed. A short source-based detail can explain the uncertainty without adding a recruitment status.

## Egress and rollout

Extract once while canonical ingestion already holds the body. Read the compact field in existing batched drive queries; no N+1 reads, additional polling or per-user re-extraction. No new roster/body downloads during normal page rendering. Retain existing compact-read and roster-lookup optimizations.

For existing drives, prepare a venue-only dry-run tool reading exact linked canonical sources in bounded batches. Start with Chargebee #1407 and report source quotes plus old/new labels. Skip ambiguous links. Apply only the new venue field after authorization; no all-user reprocess, cursors, statuses, notes, notifications or calendar writes. New/absent data must safely display To be announced so migration and deployment can be sequenced without page crashes.

Implement and test locally first. Any test restore must be isolated: Mumbai is live Production. Production migration, historical venue writes and deployment are separate authorized release actions. Rollback reverts the display reader without changing recruitment state.

## Focused verification

- Chargebee #1407 office-only instruction; same-company #1324 isolation.
- Exact-drive Bhopal test plus Chennai office interviews; remote test plus office interviews; multiple rooms on one campus.
- Missing/TBA data, job-location-only Chennai, footer address, registration link, bare city and unknown user campus.
- Explicit respective-campus and named-campus exceptions; lab attendance despite an online test platform.
- Undated interview venue, newer correction, stale quoted venue, out-of-order arrival and repeated ingestion.
- Identical labels across companies/detail/dashboard/search; unknown data does not crash readers.
- Existing status/shortlist/round-marker results remain identical. Venue-only updates dispatch no notifications or calendar work.
- Compact batched reads, bounded payloads and no whole-body reads during rendering; check query count/payload against the existing read path.

Run the relevant regression tests, typecheck, lint and production build before proposing a release. Do not bundle Gmail-link changes or additional status/egress refactors into this feature.

## Separate companion change: open the original Gmail message directly

User clarification: the Open original email action should normally open the conversation itself in the correct connected college/personal Gmail account, rather than showing a search-results screen. Implement and test this independently from venue extraction/status logic.

Current `company-detail-client.tsx:getGmailLink` already prefers a stored thread/message ID, then falls back to RFC Message-ID search. Synthetic canonical timeline entries have no mailbox-local thread/message ID, so they take that search fallback. A shared canonical message cannot provide a universal Gmail thread link for every recipient.

Proposed flow:

1. Authenticate the WMO user and authorize the clicked source/timeline entry against that user's visible drive and connected account. Determine college versus personal from trusted source metadata, not a client-supplied email address. Never use another user's account credentials or the designated shared inbox's Gmail IDs to build a recipient's direct link.
2. Prefer an existing verified mailbox-local thread/message mapping for that exact connected account. Keep stored RFC Message-ID as canonical cross-mailbox identity, not as a Gmail UI thread ID.
3. If that mapping is missing, perform one on-demand Gmail `users.messages.list` lookup in the user's own connected mailbox with the exact `rfc822msgid:` query, requesting only message/thread IDs. Do not download bodies, scan the inbox, reset cursors or run sync. Reject ambiguous matches instead of arbitrarily opening a similarly titled conversation. Match verification may use lightweight header metadata if needed.
4. Cache the verified IDs privately by WMO user, Gmail account and canonical/source message identity. Do not duplicate full messages or expose tokens/headers in URLs/logs. Revalidate mappings after disconnect/reconnect or relevant identity changes. Rate-limit lookups and bound negative caching so repeated clicks cannot create a quota loop.
5. Redirect to the direct Gmail conversation target, carrying the connected email as the account hint. Use the existing direct-link approach as a candidate, then verify with actual Gmail browser sessions; Gmail web fragment routing is not a guaranteed Gmail REST permalink contract. Validate ID format and restrict redirect origins/routes to Gmail.
6. Google controls its browser session, account chooser and sign-in. The WMO OAuth session cannot inspect Google cookies or silently sign a user into Gmail. If the intended account is not logged into Gmail, its account selection/login remains Google's responsibility; test the continuation back to the target rather than promising automatic sign-in.
7. If the message is absent/deleted, access is revoked, quota/backoff blocks lookup, or a direct target cannot be established, offer the existing exact-message search as an explicit fallback. Do not automatically search a different mailbox, silently open the shared college account, or select a subject-only match.

Keep this click-driven rather than issuing Gmail lookups while rendering every timeline. Use a same-site authenticated resolver link/new-tab flow that remains compatible with popup blockers. Any private mapping writes must follow the maintenance fence and normal authorization policy; Gmail lookups themselves must not modify messages, labels or read state. Opening the resulting conversation in Gmail may naturally mark it read through Gmail's own UI.

Tests: stored direct IDs; canonical-only entry; two users receiving the same circular; multiple Google accounts and different account indices; logged-out Google session; archived conversation; personal versus college source; duplicate/ambiguous results; missing message; expired/revoked credentials; quota failure; private cache isolation; invalid/open-redirect input; and no body fetch, mailbox mutation or sync dispatch. Verify thread context and the intended message are visible when multiple announcements share a conversation. No production lookup, schema change or deployment is performed as part of this planning update.

Primary reference: [Gmail users.messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) documents RFC Message-ID search and returned message/thread IDs. This supports the lookup, not a promise that every Gmail web deep-link format is stable.
