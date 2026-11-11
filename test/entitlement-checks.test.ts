/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { assertGuildPremiumTier } from "../src/runtime/entitlement-checks";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

test("assertGuildPremiumTier treats premium plus as premium for one Guild without upgrading another", async () => {
  const fixture = createProductionRuntimeStores();
  fixture.database.execRaw(
    "INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ('guild-plus', 'premium_plus', 1)",
  );

  assert.deepEqual(await assertGuildPremiumTier(fixture.stores.guildEntitlements, "guild-plus"), {
    ok: true,
  });
  assert.deepEqual(await assertGuildPremiumTier(fixture.stores.guildEntitlements, "guild-free"), {
    ok: false,
    message: "This feature requires the premium tier.",
  });
});
