/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { createGuildBrandingResolver } from "../src/runtime/guild-branding";
import type { WhiteLabelBot } from "../src/types";

function createFakeStore(records: Record<string, WhiteLabelBot | null>) {
  return {
    async readWhiteLabelBot(guildId: string) {
      return records[guildId] ?? null;
    },
  };
}

function activeBot(overrides: Partial<WhiteLabelBot> = {}): WhiteLabelBot {
  return {
    guildId: "guild-1",
    applicationId: "app-1",
    botUserId: "bot-1",
    displayName: "Custom Bot",
    brandFooterText: "custom-bot.example",
    status: "active",
    tokenSecretRef: "secrets-store:store-1:SECRET",
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

test("createGuildBrandingResolver falls back to HAF branding for standard guilds", async () => {
  const resolver = createGuildBrandingResolver(createFakeStore({}));

  assert.equal(await resolver.resolveFooterText("guild-1"), "hafbot.xyz");
  assert.equal(await resolver.resolveBotDisplayName("guild-1"), "HAF Bot");
});

test("createGuildBrandingResolver falls back when guildId is undefined", async () => {
  const resolver = createGuildBrandingResolver(createFakeStore({}));

  assert.equal(await resolver.resolveFooterText(undefined), "hafbot.xyz");
  assert.equal(await resolver.resolveBotDisplayName(undefined), "HAF Bot");
});

test("createGuildBrandingResolver falls back when store is undefined", async () => {
  const resolver = createGuildBrandingResolver(undefined);

  assert.equal(await resolver.resolveFooterText("guild-1"), "hafbot.xyz");
  assert.equal(await resolver.resolveBotDisplayName("guild-1"), "HAF Bot");
});

test("createGuildBrandingResolver ignores non-active white-label bots", async () => {
  const resolver = createGuildBrandingResolver(
    createFakeStore({
      "guild-1": activeBot({ status: "pending_install" }),
    }),
  );

  assert.equal(await resolver.resolveFooterText("guild-1"), "hafbot.xyz");
  assert.equal(await resolver.resolveBotDisplayName("guild-1"), "HAF Bot");
});

test("createGuildBrandingResolver uses active white-label bot branding", async () => {
  const resolver = createGuildBrandingResolver(
    createFakeStore({
      "guild-1": activeBot(),
    }),
  );

  assert.equal(await resolver.resolveFooterText("guild-1"), "custom-bot.example");
  assert.equal(await resolver.resolveBotDisplayName("guild-1"), "Custom Bot");
});

test("createGuildBrandingResolver falls back to hafbot.xyz when brandFooterText is null", async () => {
  const resolver = createGuildBrandingResolver(
    createFakeStore({
      "guild-1": activeBot({ brandFooterText: null }),
    }),
  );

  assert.equal(await resolver.resolveFooterText("guild-1"), "hafbot.xyz");
  assert.equal(await resolver.resolveBotDisplayName("guild-1"), "Custom Bot");
});
