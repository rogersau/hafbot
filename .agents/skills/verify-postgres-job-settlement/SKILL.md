---
name: verify-postgres-job-settlement
description: Check durable job reasons when changing PostgreSQL settlement, exhaustion, retry delay, or operator retry.
---

# Verify durable PostgreSQL job settlement

From the repository root, run `bash scripts/check-model.sh PostgresJobSettlement DurableSettlementReason`.
The current model must pass and the historical configuration must violate
`DurableSettlementReason`. Use pstack `/statechart` to inspect TLC results if it is available.

A retry keeps its provider reason while queued, after a new worker claims it, and when it
exhausts its attempts. Completion and an operator retry clear the reason. Before `3d82916`,
a worker could persist a delayed retry without its reason, leaving the operator with a time
and no explanation for the delay.

The model covers one job, two attempts per run, two retry reasons, one explicit terminal
outcome, successful completion, and at most one operator retry. Time advances only from
waiting to eligible. Lease ownership, crash recovery, exact timing, and unrelated jobs are
outside the model.

`Settle`, `Claim`, and `OperatorRetry` correspond to `settle`, `claim`, and `retryOne`
in `src/runtime/postgres/postgres-job-queue.ts`. The model was verified against
`cf6ce49839485a3c924d2e263fffd03ace51ccd6`. Use `pnpm test:postgres` with a disposable database
to run `test/postgres-queue-outcomes.test.ts` and `test/postgres-jobs.test.ts` against the real
worker and store. They cover persisted reasons, restart, exhaustion, delay, and stale leases.
Advance the sync commit after checking the model against the store and passing both checks.
