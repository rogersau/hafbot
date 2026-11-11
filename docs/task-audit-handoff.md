# Distinct audit handoff

Architecture owns final integration on `t3/architectural-clean-slate-audit`.
Confirmed adaptation base: `915455f8e138c75483c5412ae72063209a664db8`.
Authoritative progress/allocation: architecture's `docs/clean-slate-progress.md`.
This manifest is evidence and scoped handoff, not a second progress inventory.

Original implementation checkpoint: `ea540062527e26c25bc831fd6cc7bf15974f7c56`
on `t3/audit-task-breakdown`. All commits and stopped worktrees remain preserved.
Do not wholesale merge/rebase this branch into architecture.

## Completed source reconciliation

| Fix                                            | Preserved implementation commit            | Paths / useful evidence                                                                                                                                                               | Reconciliation                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C07 prototype removal                          | `11623f3b0f90a9bd9ba66375f87aa81f9c310592` | 20 prototype files deleted; Admin config exclusion removed; Admin types/build/budgets pass                                                                                            | Architecture accepted as `4af4df0`; do not recreate                                                                                                              |
| C02 failed Admin reads                         | `c7eadfa7baa91f5260fd5632f29431dfe1ee19ed` | Admin loader/client and route loaders; new route error/no-editor regressions; 33 focused tests pass                                                                                   | Architecture accepted as `02cbf2e`; do not recreate                                                                                                              |
| C03 one shared webhook request schema          | `9addc0e8c7f77ad000f541af386d3cb7aa3c2efc` | Shared schema, UUID OpenAPI projection, removal of second handler parse; endpoint rejects invalid IDs/URLs/regexes/duplicates/references before writes                                | Task coordinator adapts only constraints/tests to current reference-only model and canonical error fields                                                        |
| C10 mandatory event atomic capabilities        | `b5e3324a297a51dc9fc27ab569ee52700cd5f781` | EventStore contract + EventsService; no partial-write fallback after atomic failure, no default state version/local limiter; 152 focused event/interaction/context/factory tests pass | Task coordinator adapts service/contracts/tests; architecture owns native ports, runtime graph and final integration                                             |
| C11 required timed-role/suggestion persistence | `e8f09937437b3c6ac7c4f3bd536ea21fd33cfe27` | Generic rule reads/writes required; limiter always enforced; injected insert failure preserves old rules; 310 combined focused tests pass                                             | Task coordinator adapts service/contracts/tests and specifically granted native timed-role replacement transaction/serialization plus matching SQLite test store |
| C01 query failure propagation                  | `6ae50349685ec7322dd4ecca9d47ae947c4a8fac` | Empty query once, error cause preserved, all rows retained; six coordinator regressions pass                                                                                          | Production wrapper superseded by native runtime; architecture confirms supported test driver too                                                                 |
| C05 disabled-store/fallback removal            | `b35d741cb2727317cae3b846ee2ff93ecb28fe51` | 27 dead factories removed; mandatory persistent suggestion/incident types; focused types/runtime checks pass                                                                          | Runtime implementation superseded by architecture; retain relevant contract evidence                                                                             |
| C13 modern-only Player Link                    | `0f656bc918ea48913e32040729a8336c2e455ae5` | Legacy Steam tables/store/API fallback removed; modern identity races/rollback proved against real PG; six PG contracts pass                                                          | Persistence/runtime/schema superseded by architecture; inspect only uncovered UI naming if still useful                                                          |
| P08 native moderation                          | `fb3065aff93aa46c4713c15fc66b69d26d993389` | Three native stores + meaningful PG domain invariants                                                                                                                                 | Do not overwrite architecture's different files; architecture ports only the lock invariant/regression below                                                     |

Original broad unit runs included existing environment skips and occasional browser timeouts.
They are not final combined acceptance. Architecture owns that validation. On this branch,
Node/Admin/shared/test types, focused behavior, Admin/Node builds, contract drift, formatting,
inventory and disposable PG gates passed as recorded in the historical task plan.

## Critical Mention Protection regression

Correction: `94baa1a10c47d1819ca4bf78198e58aec0da2115`.

- Production source: `src/runtime/postgres/postgres-mention-protection-store.ts`;
  `clearBurstWindow`, `recordBurstMessage`, `lockConfig`.
- Regression source: `test/postgres-moderation-stores.test.ts`,
  `verifyMentionProtectionConfigConcurrency` (line 740 in that commit) and
  `waitForMentionStoreLock` (line 824).
