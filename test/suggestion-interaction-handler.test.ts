/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  handleSuggestionComponentInteraction,
  handleSuggestionModalSubmitInteraction,
} from "../src/runtime/suggestion-interaction-handler";
import type { DiscordInteraction } from "../src/runtime/app-types";
import type { SuggestionService } from "../src/services/suggestion-service";

for (const action of ["keep", "restore", "delete"] as const) {
  test(`Suggestion reply ${action} denies a cross-guild component before continuation`, async () => {
    let resolutionCalls = 0;
    const service = {
      async getConsideredReplyTarget() {
        return { id: "reply-1", guildId: "guild-1" };
      },
      async resolveCollapsedReply() {
        resolutionCalls += 1;
      },
    } as unknown as SuggestionService;

    const response = await handleSuggestionComponentInteraction(
      interaction(`suggestions:reply-resolution:${action}:reply-1`),
      service,
    );

    assert.match(JSON.stringify(await response.json()), /not available in this server/i);
    assert.equal(resolutionCalls, 0);
  });
}

test("Suggestion hard-delete denies a cross-guild modal submit before mutation", async () => {
  let resolutionCalls = 0;
  const service = {
    async getConsideredReplyTarget() {
      return { id: "reply-1", guildId: "guild-1" };
    },
    async resolveCollapsedReply() {
      resolutionCalls += 1;
    },
  } as unknown as SuggestionService;

  const response = await handleSuggestionModalSubmitInteraction(
    interaction("suggestions:reply-delete-submit:reply-1", 5),
    service,
  );

  assert.match(JSON.stringify(await response.json()), /not available in this server/i);
  assert.equal(resolutionCalls, 0);
});

function interaction(customId: string, type = 3): DiscordInteraction {
  return {
    type,
    guild_id: "guild-2",
    member: {
      permissions: "8",
      roles: ["mod-role"],
      user: { id: "admin-2" },
    },
    data: { custom_id: customId, components: [] },
  } as DiscordInteraction;
}
