# Public clean-slate integration

This is the authoritative combined inventory for the architecture audit and task audit.
The integration base is `t3/architectural-clean-slate-audit`. Public installations start empty;
there are no active deployments, inherited compatibility requirements or upgrade migrations.

## Ownership

| Area                                                | Owner                              | State and evidence                                                                    |
| --------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| Native PostgreSQL stores and runtime composition    | Architecture thread                | Implemented; 111 PostgreSQL contracts pass                                            |
| Worker/D1 production removal and Gateway injection  | Architecture thread                | Implemented; 7 architecture checks pass; SQLite is test-only                          |
| Canonical installation schema and startup           | Architecture thread                | Implemented; fresh-schema container readiness passes                                  |
| Canonical persisted and queue documents             | Architecture thread                | Implemented; current signatures, Gateway envelopes and encrypted webhook references   |
| Server error contract                               | Architecture thread                | Current fields only; 65 focused checks and type/test builds pass                      |
| Admin loading/error UI and prototypes               | Architecture integration           | C02 and C07 integrated as `02cbf2e` and `4af4df0`; 33 checks and Admin types pass     |
| Shared validation and required service capabilities | Task thread adaptations            | C03 integrated as `230b35b`; C10/C11 remain in progress                               |
| Handler injection and direct job outcomes           | Architecture thread                | C12/R01/R02 remain open; broad factory reconstruction and queue callbacks still exist |
| Service atomicity and regressions                   | Integration by architecture thread | Preserve and reconcile distinct task fixes individually                               |
| Final combined validation                           | Architecture thread                | Pending combined integration                                                          |

## Reconciliation queue

- The distinct-fix manifest is preserved in [`task-audit-handoff.md`](task-audit-handoff.md).
  C01/C05 and native/schema portions of C13/P08 are superseded implementations whose useful
  regression evidence must remain. C02/C07 are integrated; C03/C10/C11 are distinct adaptations.
- Port the configuration/clear versus burst-recording serialization invariant from `94baa1a`,
  preserving its PostgreSQL concurrency regression. Do not overwrite native adapters with the
  overlapping `fb3065a` ports.
- R2 Workers metadata conversion mode removed as `b8edd9a` (source `fc9a023`). Coordinator
  verification: 10 object-store tests, test type build and Node types pass. S3 head/get use
  canonical metadata and reject incomplete provider metadata.
- Current game-access transmission markers require their operation identity; 52 focused tests
  and the test type build pass.
- Steam authorization uses one current `/auth/steam/start` route, including command and
  verification link producers, as `9dc7190`; test compilation and 97 current Platform Link and
  Member Verification checks pass. Callback routes retain their current behavior.
- Accept only distinct remaining task work adapted onto the architecture checkpoint. Verify
  equivalent behavior before marking an overlapping task covered.
- C12 remains open: `interaction-handler` and `application-command-handler` construct a full
  feature graph; LFG and Marketplace reconstruct missing services. The preserved C12 patch is
  `/tmp/hafbot-C12-preserved-handler-injection.patch`, including narrow service types and test
  helpers. Reuse its seam after C10's fixture changes integrate; do not restart the cancelled task.
- R01 remains open: the HTTP app and Node job handlers each construct feature services.
  Selected services must be built once and supplied to both, with same-instance regressions.
- R02 remains open: `createSingleMessageHandler` synthesizes a one-message QueueBatch with
  ack/retry callbacks. Native jobs need direct validated payload/outcome handlers. Keep durable
  retry/terminal handling, Gateway ordering, fencing, idempotency and current logs.

## Shared implementer allocation

The global limit is five active implementers across both coordinators and all machines. The
agreed allocation reserves two slots for architecture and three for the task coordinator.
Active-thread inventories confirm no remaining implementers locally or on linked nux before
the new assignments. Cancelled duplicate assignments must not restart. All new tasks use isolated
checkouts with OpenCode Go
`opencode-go/deepseek-v4.1-flash`, `variant=max`, serial focused tests and disposable PostgreSQL
containers limited to one CPU and 256 MB.

Architecture's ready briefs cover the proven Mention Protection configuration/burst locking
invariant and the remaining object metadata conversion mode.
The task coordinator adapts distinct completed shared-validation and service-atomicity fixes;
offering lifecycle consolidation (C23), retired selector plumbing (C06) and unused aliases (C09)
still need explicit reconciliation. None is assumed covered merely because native stores exist.

| Slot                 | Task ID                                                                                                                           | Base      | Owned paths                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ |
| Architecture 1       | `node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3A4122985e-4394-4ede-96df-0ba903391392` | `915455f` | Mention Protection native store; new moderation invariant test     |
| Architecture 2       | `node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3A82952271-086d-4b90-98d1-429e285e12df` | `9dc7190` | Residual C13 Admin route/page/diagnostic aliases from `0f656bc`    |
| Task coordinator 1–3 | Reserved to task coordinator                                                                                                      | `915455f` | C03/C10/C11 adaptations with disjoint paths agreed in coordination |

Mention Protection is running. The R2 metadata task is integrated; its slot will reconcile the
remaining C13 UI aliases from completed source `0f656bc`. C03, C10 and C11 run in the three task
coordinator slots. The coordinator reviews and integrates each returned change before final
combined validation. Mention Protection must retain the proven RED/GREEN concurrency regression.

Task-coordinator implementation IDs on base `915455f`:

- C03: `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3A3c6658bd-5161-4f50-a576-247fd119296e`.
- C10: `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3A291b2e09-c67d-4430-b23a-762a68234cce`.
- C11: `node:delegated-task:command%3Amcp%3A1c26d519-eb78-4bba-bd0e-f85880259750%3Adelegate-task%3Aeb7c02b8-96eb-4120-ae4e-45d565d19891`.

