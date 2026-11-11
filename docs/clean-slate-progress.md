# Public clean-slate integration

This is the authoritative combined inventory for the architecture audit and task audit.
The integration base is `t3/architectural-clean-slate-audit`. Public installations start empty;
there are no active deployments, inherited compatibility requirements or upgrade migrations.

## Ownership

| Area                                                | Owner                              | State and evidence                                                                  |
| --------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| Native PostgreSQL stores and runtime composition    | Architecture thread                | Implemented; 111 PostgreSQL contracts pass                                          |
| Worker/D1 production removal and injected handlers  | Architecture thread                | Implemented; 7 architecture checks pass; SQLite is test-only                        |
| Canonical installation schema and startup           | Architecture thread                | Implemented; fresh-schema container readiness passes                                |
| Canonical persisted and queue documents             | Architecture thread                | Implemented; current signatures, Gateway envelopes and encrypted webhook references |
| Server error contract                               | Architecture thread                | Current fields only; 65 focused checks and type/test builds pass                    |
| Admin loading/error UI and prototypes               | Architecture integration           | C02 and C07 integrated as `02cbf2e` and `4af4df0`; 33 checks and Admin types pass   |
| Shared validation and required service capabilities | Task thread adaptations            | Manifest reconciled; C03, C10 and C11 adaptations remain open                       |
| Service atomicity and regressions                   | Integration by architecture thread | Preserve and reconcile distinct task fixes individually                             |
| Final combined validation                           | Architecture thread                | Pending combined integration                                                        |

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
- Accept only distinct remaining task work adapted onto the architecture checkpoint. Verify
  equivalent behavior before marking an overlapping task covered.

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
| Architecture 2       | `node:delegated-task:command%3Amcp%3Ab9329776-8b78-4bb4-a0cf-a41448d7db46%3Adelegate-task%3A766003cd-614e-4828-ab87-21da714ee538` | `915455f` | S3 adapter; retired R2 metadata reader; object-store tests         |
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
