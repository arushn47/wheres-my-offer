# Mumbai preview and cutover checks

For the authoritative release sequence and copyable commands, use [Production cutover actions](production-cutover-actions.md). This checklist records supporting evidence and platform checks.

Prepared 7 October 2026. Production remains on `mltfzskewmpifnyleevb`; the restored replacement is `nvkxyeugonjevmbvxirm` in Mumbai (`ap-south-1`). No Vercel token was requested or used. Nothing was deployed or cut over.

User confirmed on 7 October 2026: Vercel Function Region is Mumbai (`bom1`), and Production environment variables remain unchanged on the existing production setup. These configuration checks are complete. Preview/branch overrides, retained-secret comparisons and older-deployment protection have not yet been confirmed. Actual function execution should still be checked on the later cutover deployment.

## Verified preparation

- A separate production build using replacement credentials passed 304 checks across all seven restored identities: company lists, Axxela/UBS/Myntra detail pipelines, dashboard, analytics, search, notifications, progress APIs, unauthorized access, compact-reader fallbacks and the cutover writer fence. All 785 runtime outbound requests were permitted database reads. All public database rows remained unchanged.
- The harness copies source into ignored `scratch/restored-preview-*`, excludes `.env` files and uses a random signing key for synthetic sessions. Browser bundles exclude source database URLs and the service key. This verifies server rendering/session authorization; it does **not** exercise real Google OAuth or browser hydration.
- Runtime guards block database mutations, cache publication, Gmail and other external deliveries. Eight negative guard checks passed without network requests.
- Populated-destination refresh passed inside a transaction ending in `ROLLBACK`, including all 61 table counts, 34 full archived row-content comparisons in both directions, and actual foreign-key checks. Afterward, an independent read-only export confirmed all 61 original table-content hashes and the Auth refresh-token sequence still matched the immutable backup.
- Supabase reports a healthy Mumbai replacement. Storage and Realtime settings match the source export. Both have no public-table Realtime publication membership or Edge Functions. Supabase Auth differs in Google client ID/secret, skip-nonce setting and redirect allow-list; values are saved only in ignored backup files. No provider settings were copied automatically. The application's own Google callback uses application credentials and a signed session independently of Supabase GoTrue.
- 495 application tests and five Node cutover-policy tests pass; five optional database tests skip in the ordinary suite. Production build and targeted lint pass. Separate recorded-data tests verified equivalent displays for all 569 applications and 1,513 round rows. Dashboard/status/activity payloads fell 68% and shared search payloads 71% in their respective workloads. New-drive jobs restrict scanner/recalculation work to touched drives; completed onboarding retains full-history recovery. Live daily egress/CPU/memory savings remain unmeasured.

## Check manually in Vercel

