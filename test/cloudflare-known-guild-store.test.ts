/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createSqliteKnownGuildStore } from "./support/sqlite/runtime/sqlite-known-guild-store";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

test("KnownGuildStore atomically identifies the first insert", async () => {
  const { database } = createProductionRuntimeStores();
  const store = createSqliteKnownGuildStore(database.d1);
  const record = {
    guildId: "123456789012345678",
    name: "Guild",
    memberCount: 10,
    ownerId: "234567890123456789",
    icon: null,
    installedAtMs: 1,
    removedAtMs: null,
  };

  const results = await Promise.all([
    store.insertKnownGuild(record),
    store.insertKnownGuild(record),
  ]);

  assert.deepEqual(results.sort(), [false, true]);
  assert.deepEqual(await store.readKnownGuild(record.guildId), record);
});
