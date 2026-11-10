/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createCloudflareGuildEntitlementStore } from "../src/runtime/cloudflare-guild-entitlement-store";
import { createCloudflareGuildPlanProjectionStore } from "../src/runtime/cloudflare-guild-plan-projection-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("feature readers observe only Billing-owned canonical plan values", async () => {
  const database = new SqliteD1Database();
  const projection = createCloudflareGuildPlanProjectionStore(database as unknown as D1Database);
  const reader = createCloudflareGuildEntitlementStore(database as unknown as D1Database);
  assert.equal((await reader.readGuildEntitlement("guild")).tier, "free");
  await projection.upsertGuildPlanProjection({
    guildId: "guild",
    plan: "premium_plus",
    updatedAtMs: 10,
  });
  assert.deepEqual(await reader.readGuildEntitlement("guild"), {
    guildId: "guild",
    tier: "premium_plus",
    updatedAtMs: 10,
  });
});
