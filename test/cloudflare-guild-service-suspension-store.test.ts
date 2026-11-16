/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { createSqliteGuildServiceSuspensionStore } from "./support/sqlite/runtime/sqlite-guild-service-suspension-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("guild service suspensions persist, audit, and restore without deleting history", async () => {
  const db = new SqliteD1Database();
  const store = createSqliteGuildServiceSuspensionStore(db as unknown as D1Database);

  await store.suspendGuild({
    guildId: "guild-1",
    reason: "Repeated automated abuse",
    actorUserId: "admin-1",
    occurredAtMs: 100,
  });
  assert.equal((await store.readActiveSuspension("guild-1"))?.reason, "Repeated automated abuse");

  await store.restoreGuild({ guildId: "guild-1", actorUserId: "admin-2", occurredAtMs: 200 });
  assert.equal(await store.readActiveSuspension("guild-1"), null);
  assert.deepEqual(
    (await store.listAuditEvents("guild-1")).map((event) => event.action),
    ["suspended", "restored"],
  );
  assert.equal((await store.listSuspensions({ query: "guild-1" }))[0]?.removedByUserId, "admin-2");
});
