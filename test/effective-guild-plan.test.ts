/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createEffectiveGuildPlanStore } from "../src/runtime/effective-guild-plan";

test("effective Guild plan reads only the Billing-owned canonical projection", async () => {
  const store = createEffectiveGuildPlanStore({
    projections: {
      async readGuildPlanProjection(guildId) {
        return guildId === "paid" ? { guildId, plan: "premium_plus", updatedAtMs: 10 } : null;
      },
      async upsertGuildPlanProjection() {},
    },
  });
  assert.deepEqual(await store.readEffectiveGuildPlan("paid"), {
    guildId: "paid",
    plan: "premium_plus",
    updatedAtMs: 10,
  });
  assert.deepEqual(await store.readEffectiveGuildPlan("missing"), {
    guildId: "missing",
    plan: "free",
    updatedAtMs: 0,
  });
});
