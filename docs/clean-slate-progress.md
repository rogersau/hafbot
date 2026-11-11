# Public clean-slate integration

This is the authoritative combined inventory for both audit threads. The integration branch is
`t3/architectural-clean-slate-audit`. Public installations start empty: there are no active
deployments, inherited compatibility requirements or upgrade migrations. Private upgrade,
checksum, ledger and historical admission requirements do not apply to this public baseline.

## Current checkpoint

All reviewed implementations and integration corrections are committed through
`cc6feaef65a4e99779878dd4963f3d8678010263`. Final combined acceptance is recorded below.
No implementation delegate is active locally or remotely (global zero). Normal slot reservation
remains architecture two / task coordinator three, within the global cap of five. Cancelled duplicate
assignments remain stopped; their worktrees, commits, drafts and evidence are preserved.

Root owns final review, integration and validation. Completed implementers used isolated checkouts,
serial tests and disposable PostgreSQL limited to one CPU / 256 MB, 32 MB shared buffers and
20 connections. DeepSeek Go/max was primary; the user authorized GLM 5.3 Flash/max on failure.
The R01 implementation used that authorized fallback. No other provider was substituted.

## Current architecture

- Node selects native PostgreSQL stores, object capabilities, credentials and processing ports
  before composing the feature graph. HTTP, native jobs and scheduled work share selected
  service instances. Maintenance HTTP has a separate read-only graph and pool.
- Production has no Worker entrypoint, Durable Objects, D1 SQL bridge, SQL dialect translator,
  disabled persistence factory or in-memory incident fallback. SQLite and flat test overrides are
  isolated under test support. Full service construction has one composition entry point.
- Native jobs receive payload plus native metadata and return explicit outcomes. Missing outcomes
  are terminal. One current `reason_code` / `reasonCode` field retains retry and terminal reasons;
  completion and operator retry clear it. Retry delay, exhaustion and lease fencing remain durable.
- `commerce_offerings` owns state and lifecycle metadata, including explicit `repair_previous_state`.
  There is no Offering lifecycle side table or old `active` projection. Repair restores prior published
  versus unpublished state directly; financial, retirement, checkout and outbox guards remain.
- Ticket persistence capabilities and handler lifecycle dependencies are required. Current mutations,
  availability toggles and Server Levels processing leases use required ports. Platform Link metadata
  and supplied enabled state persist in one UPSERT; omitted enabled preserves the existing flag.
- The install schema is the current empty-database baseline. Startup initializes it atomically and can
  reopen the matching current schema. No migrations, conversion CLI, ledger, compatibility view or
  historical reader is provided.
- Current platform identities, ordered Reaction Role panels, Ticket response rules, Evidence Vault
  roles/private media, encrypted webhook references, signed controls and v2 Gateway documents are
  canonical. Public errors use `fieldIssues`, `staleReason` and `retryAfterSeconds`.

## Reconciled task coverage

“Integrated” identifies individually reviewed source reconciliation. The combined acceptance below checks the resulting architecture.

| Task    | Reconciliation                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------ |
| C01     | Native database driver and store failure/read contracts; no SQL bridge                                 |
| C02     | Admin loading/error UI `02cbf2e`; error/retry/editor regressions retained                              |
| C03     | Shared Webhook validation `230b35b`, whitespace correction `5a45465`                                   |
| C04     | Fresh-install policy; private pre-upgrade and ledger requirements superseded                           |
| C05     | Native selected persistence; disabled/memory fallback deletion `0d91d1a`, test-only type relocation    |
| C06     | Retired selector/context/page-policy plumbing removed `fa1fe4e`                                        |
| C07     | Abandoned prototype removed `4af4df0`                                                                  |
| C08     | Retired Worker/dev tooling removed; test-only provider types remain isolated                           |
| C09     | Current Commerce client calls `408d976`, unused Admin claims `537036a`; Event aliases removed          |
| C10     | Mandatory Event capabilities `f8d7bd7`, unconditional delivery composition `10743b5`                   |
| C11     | Required role/suggestion ports and atomic whole-set timed rules `5eb98c8`                              |
| C12     | Narrow handlers `d1988ea`; final Ticket lifecycle injection `2c217cb`                                  |
| C13     | Native identities/API, current Player Link UI `0bbc4b6`, aliases/types `537036a`                       |
| C14     | One ordered Reaction Role panel table and explicit panel identity                                      |
| C15     | Current Ticket rules/flags; required persistence `ce2fa5d`, interaction reads `d72367c` / `bcae419`    |
| C16     | Evidence role list and private explicit object metadata                                                |
| C17     | Encrypted credential references in configuration/history/queues/logs                                   |
| C18     | Current signed controls, actor/generation fencing and signing-key rotation                             |
| C19     | Strict current Gateway envelope and event key                                                          |
| C20     | Canonical S3 metadata `b8edd9a`; incomplete security metadata fails closed                             |
| C21     | One stored entitlement plan field                                                                      |
| C22     | Current four Billing prices and self-hosted policy; historical paid data removed                       |
| C23     | Canonical Offering row `b57a102` (source `30a48f1`, reviewed combination `4b7fd28`)                    |
| C24     | Canonical error envelope and strict client parsing; combined endpoint/transport tests included         |
| P01–P14 | Native stores and current provider/context selection; full native PG acceptance passed                 |
| P04     | Real-PG Event atomicity tests `9f02d5b` + `62b315e` preserve public-store rollback/CAS/Guild contracts |
| P08     | Moderation lock/rollback reconciliation `3d1bb9e` with proven concurrency regression                   |
| R01     | Shared composition `983822d`, root corrections `0d91d1a` and strict Admin selection `a3a1e17`          |
| R02     | Direct native outcomes `d69aba9`, canonical persisted reason `3d82916`                                 |
| R03     | Production Worker/DO/D1 host and SQL bridge removed; SQLite is test-only                               |
| B01     | Current fresh schema; Offering consolidation, job reason and current incident feature checks included  |
| B02     | Current Node/browser/test boundaries; clean artifact builds and boundary checks passed                 |
| B03     | Current install docs; documentation build and contract drift checks passed                             |
| V01     | Final combined builds/types/contracts/public/PG/container validation passed                            |