C10 owns the interaction-route fixture; C11 owns the runtime-app fixture and the narrowly granted
native/SQLite timed-rule whole-set replacement changes. C03 owns a new isolated validation test.
The C13 UI reconciliation must remain disjoint from those files and all native/schema work.

C23 is queued in the task coordinator's allocation. It may launch only after C11 is terminal
and integrated into an explicit new architecture base. Its approved exception is the offering
domain model/service/consumers, offering-only PostgreSQL and test SQLite declarations/baselines,
and lifecycle SQL/mappings in the six owning Commerce stores. It must consolidate state and
fields on `commerce_offerings`, retain explicit `repair_previous_state`, remove the lifecycle
side table and `active` projection, and preserve financial, retirement, ledger and outbox atomicity.
It must test fresh schema, repair restoration, publication uniqueness/concurrency, checkout gates,
tenant scope and rollback against real resource-limited PostgreSQL with zero skips. No migrations,
views or compatibility readers may be added. C06 waits for C13-owned UI paths; C09 stays queued.

## Original task coverage

"Checkpoint" means implemented in the architecture baseline; final combined acceptance is still
required. It is not a claim that the original finding is closed by the existence of a port.

| Task    | Current reconciliation                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------- |
| C01     | Direct supported database driver; query failure/single-read regressions retained                     |
| C02     | Integrated `02cbf2e`; 33 loading/error checks pass                                                   |
| C03     | Integrated `230b35b`; 33 validation/contract checks pass; whitespace regression corrected            |
| C04     | Fresh-install policy documented; old private-upgrade requirements superseded by user policy          |
| C05     | Checkpoint: disabled persistence factories removed from production                                   |
| C06     | Queued: retired selector/page-policy plumbing; waits for C13 UI ownership                            |
| C07     | Integrated `4af4df0`; abandoned prototype removed                                                    |
| C08     | Checkpoint: unused Worker/dev/test tooling removed; retain test-only Workers types                   |
| C09     | Narrow Commerce client/webhook alias cleanup running; event aliases already removed                  |
| C10     | Required atomic Event capabilities adaptation running                                                |
| C11     | Required timed-role/suggestion capabilities and native rule atomicity adaptation running             |
| C12     | Open: remaining handler graph reconstruction; reuse preserved draft after C10                        |
| C13     | Native identity/API cleanup at checkpoint; residual UI reconciliation running; auth route `9dc7190`  |
| C14     | Checkpoint: one ordered Reaction Role panel table and explicit panel identity                        |
| C15     | Checkpoint: current Ticket response rules and independent feature flags                              |
| C16     | Checkpoint: Evidence Vault role list and private object metadata                                     |
| C17     | Checkpoint: encrypted credential references in config/history/queues/logs                            |
| C18     | Checkpoint: current signed controls; actor/generation enforcement and key rotation                   |
| C19     | Checkpoint: strict current Gateway document and event key                                            |
| C20     | Integrated `b8edd9a`; explicit media classification and no old metadata decoder                      |
| C21     | Checkpoint: one stored entitlement plan field                                                        |
| C22     | Checkpoint: current Billing prices and self-hosted policy                                            |
| C23     | Queued: one offering lifecycle; explicit C11 integration gate and schema exception                   |
| C24     | Canonical public error fields/client parsing; complete endpoint/transport acceptance still pending   |
| P01–P07 | Native identity, roles, Tickets, Events, content, social and community stores at checkpoint          |
| P08     | Native moderation at checkpoint; proven Mention Protection atomicity port/regressions running        |
| P09–P14 | Native remaining stores, credentials, auth and context selection at checkpoint                       |
| R01     | Open: one selected service graph shared by HTTP/jobs/handlers                                        |
| R02     | Open: direct native job payload/outcome path; bounded cache/native enqueue already implemented       |
| R03     | Checkpoint: production Worker/DO/D1 host and SQL bridge removed; SQLite fixtures are test-only       |
| B01     | Current fresh schema at checkpoint; C23 will change only its offering baseline                       |
| B02     | Checkpoint: supported Node/test boundaries and retained tooling; final clean artifact build required |
| B03     | Current install docs at checkpoint; reconcile final service/queue/offering changes                   |
| V01     | Pending exact combined source validation, including fresh container and concurrency contracts        |

C03 review found whitespace-only names/labels passed before trimming. The added endpoint
regression returned 200 instead of 400 before correction. The shared schema now rejects them
before credential/config writes; all 33 focused validation/contract checks pass with no skips.

## Checkpoint validation

| Check                                      | Latest result                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| Native PostgreSQL suite                    | 111 passed, 0 failed                                                              |
| Build behavior                             | 19 passed, 0 failed                                                               |
| Architecture                               | 7 passed, 0 failed                                                                |
| Public suite                               | 3,513 passed, 2 failed, 59 skipped; the two error-fixture corrections await rerun |
| Application and test builds                | Passed before the final error-contract edit                                       |
| Node, Admin and shared type checks         | Passed before the final error-contract edit                                       |
| Lint                                       | No errors; 13 existing React Effect warnings                                      |
| Formatting and diff whitespace             | Passed before the final error-contract edit                                       |
| Documentation build                        | Passed                                                                            |
| Production container with fresh PostgreSQL | Passed                                                                            |

The two failing public assertions expected an invalid error envelope to be accepted as a malformed
fixture and a retired stale-preview conversion. Their fixtures now exercise the current contract.
Ticket response validation also now enforces the same Discord modal limits as writes. These changes
must be validated together before the integration is considered complete.