1. **Project/region — configuration confirmed:** Function Regions is Mumbai (`bom1`), and the repository also pins `bom1`. After the next authorized deployment, verify its function details/runtime logs show actual execution in Mumbai; the CDN location does not establish this. [Function regions](https://vercel.com/docs/functions/configuring-functions/region)
2. **Environment scopes — Production unchanged, confirmed:** keep Production on the source URL and matching anon/service-role keys until cutover. Still inspect Preview and branch-specific overrides. Never expose service-role keys, database passwords or management tokens through `NEXT_PUBLIC_*` variables.
3. **Retained secrets:** securely compare production with the existing local values for `TOKEN_ENCRYPTION_KEY`, Google client ID/secret/redirect URI, Pub/Sub topic/audience/service account, `CRON_SECRET`, VAPID keys, and any parser/AI/mail-delivery credentials. Preserve encryption and VAPID keys exactly. Report mismatches without pasting secret values.
4. **New build required:** retain the working Node version, Next.js preset, root/build commands and function durations. Environment edits apply to new deployments. The destination `NEXT_PUBLIC_SUPABASE_URL` and anon key must be present during a fresh build; do not promote an old source-bound or synthetic rehearsal build. [Vercel environment variables](https://vercel.com/docs/environment-variables), [Next.js public variables](https://nextjs.org/docs/app/guides/environment-variables#bundling-environment-variables-for-the-browser)
5. **Older deployments/integrations:** check Deployment Protection so older URLs cannot remain usable source writers during/after cutover. Keep OAuth, Pub/Sub and cron-job.org URLs on the existing production domain. Changing databases does not itself require changing these URLs. Do not connect a second cron or webhook to a rehearsal preview.
6. **Usage/logs:** identify the request-count, active-CPU, provisioned-memory and runtime-error views. Record totals/timestamps before rollout and compare rates for at least 48 hours afterward. The measured 96% reduction in the roster test's response payload is not a guarantee of total egress below 150 MB/day.

No production environment edits or redeploys are requested by this checklist yet. A remote preview is not automatically side-effect-disabled: the outbound guard belongs to the local harness. Do not exercise sync, OAuth, notification or calendar actions against restored data in an ordinary deployment preview.

## Later cutover gates

1. **Fence new writers and drain existing work.** The prepared `DATABASE_WRITES_PAUSED=true` option returns 503 with `Retry-After: 60` before Pub/Sub acknowledgment/claims, GET cron/repair/OAuth handlers, mutations and server actions. It retains readable pages and the three audited progress/notification GET APIs. Default is false. Deploy this pause against the source only during an approved maintenance window. It does not cancel in-flight functions, direct database writers or older deployments: fence those too and verify they have drained. Do not clear live leases to make a drain check pass.
2. **Retain incoming mail durably.** Verify Google Cloud subscription retention/retry/dead-letter behavior. Pub/Sub must retry throughout the pause; never acknowledge and discard deliveries. Resume the existing daily cron's watch renewal and alerts after cutover.
3. **Capture final data.** Production continued writing after the rehearsal backup. Take a new consistent source backup after the writer drain, back up the replacement, and keep an encrypted off-machine recovery copy. Recheck schema drift, provider settings and any new Storage/Vault contents.
4. **Refresh the populated replacement deliberately.** The fresh-project runner refuses existing tables. `prepare-cutover-refresh.mjs` regenerates checked inputs and rehearses a populated refresh ending in rollback; it has no committing mode. The separate `finalize-replacement-refresh.mjs --apply` runner requires fresh paused source and destination recovery archives, verifies their checksums and identities, checks the HTTP fence and both databases' leases, rehearses and then executes the regenerated final artifact. Follow the exact commands in the production actions document only during an authorized maintenance window. Preserve destination-managed definitions/migrations and v41/v42/v43, copy original rows, clear only derived roster indexes, and verify counts, contents, RLS/privileges and foreign keys. Preserve recruitment outcomes, notification deduplication records, watch/history cursors, pending work and offsets. The committing path has not been executed during preparation.
5. **Review managed sequence finalization.** Supabase owns the Auth refresh-token sequence, so `ALTER SEQUENCE RESTART` is denied. Supported `setval` does not roll back and is deliberately omitted from the rehearsal. The final review artifact includes a high-water adjustment that never rewinds the current sequence, accounting for imported maximum IDs and the archived value. The separate `refresh-sequences-review.sql` is also review-only: capture the previous value and validate final sequence state while all writers remain paused. Do not execute both artifacts independently as separate refresh procedures.
6. **Build and verify the replacement deployment while paused.** Switch the matching destination URL/anon/service-role keys; retain application secrets. Enable `ROSTER_LOOKUP_ENABLED=true`, `COMPACT_SYNC_PROGRESS_ENABLED=true` and `COMPACT_DASHBOARD_READS_ENABLED=true` only with v41/v42/v43 verified there. Keep query metrics off except for short diagnostic windows. Confirm Mumbai execution, pages, private reads and status consistency before enabling writes.
7. **Release and measure.** After validation, deploy with `DATABASE_WRITES_PAUSED=false`, allow Pub/Sub retries, resume the existing cron and perform one controlled sync. Check real OAuth, watch health, notification deduplication, progress restoration and calendar behavior. Do not use a full-user reprocess as a smoke test. Measure 48-hour provider rates and continue remaining cost work where amplification persists.

Read-only lease checks after the source pause is actually deployed:

```sql
SELECT count(*) AS live_user_syncs FROM public.sync_state
WHERE is_syncing AND (lease_expires_at > now() OR
  (lease_expires_at IS NULL AND updated_at > now() - interval '3 minutes'));
SELECT count(*) AS live_shared_syncs FROM public.shared_college_sync_state
WHERE is_syncing AND lease_expires_at > now();
SELECT count(*) AS live_push_claims FROM public.gmail_pubsub_inbox
WHERE status = 'processing' AND locked_until > now();
```

Zero leases cannot prove OAuth/admin/calendar/notification functions have drained; verify their invocations separately. Retain the source and archive for recovery. After destination writes begin, rollback needs reconciliation; an environment flip alone loses new state.

Final snapshot, committed refresh, deployed OAuth/browser validation, deployment, writer release and live usage verification remain separate release work. None has been performed by this preparation.