## Integration corrections and regressions

- Mention Protection configuration replacement/delete/clear takes an exclusive Guild transaction lock.
  Burst recording takes a shared lock on the same key, then a member lock. Real PG reproduced the
  pre-fix interleaving and failed-clear partial commit; both are corrected. Root moderation acceptance
  passed 8/8, including preserved Image Rules/Bot Defense evidence.
- C11 locks a complete timed-role rule set before delete/insert in one transaction, including empty
  clear. Forced-insert rollback and deterministic competing-writer regressions pass (3/3 real PG).
- P04 adds public native EventStore rollback, Team/proposal/lifecycle/bulk CAS and Guild isolation
  coverage. The current adapter already satisfied them; no production fix was invented. Root Event
  atomicity plus recurrence passed 7/7 real PG. Normal public runs use the standard PG env guard.
- C23 preserves repeated repair's original state, unpublished after earlier publication, role uniqueness,
  guarded publication, checkout/retirement/refund/ledger/outbox rollback and tenant boundaries.
  The three disclosed extra consumer readers were individually reviewed and accepted. Three-way
  integration preserved R02 native/SQLite Game Access delivery. Root adapted the four excluded
  Game Access SQL fixture fragments in `202397f`; no old side-table fixture remains there.
- Required Ticket ports were reviewed/integrated individually. Root combined Ticket/interaction/runtime
  acceptance passed 352/352. Ticket lifecycle construction now belongs to composition, with a repeated
  dispatch/no-store-reconstruction regression. Guild overview reads all panels through its required port.
- R01's returned implementation required root corrections: the factory still contained disabled Suggestions
  and memory Incident substitutes. Those actual paths were deleted, selected media capability and
  processor telemetry were forwarded, flat RuntimeStore types moved out of production, and the final
  Admin factory alternatives/unused route wrapper were removed. Root focused integration passed 232/232.
- Platform Link config save's second write could fail after metadata committed. The real-PG trigger
  regression observed RED, then GREEN after one-UPSERT persistence. Eight remaining mutation/lease
  methods are required; native/SQLite adapters and scoped consumers agree.
- Native jobs did not retain a queued retry's reason. Root observed RED (missing
  `provider_rate_limited`) before the canonical field correction; the complete 11-test PG queue/Gateway
  group then passed with zero skips, including delay/reason restart behavior, exhaustion and fencing.
- Removing the unused memory Incident implementation exposed a genuine fresh-schema mismatch:
  current Player Link incidents were rejected by the DB feature constraint. SQLite and PostgreSQL
  both reproduced the failure. The baseline now permits the current feature; real persistence and
  resolution pass (6/6 SQLite/API tests and 1/1 real PG), with Guild isolation/history assertions.
- The final broad run exposed two remaining fixture adaptations: Honeypot setup now checks its
  completed persisted setup run, and JavaScript workspace-security fixtures compose the required
  graph before app construction. The focused checks passed 8/8 and 17/17 without weakening
  authorization assertions. The repeated build/browser checks passed after a transient
  `ERR_NETWORK_CHANGED` during disposable Docker network removal; no UI code was changed.
- Current Admin/Marketplace terminology cleanup passed 138/138. API route tests compose complete
  selected services before dispatch and use current API/SPA handlers. Production cannot import fixtures.

Focused counts above identify their scopes; they are not summed or presented as final broad totals.
The task coordinator additionally reviewed C23 on combined source: 108 affected Commerce tests
and 24 real-PG checks passed with zero skips. Its source and evidence remain preserved.

## Final combined acceptance

