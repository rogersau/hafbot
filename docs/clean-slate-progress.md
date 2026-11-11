# Public clean-slate integration

This is the authoritative combined inventory for the architecture audit and task audit.
The integration base is `t3/architectural-clean-slate-audit`. Public installations start empty;
there are no active deployments, inherited compatibility requirements or upgrade migrations.

## Current checkpoint and ownership

Verified source checkpoint: `fa1fe4e3d9d40a3fa17d75654b8e20a374adb598`. Current Admin and Node
types, contract drift and test compilation pass. Focused coordinator checks pass: C06 Admin
149/149, C11 service/runtime 262/262 and real PostgreSQL 3/3, C12 handler/runtime 368/368,
and P04 Event atomicity plus recurrence 7/7 real PostgreSQL. All focused runs have zero skips.
The broad validation below predates these integrations and must be rerun after remaining work.

| Area                                                          | Owner                    | Current state                                                              |
| ------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| Native stores, fresh schema, Worker/D1 removal                | Architecture             | Implemented; final combined acceptance pending                             |
| Shared validation, service capabilities and handler injection | Architecture integration | C03/C10/C11/C12 integrated individually                                    |
| Offering lifecycle consolidation C23                          | Task coordinator         | Released on verified `fa1fe4e`; approved bounded schema/store exception    |
| Direct native job outcomes R02                                | Architecture             | Original provider-overload draft preserved; same-provider recovery running |
| Shared HTTP/job service graph R01                             | Architecture             | Open; follows direct-job entrypoint changes                                |
| Final contracts/builds/types/public/PG/container validation   | Architecture             | Pending remaining integrations                                             |

## Reconciled evidence

- The distinct-fix manifest is preserved in [`task-audit-handoff.md`](task-audit-handoff.md).
  C01/C05 and native/schema portions of C13/P08 are superseded implementations, not permission
  to discard meaningful regressions. All integrations use individual reviewed changes.
- C03 is `230b35b` with whitespace-only name/label rejection corrected in `5a45465`.
  The endpoint regression failed with 200 before correction; 33 current contract/validation checks pass.
- Mention Protection is `3d1bb9e` (source `c247265`). Config replacement/delete/clear take an
  exclusive Guild transaction lock; burst recording takes a shared Guild lock, then a member lock,
  through insert/prune/count. Eight coordinator real-PG moderation checks pass, including proven
  race and rollback regressions plus stronger Image Rules/Bot Defense contracts.
- Object metadata conversion mode is removed in `b8edd9a` (source `fc9a023`): 10 object-store
  checks pass. S3 uses one current encoding and rejects incomplete security metadata.
- Steam authorization uses `/auth/steam/start` in `9dc7190`; 97 current Platform Link/verification
  checks pass. C13 UI is `0bbc4b6` (source `c297751`) plus `537036a` alias/unused type cleanup:
  195 checks and the Admin build/budgets pass. Current Steam verification is retained.
- C09 client cleanup is `408d976` (source `34033ba`); 14 client/webhook checks pass.
- C10 is `f8d7bd7` (source `d7d0a47`) plus `10743b5` required delivery composition: 91 checks pass.
- C11 is `5eb98c8` (source `7b98124`). Required persistence ports replace weak fallbacks. Native
  timed-role replacement/clear locks the whole set before deleting and inserting in one transaction.
  Forced-insert rollback and deterministic competing-writer regressions pass; removing the lock
  produced the recorded RED before restored GREEN.
- C12 is `d1988ea` (source `ecf465b`): required selected service picks replace handler factories.
  Same-instance/no-reconstruction and authentication-boundary regressions went from 5 failed to
  5 passed; coordinator combined handler/runtime acceptance passes 368/368.
- P04 is tests-only `9f02d5b` + `62b315e` (sources `a3f3f09` + `e9cd8ba`). The native Event adapter
  already satisfies Team/proposal/lifecycle/bulk rollback, CAS and Guild isolation. Configured PG
  runs pass all seven Event tests; unconfigured public runs use the standard skip guard. Proposal
  late-outbox failure proves rollback of a newly inserted signup. Native guard functions remain.
- C06 is `fa1fe4e` (source `9701e7f`): inert selector/context/page-policy plumbing is removed.
  Current workspace scope, authorization, navigation, directory and error/retry behavior remain.
  All 149 focused Admin checks pass.

## Shared implementer allocation

