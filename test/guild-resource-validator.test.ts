/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { GuildResourceValidationError } from "../src/discord/guild-resource-validator";
import {
  createStaticGuildResourceValidator,
  testChannel,
  testRole,
} from "./helpers/guild-resource-validator";

const guildAResources = {
  channels: [
    testChannel("text-a", 0, "guild-a"),
    testChannel("announcement-a", 5, "guild-a"),
    testChannel("voice-a", 2, "guild-a"),
    testChannel("forum-a", 15, "guild-a"),
    testChannel("category-a", 4, "guild-a"),
  ],
  roles: [testRole("role-a")],
};

const guildBResources = {
  channels: [testChannel("text-b", 0, "guild-b")],
  roles: [testRole("role-b")],
};

test("GuildResourceValidator accepts resources owned by the expected Guild", async () => {
  const validator = createStaticGuildResourceValidator({
    guilds: { "guild-a": guildAResources, "guild-b": guildBResources },
  });

  assert.equal((await validator.requireTextChannel("guild-a", "text-a")).id, "text-a");
  assert.equal((await validator.requireRole("guild-a", "role-a")).id, "role-a");
});

test("GuildResourceValidator rejects a valid resource owned by another Guild", async () => {
  const validator = createStaticGuildResourceValidator({
    guilds: { "guild-a": guildAResources, "guild-b": guildBResources },
  });

  await assert.rejects(
    validator.requireTextChannel("guild-a", "text-b"),
    GuildResourceValidationError,
  );
  await assert.rejects(validator.requireRole("guild-a", "role-b"), GuildResourceValidationError);
});

test("GuildResourceValidator enforces text, voice, forum and category channel types", async () => {
  const validator = createStaticGuildResourceValidator({ guilds: { "guild-a": guildAResources } });

  assert.equal((await validator.requireTextChannel("guild-a", "text-a")).id, "text-a");
  assert.equal(
    (await validator.requireTextChannel("guild-a", "announcement-a")).id,
    "announcement-a",
  );
  assert.equal((await validator.requireVoiceChannel("guild-a", "voice-a")).id, "voice-a");
  assert.equal((await validator.requireForumChannel("guild-a", "forum-a")).id, "forum-a");
  assert.equal((await validator.requireCategory("guild-a", "category-a")).id, "category-a");

  await assert.rejects(
    validator.requireTextChannel("guild-a", "voice-a"),
    GuildResourceValidationError,
  );
  await assert.rejects(
    validator.requireVoiceChannel("guild-a", "text-a"),
    GuildResourceValidationError,
  );
  await assert.rejects(
    validator.requireForumChannel("guild-a", "category-a"),
    GuildResourceValidationError,
  );
  await assert.rejects(
    validator.requireCategory("guild-a", "forum-a"),
    GuildResourceValidationError,
  );
});

test("GuildResourceValidator validates thread Guild ownership and parent ownership", async () => {
  const validator = createStaticGuildResourceValidator({
    guilds: { "guild-a": guildAResources },
    fetchedChannels: {
      "thread-a": testChannel("thread-a", 11, "guild-a", "text-a"),
      "thread-b": testChannel("thread-b", 11, "guild-b", "text-a"),
      "thread-foreign-parent": testChannel("thread-foreign-parent", 11, "guild-a", "text-b"),
    },
  });

  assert.equal((await validator.requireThread("guild-a", "thread-a", "text-a")).id, "thread-a");
  await assert.rejects(
    validator.requireThread("guild-a", "thread-b", "text-a"),
    GuildResourceValidationError,
  );
  await assert.rejects(
    validator.requireThread("guild-a", "thread-foreign-parent"),
    GuildResourceValidationError,
  );
  await assert.rejects(
    validator.requireThread("guild-a", "thread-a", "announcement-a"),
    GuildResourceValidationError,
  );
});

test("GuildResourceValidator rejects threads whose parent is not message-capable", async () => {
  const validator = createStaticGuildResourceValidator({
    guilds: { "guild-a": guildAResources },
    fetchedChannels: {
      "thread-category-parent": testChannel("thread-category-parent", 11, "guild-a", "category-a"),
    },
  });

  await assert.rejects(
    validator.requireThread("guild-a", "thread-category-parent"),
    GuildResourceValidationError,
  );
});

test("GuildResourceValidator errors do not disclose foreign Guild metadata", async () => {
  const validator = createStaticGuildResourceValidator({
    guilds: { "guild-a": guildAResources, "guild-b": guildBResources },
  });

  const error = await validator.requireTextChannel("guild-a", "text-b").catch((caught) => caught);
  assert.ok(error instanceof GuildResourceValidationError);
  assert.equal(error.message, "Invalid Discord resource.");
  assert.equal(error.message.includes("guild-b"), false);
  assert.equal(error.message.includes("text-b"), false);
});
