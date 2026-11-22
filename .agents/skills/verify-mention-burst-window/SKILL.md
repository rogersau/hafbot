---
name: verify-mention-burst-window
description: Check Mention Protection lock ordering when changing burst recording, Guild configuration replacement, or explicit window clearing in PostgreSQL.
---

# Verify the Mention Protection burst window

From the repository root, run `bash scripts/check-model.sh MentionBurstWindow FreshWindowCounts`.
The current model must pass and the unlocked historical configuration must violate
`FreshWindowCounts`. Use pstack `/statechart` to inspect TLC results if it is available.

A message arriving after configuration replacement takes its lock belongs to the cleared
window. It must return a count of one and remain recorded. Before `3d1bb9e`, recording could
read the old window while replacement was in progress. It could return two and then lose
the new message when replacement finished clearing the window.

The model covers one Guild, one replacement, and one arriving message per member for two
members with one existing message each. It checks committed counts and rows. It abstracts
PostgreSQL rollback, expiry, message deduplication and commands that do not clear a window.

- `BeginReplacement` and `CommitReplacement` correspond to exclusive Guild locking and
  transaction commit in `withBurstWindow` for `upsertConfig`, `deleteConfig` and `clearBurstWindow`.
- `BeginRecording` and `CommitRecording` correspond to the shared Guild lock, member lock and
  insert/prune/count transaction for `recordBurstMessage`.

The model was checked against `1185d2bcb70b81b3fb1c247b805565ba44412432` in
`src/runtime/postgres/postgres-mention-protection-store.ts`. When these paths change, also run
`test/postgres-moderation-invariants.test.ts` through `pnpm test:postgres` on a disposable database.
It replays the blocked replacement, checks different members and Guilds, and verifies rollback.
Advance the sync commit after reconciling the model with the store and passing both checks.
