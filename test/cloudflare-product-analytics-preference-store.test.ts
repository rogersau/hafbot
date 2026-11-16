/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createSqliteProductAnalyticsPreferenceStore } from "./support/sqlite/runtime/sqlite-product-analytics-preference-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("product analytics preference defaults enabled and remains isolated by Guild", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteProductAnalyticsPreferenceStore(database as unknown as D1Database);

  assert.equal(await store.readEnabled("guild-1"), true);
  await store.setEnabled("guild-1", false, 100);
  assert.equal(await store.readEnabled("guild-1"), false);
  assert.equal(await store.readEnabled("guild-2"), true);
  await store.setEnabled("guild-1", true, 200);
  assert.equal(await store.readEnabled("guild-1"), true);
});
