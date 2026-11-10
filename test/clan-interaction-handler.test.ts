/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  handleClanComponentInteraction,
  handleClanModalSubmitInteraction,
} from "../src/runtime/clan-interaction-handler";
import type { DiscordInteraction, RuntimeStores } from "../src/runtime/app-types";
import type { ClanService } from "../src/services/clan-service";

test("Clan request panel button opens the creation modal", async () => {
  const interaction = clanInteraction("clan:request");
  const stores = {
    clans: { readPendingRequestByRequester: async () => null },
  } as unknown as RuntimeStores;
  const response = await handleClanComponentInteraction(interaction, stores, {} as ClanService);
  const body = (await response.json()) as { type: number; data: { custom_id: string } };
  assert.equal(body.type, 9);
  assert.equal(body.data.custom_id, "clan:request-modal:new");
});

test("Clan review button passes server-side member authority and revision to ClanService", async () => {
  let reviewed: Record<string, unknown> | null = null;
  const service = {
    async reviewRequest(input: Record<string, unknown>) {
      reviewed = input;
      return { id: "clan-1" };
    },
  } as unknown as ClanService;
  const stores = {
    clans: { readRequestById: async () => ({ guildId: "guild-1" }) },
  } as unknown as RuntimeStores;
  const interaction = clanInteraction("clan:review:request-1:4:approve");
  interaction.member!.roles = ["review-role"];
  interaction.member!.permissions = "8";
  const response = await handleClanComponentInteraction(interaction, stores, service);
  assert.equal(response.status, 200);
  assert.deepEqual(reviewed, {
    guildId: "guild-1",
    requestId: "request-1",
    reviewerId: "reviewer-1",
    reviewerRoleIds: ["review-role"],
    isGuildAdmin: true,
    expectedRevision: 4,
    decision: "approve",
  });
});

for (const decision of ["approve", "reject", "request-changes"] as const) {
  test(`Clan ${decision} review denies a cross-guild component before continuation`, async () => {
    let reviewCalls = 0;
    const service = {
      async reviewRequest() {
        reviewCalls += 1;
        return { id: "clan-1" };
      },
    } as unknown as ClanService;
    const stores = {
      clans: { readRequestById: async () => ({ guildId: "guild-1" }) },
    } as unknown as RuntimeStores;
    const interaction = clanInteraction(`clan:review:request-1:4:${decision}`);
    interaction.guild_id = "guild-2";
    interaction.member!.roles = ["review-role"];
    interaction.member!.permissions = "8";

    const response = await handleClanComponentInteraction(interaction, stores, service);
    assert.match(JSON.stringify(await response.json()), /not available in this server/i);
    assert.equal(reviewCalls, 0);
  });
}

test("Clan review reason modal denies a cross-guild submit before mutation", async () => {
  let reviewCalls = 0;
  const service = {
    async reviewRequest() {
      reviewCalls += 1;
      return { id: "request-1" };
    },
  } as unknown as ClanService;
  const stores = {
    clans: { readRequestById: async () => ({ guildId: "guild-1" }) },
  } as unknown as RuntimeStores;
  const interaction = clanInteraction("clan:review-reason:request-1:4:reject");
  interaction.type = 5;
  interaction.guild_id = "guild-2";
  interaction.member!.permissions = "8";

  const response = await handleClanModalSubmitInteraction(interaction, stores, service);
  assert.match(JSON.stringify(await response.json()), /not available in this server/i);
  assert.equal(reviewCalls, 0);
});

function clanInteraction(customId: string): DiscordInteraction {
  return {
    type: 3,
    guild_id: "guild-1",
    member: { user: { id: "reviewer-1" }, roles: [], permissions: "0" },
    data: { custom_id: customId },
  };
}
