/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createSqliteAppConfigStore } from "./support/sqlite/runtime/sqlite-app-config-store";
import { createSqliteBlocklistStore } from "./support/sqlite/runtime/sqlite-blocklist-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("createSqliteAppConfigStore upserts config read through public stores", async () => {
  const database = new SqliteD1Database();
  const firstStore = createSqliteAppConfigStore(database as unknown as D1Database);
  const secondStore = createSqliteAppConfigStore(database as unknown as D1Database);
  const blocklist = createSqliteBlocklistStore(database as unknown as D1Database, "bot-default");

  assert.strictEqual(firstStore, secondStore);
  assert.equal((await blocklist.readConfig()).botUserId, "bot-default");

  await firstStore.upsertAppConfig({ key: "bot_user_id", value: "bot-from-db" });
  assert.equal((await blocklist.readConfig()).botUserId, "bot-from-db");

  await firstStore.upsertAppConfig({ key: "bot_user_id", value: "bot-replaced" });
  assert.equal((await blocklist.readConfig()).botUserId, "bot-replaced");
  assert.equal(database.execCalls, 0);
});
