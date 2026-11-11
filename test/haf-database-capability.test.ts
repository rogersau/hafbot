/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { createHafDatabaseCapability } from "./support/sqlite/runtime/haf-database-capability";

function createDatabase(): D1Database {
  return {
    exec: async () => ({ count: 0, duration: 0 }),
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      }),
    }),
    batch: async () => [],
  } as unknown as D1Database;
}

test("createHafDatabaseCapability caches the capability and its Drizzle database by binding", () => {
  const binding = createDatabase();
  const first = createHafDatabaseCapability(binding);
  const second = createHafDatabaseCapability(binding);

  assert.strictEqual(first.binding, binding);
  assert.strictEqual(first, second);
  assert.strictEqual(first.drizzle, second.drizzle);
});
