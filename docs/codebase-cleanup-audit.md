# Codebase cleanup and structure audit

Reviewed locally on 7 October 2026. No deployment, production schema/data mutation, cursor reset, sync/reprocess or cron/environment change was performed for this cleanup. Existing email-opening and Drive Mode changes remain pending their separate release.

## Scope and changes

The scan covered application routes, UI, integration/sync modules, colocated tests, maintained operational tools, public JavaScript, package imports and database dependencies. Static import reachability was checked against Next.js entry points, operational entry points and tests; compiler unused-declaration diagnostics and repository searches were used to confirm removals.

- Moved route-local clients into their route's `_components` directory. Route handlers, page/layout entry points and URLs stay in place.
- Grouped existing sync modules into `classification`, `extraction`, `attachments`, `canonical`, `identity`, `recruitment` and `progress`. Updated application, test and operational imports; kept documented tool entry paths stable.
- Removed unused shared empty-state/status-badge components, unused service re-export facades, unused Supabase server-auth wrapper, duplicate unused database types, unused constants/type barrels, unused reprocess-scope module, a dead drive-event deletion helper and an empty instrumentation hook. Retained the actually consumed dashboard type in `src/types/dashboard.ts`.
- Removed 11 unreferenced private declarations and compiler-confirmed unused imports. No active recruitment conditions, status transitions, notification logic, database query or sync control flow was removed as an unused-code shortcut.
- Removed unused `recharts` and `zustand` dependencies and their unneeded dependency tree. Declared the already-used, already-locked `google-auth-library` version directly for webhook authentication; no Google library version upgrade.
- Limited test discovery to maintained `src/**/*.test.ts` tests. Excluded ignored local backups/diagnostics from lint discovery; kept the recovery files themselves.

Shared UI stays in `src/components`; integration modules remain in `src/lib`. This is a supported Next.js organization, not a claim that all teams use an identical folder tree. See [architecture](architecture.md) for ownership boundaries.

## Database findings

The live Mumbai audit used catalog/statistics metadata inside a read-only transaction with statement/lock timeouts. It did not scan email bodies, run application RPCs, count whole tables or change any object.

| Object group | Decision | Evidence |
| --- | --- | --- |
| 29 application tables | Keep | Every table has an application or database-function reference. |
| `roster_lookup_indexes` | Keep | Used by compact lookup RPCs; its size is not proof of waste. Removing it would undermine egress optimizations. |
| `emails` compatibility view | Keep | Referenced by legacy phase-3 functions. |
| `canonical_emails` compatibility view | Review later | No current literal app/RPC reference found; it stores no rows. External/dynamic consumers have not been ruled out, and removing it would not reduce table storage or establish an egress saving. |
| Functions, policies, triggers, indexes and outboxes | Keep | Lack of a literal application caller is insufficient proof of disuse; indirect, dynamic, trigger and operational use remain relevant. |

No table, function, policy, index or view was dropped. Destructive database cleanup requires a concrete dependency/consumer check and a recovery procedure for that object. Backups and isolated restore/cutover tools are retained.

## Repeating the audit

```sh
node tools/audit-codebase.mjs
node tools/audit-database-usage.mjs
```

The second command explicitly targets the pinned Mumbai project using `.env.restore.local` through the existing cutover connection helper. It requires its database credentials. Both reports are written under ignored `scratch/codebase-audit/`; neither command automatically deletes candidates. Static reachability cannot prove absence of computed imports or external consumers. PostgreSQL activity estimates and text matches are supporting evidence only.

## Validation

- Maintained suite: 560 tests pass; three opt-in database integration tests skip without isolated-test prerequisites. All 65 test files pass/skip as expected.
- Five operational-tool tests also pass under Node's test runner (`npm run test:tools`).
- TypeScript and a fresh Next.js production build pass.
- Import graph has no unresolved local imports or unreferenced source modules after the cleanup.
- All 78 route-manifest entries are unchanged. Thirteen local HTTP checks pass, including public pages/assets, the existing support-to-feedback redirect and protected-page login redirects; the login stylesheet also loads.
- ESLint still reports 360 pre-existing errors and 88 warnings. Comparison against corresponding pre-move files shows no new diagnostics after normalizing source-frame line numbers. Source rules are unchanged; this cleanup does not claim a clean lint baseline.

Pre-push checks repeated on 8 October: 560 application tests and five tooling tests pass, three opt-in database tests skip, TypeScript passes, and the static graph has no unresolved or unreachable source files. A fresh production build passes with the supported `--webpack` option. The local default Turbopack retry encountered a child-process startup panic; build configuration was not changed. Staged-file checks found no private local paths or credential-pattern matches. Ignore rules retain local backups, diagnostics, environment secrets and generated reports while keeping reviewed migrations versioned.

Authenticated production pages, OAuth account routing and live background delivery were not exercised by this local refactor. The separate [feature release procedure](email-and-venue-release.md) retains those acceptance checks. On 8 October the user ended the observation hold and authorized pushing the tested updates; database migrations remain separate.
