---
name: verify-timed-role-replacement
description: Check competing timed-role rule replacements when editing the PostgreSQL rule write or its transaction boundary.
---

# Verify timed-role replacement

From the repository root, run `bash scripts/check-model.sh TimedRoleReplacement CommittedRulesAreWhole`.
The model must pass and its split-write historical configuration must violate
`CommittedRulesAreWhole`. Use pstack `/statechart` to inspect TLC results if it is available.

Two replacements of the same Guild and configuration type must leave one complete rule
set. Before `5eb98c8`, both writers could delete and commit before either inserted. Their
separate inserts then left rules from both requests active.

The model has two writers with disjoint sets of two rules, one Guild and one configuration
type. `DeleteRules` opens the replacement and `InsertRules` commits it. In the current model,
they share the transaction and lock in `upsertTimedRoleConfigRules` in
`src/runtime/postgres/postgres-timed-role-store.ts`. The model checks concurrent successful
writes. The PostgreSQL contract covers write failure rollback, explicit empty replacement, and
isolation between configuration types and Guilds.

The model was checked against `d1337fe6d75cbbd66280fd42557030ef444b594f`. After editing the
write, update the model alongside the store and run both TLC and
`test/postgres-timed-role-atomicity.test.ts` via `pnpm test:postgres` on a disposable database.
Advance the sync commit only after both checks pass.
