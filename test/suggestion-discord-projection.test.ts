/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createDiscordSuggestionProjection } from "../src/discord/suggestions";
import { GuildResourceValidationError } from "../src/discord/guild-resource-validator";
import { defaultSuggestionsConfig, type Suggestion } from "../src/suggestions";
import {
  createStaticGuildResourceValidator,
  testChannel,
} from "./helpers/guild-resource-validator";

const config = {
  ...defaultSuggestionsConfig("guild-1"),
  forumChannelId: "forum-1",
  digestChannelId: "digest-1",
};

const suggestion: Suggestion = {
  id: "suggestion-1",
  guildId: "guild-1",
  authorId: "author-1",
  title: "Improve onboarding",
  normalizedSearchText: "improve onboarding",
  answers: [],
  category: null,
  status: "gathering_feedback",
  revision: 1,
  threadId: "thread-1",
  starterMessageId: "starter-1",
  projectionError: null,
  supportCount: 0,
  opposeCount: 0,
  outcome: null,
  createdAtMs: 1,
  editedAtMs: null,
  updatedAtMs: 1,
};

test("Suggestion projection rejects foreign submission and digest destinations before Discord", async () => {
  let discordCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    discordCalls += 1;
    throw new Error("Unexpected Discord call");
  };

  try {
    const projection = createDiscordSuggestionProjection({
      token: "bot-token",
      guildResources: createStaticGuildResourceValidator({
        guilds: {
          "guild-1": { channels: [], roles: [] },
          "guild-2": {
            channels: [
              testChannel("forum-1", 15, "guild-2"),
              testChannel("digest-1", 0, "guild-2"),
            ],
            roles: [],
          },
        },
      }),
      readConfig: async () => config,
    });

    await assert.rejects(projection.createSuggestion!(suggestion), GuildResourceValidationError);
    await assert.rejects(
      projection.publishDigest!({
        config,
        periodKey: "2026-07-29",
        newSuggestions: [],
        needingFeedback: [],
        recentlyDecided: [],
      }),
      GuildResourceValidationError,
    );
    assert.equal(discordCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Suggestion projection revalidates persisted threads before update, status, and lock calls", async () => {
  let discordCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    discordCalls += 1;
    throw new Error("Unexpected Discord call");
  };

  try {
    const projection = createDiscordSuggestionProjection({
      token: "bot-token",
      guildResources: createStaticGuildResourceValidator({
        guilds: {
          "guild-1": {
            channels: [testChannel("forum-1", 15, "guild-1")],
            roles: [],
          },
        },
        fetchedChannels: {
          "thread-1": testChannel("thread-1", 11, "guild-2", "forum-1"),
        },
      }),
      readConfig: async () => config,
    });

    await assert.rejects(projection.updateSuggestion!(suggestion), GuildResourceValidationError);
    await assert.rejects(
      projection.postStatusUpdate!(suggestion, "needs_work", null),
      GuildResourceValidationError,
    );
    await assert.rejects(
      projection.setThreadLocked!(suggestion, true),
      GuildResourceValidationError,
    );
    assert.equal(discordCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