The global cap is five active implementers across both coordinators and all machines. Normal
reservation is architecture two, task coordinator three; the temporary three/two loan has ended.
All previous implementers are terminal; new R02 recovery is active. Cancelled overlaps C12/C17/C14/P01/C04 remain stopped;
worktrees, drafts, commits and evidence are preserved. No remote audit implementer is active.
All new implementation tasks use isolated checkouts with OpenCode Go
`opencode-go/deepseek-v4.1-flash`, `variant=max`, serial focused tests and disposable PostgreSQL
limited to one CPU, 256 MB, `shared_buffers=32MB`, `max_connections=20`.

| Reserved allocation  | Assignment             | State/base                                             |
| -------------------- | ---------------------- | ------------------------------------------------------ |
| Architecture 1       | R02 recovery           | Running on `17acff9` (source equal verified `fa1fe4e`) |
| Architecture 2       | R01 shared graph       | Dependency-gated; no delegate launched                 |
| Task coordinator 1   | C23 offering lifecycle | Released on `fa1fe4e`; awaiting launch receipt         |
| Task coordinator 2–3 | None                   | Empty; no work created solely to occupy slots          |

Completed implementation task IDs (all terminal):

- C03: `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3A3c6658bd-5161-4f50-a576-247fd119296e`.
- C10: `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3A291b2e09-c67d-4430-b23a-762a68234cce`.
- C11: `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3Aeb7c02b8-96eb-4120-ae4e-45d565d19891`.
- C09: `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3A53875c36-1a32-4f41-aaf1-c11a734d936f`.
- C12: `node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3A8ed3b428-ef6f-4ca5-bd81-8126a88cdd02`.
- P04: `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3Aca78aeb1-fdb9-4303-940c-29ccd508d410`.
- C06: `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3A4ea26bd9-298b-4d35-9410-b037c9ce5b89`.

Active R02 recovery: `node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3A1af5370d-6900-430c-af56-541c95c2fabc`, base `17acff9b61396043a74938de43d19c34ca7be9c3`. Owned production paths are queue contracts/consumers, narrow Billing/Commerce queue entrypoints, native job metadata/outcome handling and Node job registration; tests cover those seams and native settlement. No SQL stores, offering domain/schema or HTTP composition.

Failed original R02 task (terminal, cancelled to prevent continuation):
`node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3A7681cfcd-44cd-4501-bce9-488a0e1c6aea`.
Full tracked/untracked draft: `/tmp/haf-R02-preserved-overload.patch` (149,846 bytes), original
worktree unchanged. Recovery must reuse it, resolve meaningful failed assertions and preserve
native retry reasons/backoff. PostgreSQL settlement regressions belong in a discovered
`test/postgres-queue-outcomes.test.ts`, separate from pure direct-port tests.

## Remaining integration boundaries

C23 may consolidate only the approved offering model/consumers, offering-only baseline and
Drizzle declarations, six owning Commerce SQL stores and matching test SQLite stores/fixtures.
Use one `commerce_offerings` lifecycle with explicit `repair_previous_state`; remove the side
table and `active` projection. Preserve checkout gates, publication uniqueness, repair restoration,
retirement/refund/ledger/outbox atomicity and tenant scope. No migrations, views or compatibility
readers. Require meaningful fresh-schema, rollback and concurrency regressions on real PostgreSQL.

C23 also owns the narrow offering row/read mapping in `postgres-commerce-store.ts`,
`postgres-commerce-snapshot-provider.ts` and their test SQLite mirrors
`sqlite-commerce-store.ts`/`commerce/stripe-snapshot-provider.ts`. This exception changes only
current offering row types, selected columns and mappings; financial/provider behavior is excluded.

R02 alone owns `test/commerce-game-access-workflow.test.ts` queue invocation changes. C23 must
leave it untouched. Architecture will adapt that file's four old offering-lifecycle fixture fragments
after both tasks return. Test SQLite store mirrors are C23-owned; queue/runtime wrappers are R02-owned.
R02 may also update `test/postgres-gateway-retries.test.ts` only for direct queue calls.

R01 must build services from selected stores and supply the same instances to HTTP/jobs/scheduled
handlers. Preserve scheduled suspension filtering, lifecycle tracking, request origin semantics and
the genuine read-only maintenance boundary. It does not reopen C12 handler reconstruction work.

## Original task coverage

"Checkpoint" means implemented in the architecture baseline; final combined acceptance is still
required. It is not a claim that the original finding is closed by the existence of a port.