| Check                                            | Current result                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Clean application and test artifact builds       | Passed; application and test outputs rebuilt from empty artifact directories |
| Node/Admin/shared types and Admin contract drift | Passed                                                                       |
| Public behavior suite                            | 3,562 passed / 0 failed; 89 PG-only skips covered by the configured PG run   |
| Native PostgreSQL and concurrency suite          | 141 passed / 0 failed / 0 skipped, official serial PG runner                 |
| Build behavior / architecture                    | 19 build/browser checks and 7 architecture checks passed, zero skips         |
| Lint / formatting / diff whitespace              | Passed; 10 existing React Effect advisory warnings, zero lint errors         |
| Documentation                                    | Build and public documentation check passed                                  |
| Production image / empty-PostgreSQL readiness    | Image build and fresh-schema/full-readiness container smoke passed           |

Final acceptance used `pnpm test:prebuilt` with `TEST_POSTGRES_URL` unset. It passed all
three groups: 19 build/browser checks, 3,562 behavior tests and 7 architecture checks. All
89 behavior-suite skips require PostgreSQL; the separate official `pnpm test:postgres:prebuilt`
run passed 141 tests with zero skips, including nested concurrency scenarios. The earlier serial
behavior run exposed the two fixture adaptations recorded above; the final official run passed
on the corrected source.

Other accepted commands were `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm build:test`,
all three type checks, `pnpm admin-contract:check`, `pnpm lint`, `pnpm format:check`,
`git diff --check`, `pnpm docs:build`, and `pnpm audit --prod --audit-level=high`.
The production image `hafbot-public-audit:188ced50` built successfully (image SHA-256
`e629731cd1252b5aedf70a75dcb59ea3c2d88ae8faf226cc0f07d6b48f2f6d48`).
`node scripts/container-smoke.mjs hafbot-public-audit:188ced50` passed empty-schema
initialization and full readiness. Later commits changed only test fixtures and audit evidence.

The production dependency audit passes the repository’s high-severity threshold. It reports one
low-severity transitive advisory in Azure Blob’s `fast-xml-parser` 5.11.0
([GHSA-474x-hrwr-fgx4](https://github.com/advisories/GHSA-474x-hrwr-fgx4)); dependency upgrades
are separate from the architectural cleanup. The ten lint advisories ask whether existing React
Effects are needed; they are not suppressed.

The root disposable database used loopback PostgreSQL16, one CPU / 256 MB,
32 MB shared buffers / 20 connections, and was removed after validation. No live Discord/OAuth/provider
action, push, PR or deployment is part of this source audit.

## Preserved work

The distinct handoff evidence is [`task-audit-handoff.md`](task-audit-handoff.md). Earlier broad
ports and stopped duplicate worktrees were not wholesale transplanted. C04's private migration
and upgrade draft remains superseded by the explicit public policy.

Provider-overload/subscription failures were terminal cancelled before replacement. R02's
preserved full drafts are identical (149,846 bytes), SHA-256
`300818c476e299f20905706567be38c3dab2faddbc94a514d533c0cb06dd3e6a`.
Task briefs, cancellation receipts, source patches and exact execution logs remain in the handoff
artifacts under `/tmp`; no failed task is running or queued.

<details>
<summary>Preserved implementation task IDs (all terminal)</summary>

- `node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3Adf8136b7-7c3b-435f-937e-aa875892e28d`.
- `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3Acc83b1ee-a638-4257-b4e3-6506a2063fc6`.
- `node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3A7e5d3f49-d1f4-46d9-bb28-c5a7f1e0bacf`.
- `node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3A336d8da9-27da-4220-a5ee-45211847c1c0`.
- `node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3Ab15027f9-41a9-481e-8ffb-64a615df6978`.
- `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3A085a21eb-9ab5-415a-a64c-05dd83bd8b28`.
- `node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3A638b91ef-e0e2-4284-9399-19b617c420d9`.
- `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3Ad1070517-9344-48d0-92c8-67ee5cb92701`.
- `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3A3c6658bd-5161-4f50-a576-247fd119296e`.
- `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3A291b2e09-c67d-4430-b23a-762a68234cce`.
- `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3Aeb7c02b8-96eb-4120-ae4e-45d565d19891`.
- `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3A53875c36-1a32-4f41-aaf1-c11a734d936f`.
- `node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3A8ed3b428-ef6f-4ca5-bd81-8126a88cdd02`.
- `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3Aca78aeb1-fdb9-4303-940c-29ccd508d410`.
- `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3A4ea26bd9-298b-4d35-9410-b037c9ce5b89`.
- `node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3A1af5370d-6900-430c-af56-541c95c2fabc`.
- `node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3A7681cfcd-44cd-4501-bce9-488a0e1c6aea`.
- `node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3A87580670-82d9-4f4c-b4e2-006283264438`.
- `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3Aa5aacc97-628f-4561-946b-fab4111b24d5`.

</details>
