import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "./support/sqlite-d1-database";
import { IdSequence } from "./support/id-sequence";
import { TestClock } from "./support/test-clock";

test("production-shaped database exposes D1 separately from test helpers", async (t) => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  assert.ok(database.snapshotSchema().some((entry) => entry.name === "webhook_proxy_configs"));
  assert.equal("query" in database.d1, false);
});

test("IDs and time are deterministic per harness instance", () => {
  const ids = new IdSequence("case");
  const clock = new TestClock(1000);
  assert.deepEqual([ids.next(), ids.next()], ["case-id-1", "case-id-2"]);
  clock.advance(250);
  assert.equal(clock.now(), 1250);
});