| Task             | Current reconciliation                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| C01              | Direct supported database driver; query failure/single-read regressions retained                                         |
| C02              | Integrated `02cbf2e`; 33 loading/error checks pass                                                                       |
| C03              | Integrated `230b35b`; 33 validation/contract checks pass; whitespace regression corrected                                |
| C04              | Fresh-install policy documented; old private-upgrade requirements superseded by user policy                              |
| C05              | Checkpoint: disabled persistence factories removed from production                                                       |
| C06              | Integrated `fa1fe4e` (source `9701e7f`); 149 focused Admin/error/loader checks and current types pass                    |
| C07              | Integrated `4af4df0`; abandoned prototype removed                                                                        |
| C08              | Checkpoint: unused Worker/dev/test tooling removed; retain test-only Workers types                                       |
| C09              | Integrated `408d976` + unused claims `537036a`; event aliases already removed; 14 focused client checks pass             |
| C10              | Integrated `f8d7bd7` + composition `10743b5`; 91 focused checks and Node/Admin/shared/test types pass                    |
| C11              | Integrated `5eb98c8` (source `7b98124`); required ports, atomic whole-set rules; 262 focused + 3 real-PG checks pass     |
| C12              | Integrated `d1988ea` (source `ecf465b`); required narrow services; 368 handler/runtime checks pass; R01 remains separate |
| C13              | Native identity/API checkpoint + UI `0bbc4b6` + final aliases `537036a`; 195 checks/types/Admin build/budgets pass       |
| C14              | Checkpoint: one ordered Reaction Role panel table and explicit panel identity                                            |
| C15              | Checkpoint: current Ticket response rules and independent feature flags                                                  |
| C16              | Checkpoint: Evidence Vault role list and private object metadata                                                         |
| C17              | Checkpoint: encrypted credential references in config/history/queues/logs                                                |
| C18              | Checkpoint: current signed controls; actor/generation enforcement and key rotation                                       |
| C19              | Checkpoint: strict current Gateway document and event key                                                                |
| C20              | Integrated `b8edd9a`; explicit media classification and no old metadata decoder                                          |
| C21              | Checkpoint: one stored entitlement plan field                                                                            |
| C22              | Checkpoint: current Billing prices and self-hosted policy                                                                |
| C23              | Released to task coordinator on verified `fa1fe4e`; one offering row, explicit prior repair state and real-PG invariants |
| C24              | Canonical public error fields/client parsing; complete endpoint/transport acceptance still pending                       |
| P01–P03, P05–P07 | Native identity, roles, Tickets, content, social and community stores at checkpoint                                      |
| P04              | Integrated `9f02d5b` + `62b315e` (sources `a3f3f09` + `e9cd8ba`); 7 real-PG Event atomicity/recurrence checks pass       |
| P08              | Integrated `3d1bb9e`; 8 real-PG moderation checks pass, including race and rollback regressions                          |
| P09–P14          | Native remaining stores, credentials, auth and context selection at checkpoint                                           |
| R01              | Open: one selected service graph shared by HTTP/jobs/handlers                                                            |
| R02              | Running: same-provider recovery reuses preserved draft for direct outcomes and durable settlement                        |
| R03              | Checkpoint: production Worker/DO/D1 host and SQL bridge removed; SQLite fixtures are test-only                           |
| B01              | Current fresh schema at checkpoint; C23 will change only its offering baseline                                           |
| B02              | Checkpoint: supported Node/test boundaries and retained tooling; final clean artifact build required                     |
| B03              | Current install docs at checkpoint; reconcile final service/queue/offering changes                                       |
| V01              | Pending exact combined source validation, including fresh container and concurrency contracts                            |

## Historical broad checkpoint validation

These counts predate the integrations above and are not final acceptance.

| Check                                                          | Historical result                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Native PostgreSQL suite                                        | 111 passed, 0 failed                                                               |
| Build behavior                                                 | 19 passed, 0 failed                                                                |
| Architecture                                                   | 7 passed, 0 failed                                                                 |
| Public suite                                                   | 3,513 passed, 2 failed, 59 skipped; obsolete error fixtures subsequently corrected |
| Application/test builds and Node/Admin/shared types            | Passed at architecture checkpoint                                                  |
| Lint                                                           | No errors; 13 existing React Effect warnings                                       |
| Formatting, documentation and fresh-schema container readiness | Passed at architecture checkpoint                                                  |

Final combined validation will replace these historical counts after R01/R02/C23 integration,
including all PostgreSQL concurrency regressions, current artifacts and fresh installation.
