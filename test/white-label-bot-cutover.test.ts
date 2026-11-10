/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import type { WhiteLabelBotStore } from "../src/runtime/contracts";
import { afterStoreSeed, createProductionRuntimeStores } from "./support/production-runtime-stores";
import { verifyWhiteLabelBotCutover } from "../src/runtime/white-label-bot-cutover";
import type { WhiteLabelBot } from "../src/types";

test("verifyWhiteLabelBotCutover marks the expected installed White-Label Bot active", async () => {
  const whiteLabelBots = createWhiteLabelBotStore([whiteLabelBot({ status: "pending_install" })]);

  const result = await verifyWhiteLabelBotCutover({
    guildId: "guild-1",
    whiteLabelBots,
    resolveToken: async () => "white-label-token",
    readBotUserId: async () => "bot-user-1",
    listBotGuilds: async () => [{ guildId: "guild-1", name: "Guild One", icon: null }],
    now: () => 500,
  });

  assert.equal(result.status, "active");
  assert.deepEqual(await whiteLabelBots.readWhiteLabelBot("guild-1"), {
    ...whiteLabelBot({ status: "active" }),
    updatedAtMs: 500,
  });
});

test("verifyWhiteLabelBotCutover rejects the wrong bot or wrong Guild", async () => {
  const wrongBotStore = createWhiteLabelBotStore([whiteLabelBot({ status: "pending_install" })]);
  await assert.rejects(
    verifyWhiteLabelBotCutover({
      guildId: "guild-1",
      whiteLabelBots: wrongBotStore,
      resolveToken: async () => "white-label-token",
      readBotUserId: async () => "other-bot-user",
      listBotGuilds: async () => [{ guildId: "guild-1", name: "Guild One", icon: null }],
    }),
    /expected White-Label Bot/i,
  );

  const wrongGuildStore = createWhiteLabelBotStore([whiteLabelBot({ status: "pending_install" })]);
  await assert.rejects(
    verifyWhiteLabelBotCutover({
      guildId: "guild-1",
      whiteLabelBots: wrongGuildStore,
      resolveToken: async () => "white-label-token",
      readBotUserId: async () => "bot-user-1",
      listBotGuilds: async () => [{ guildId: "guild-2", name: "Other Guild", icon: null }],
    }),
    /expected Guild/i,
  );
});

test("verifyWhiteLabelBotCutover prevents duplicate active White-Label Bot cutover", async () => {
  const whiteLabelBots = createWhiteLabelBotStore([whiteLabelBot({ status: "active" })]);

  await assert.rejects(
    verifyWhiteLabelBotCutover({
      guildId: "guild-1",
      whiteLabelBots,
      resolveToken: async () => "white-label-token",
      readBotUserId: async () => "bot-user-1",
      listBotGuilds: async () => [{ guildId: "guild-1", name: "Guild One", icon: null }],
    }),
    /already active/i,
  );
});

test("verifyWhiteLabelBotCutover prevents activating a replacement while another bot is active", async () => {
  const whiteLabelBots = createWhiteLabelBotStore([
    whiteLabelBot({ applicationId: "app-old", botUserId: "bot-old", status: "active" }),
    whiteLabelBot({ applicationId: "app-new", botUserId: "bot-user-1", status: "pending_install" }),
  ]);

  await assert.rejects(
    verifyWhiteLabelBotCutover({
      guildId: "guild-1",
      whiteLabelBots,
      resolveToken: async () => "white-label-token",
      readBotUserId: async () => "bot-user-1",
      listBotGuilds: async () => [{ guildId: "guild-1", name: "Guild One", icon: null }],
    }),
    /already active/i,
  );
});

function whiteLabelBot(overrides: Partial<WhiteLabelBot> = {}): WhiteLabelBot {
  return {
    guildId: "guild-1",
    applicationId: "app-1",
    botUserId: "bot-user-1",
    displayName: "Guild Helper",
    brandFooterText: null,
    status: "pending_install",
    tokenSecretRef: "WHITE_LABEL_BOT_GUILD_1_TOKEN",
    createdAtMs: 100,
    updatedAtMs: 100,
    ...overrides,
  };
}

function createWhiteLabelBotStore(records: WhiteLabelBot[]): WhiteLabelBotStore {
  const fixture = createProductionRuntimeStores();
  const store = fixture.stores.whiteLabelBots;
  return afterStoreSeed(
    store,
    Promise.all(records.map((record) => store.upsertWhiteLabelBot(record))),
  );
}