- Readable patch artifact:
  `/tmp/hafbot-mention-protection-concurrency-94baa1a.patch`.

Invariant: replacement/delete and explicit clearing hold an exclusive per-guild transaction
lock. Burst recording acquires a shared lock on the SAME key before its per-user window lock,
then holds them through insert/prune/count. Different users may record concurrently; a clear
cannot interleave and leave an inconsistent old/new window.

The real PostgreSQL test creates a temporary BEFORE UPDATE trigger that waits on a test gate.
It holds the gate, begins configuration replacement, then starts burst recording. It observes
database lock waits, requires recording to remain blocked, releases the gate, and verifies the
recording returns 1 with exactly the new row remaining. Finally releases/settles all transactions
and removes the trigger/function. No query mock or source-text assertion.

Exact local evidence:
`pnpm run build:test:types`;
`python3 /tmp/hafbot-audit-postgres-verify.py dist-tests/test/postgres-moderation-stores.test.js`;
`pnpm run typecheck:node`; changed-file `oxlint` and formatting.

Before fix: RED, actual `completed` vs expected `blocked`, 0 pass/1 fail.
After fix: GREEN, full moderation contract 1 pass/0 fail/0 skip (all domain helper scenarios).
PostgreSQL 16, loopback only, 1 CPU/256 MB, shared_buffers=32MB/max_connections=20;
container removed after each run. The old helper uses the old migration fixture; port to the
current initializer and architecture's existing native store, as architecture's assigned task does.

## Ownership and slots

All five recent task delegates C12/C17/C14/P01/C04 are terminal `interrupted`,
with no pending requests. Local task active count is zero at handoff; nux audit active count zero.
Full cancellation receipts are preserved in
`/tmp/hafbot-audit-cancelled-overlap-receipts.json`.

Architecture reserves 2 global implementer slots; task coordinator reserves 3.
Model is `opencode-go/deepseek-v4.1-flash`, `variant=max`; maximum 5 across both
coordinators/all machines. No review-only delegates or duplicate port restarts.

Architecture owns Mention Protection lock port/test, R2 metadata mode removal, server errors,
parsers, permissions mapping, `src/contracts/admin/tickets.ts`, runtime/handler injection,
native persistence, current schema and final combined validation.

Task coordinator's first three are C03/C10/C11 adaptations with agreed disjoint ownership:
C10 owns `test/interaction-routes.test.ts`; C11 owns `test/runtime-app.test.ts`;
C03 uses a NEW isolated webhook-validation test. Server error fields remain
`fieldIssues`, `staleReason`, `retryAfterSeconds`.

The granted C11 persistence exception is only native timed-role whole-set replacement
transaction/serialization, obsolete four config-wrapper removal if required, matching
`test/support/sqlite/runtime/sqlite-timed-role-store.ts`, and a NEW focused PG rollback/race test.
No other native port/schema edits.

## Preserved open distinct drafts and gaps

- C06: `/home/james/.t3/worktrees/hafbot-public/t3-564f5489-c9131f830cc20951`
  (`t3/remove-retired-admin-plumbing`): Admin workspace selector/page-policy residue and tests.
- C09: `/home/james/.t3/worktrees/hafbot-public/t3-c8a0ca7f-33c253084e93424a`
  (`t3/remove-unused-service-aliases`): aliases/revision vocabulary; verify remaining callers.
- C23: `/home/james/.t3/worktrees/hafbot-public/t3-b10aca92-3002427f84c3fe2e`
  (`t3/consolidate-offering-lifecycle`): offering service/types/store draft. Still OPEN on
  architecture; requires a separately scoped schema/native-store exception before assignment.
- C04 newer worktree `/home/james/.t3/worktrees/hafbot-public/t3-ca1569a3-a1d4d467b61ae5e4`
  is clean at its old base; original draft in
  `/home/james/.t3/worktrees/hafbot-public/t3-ffeb97f3-26748f50f8cf5e63` is preserved.
  Private-upgrade/migration-ledger/checksum requirements in that old draft/plan are superseded.
  Current public policy is NO active deployments, inherited migrations or compatibility
  abstractions. Do not integrate those requirements into public runtime/docs.
- Other stopped native/runtime/schema drafts and completed old ports remain preserved as
  reference only. Do not restart/recreate them. The architecture inventory decides coverage.
