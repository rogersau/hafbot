/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  GuildServicePolicy,
  GUILD_SERVICE_UNAVAILABLE_MESSAGE,
} from "../src/runtime/guild-service-policy";
import type { GuildServiceSuspensionStore } from "../src/runtime/contracts";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

test("GuildServicePolicy reads live suspension state and restores immediately", async () => {
  const store = productionSuspensionStore();
  await store.suspendGuild({
    guildId: "guild-1",
    reason: "Internal abuse evidence",
    occurredAtMs: 100,
    actorUserId: "admin-1",
  });
  const policy = new GuildServicePolicy(store);

  assert.equal(await policy.isGuildSuspended("guild-1"), true);
  await store.restoreGuild({ guildId: "guild-1", occurredAtMs: 200, actorUserId: "admin-2" });
  assert.equal(await policy.isGuildSuspended("guild-1"), false);
});

test("GuildServicePolicy customer response never exposes the internal reason", () => {
  const response = GuildServicePolicy.buildUnavailableResponse();

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { error: GUILD_SERVICE_UNAVAILABLE_MESSAGE });
  assert.doesNotMatch(JSON.stringify(response.body), /reason|abuse/i);
});

function productionSuspensionStore(): GuildServiceSuspensionStore {
  const store = createProductionRuntimeStores().stores.guildServiceSuspensions;
  if (!store) throw new Error("Guild service suspension store is unavailable.");
  return store;
}
