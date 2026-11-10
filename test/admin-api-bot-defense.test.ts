/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createAdminApiHandler } from "./helpers/admin-api";
import type { BotDefenseConfig } from "../src/types";
import { createTestConfigurationRevisionCoordinator } from "./support/configuration-revision-store";

test("Bot Defense admin API enforces premium entitlement and saves config", async () => {
  const writes: unknown[] = [];
  const handler = createAdminApiHandler({
    stores: createStores({ writes, tier: "premium" }),
    discordBotToken: "token",
  });

  const { restore } = mockDiscordResources({
    channels: [
      { id: "channel-1", name: "honeypot", type: 0 },
      { id: "queue-channel-1", name: "mod-queue", type: 0 },
    ],
    roles: [
      { id: "role-1", name: "VIP" },
      { id: "mod-role-1", name: "Moderator" },
    ],
  });

  try {
    const response = await handler(
      new Request("https://example.com/admin/api/bot-defense/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          honeypotEnabled: true,
          honeypotWarnUser: true,
          honeypotDeleteMessage: false,
          rateEnabled: true,
          rateWarnUser: false,
          rateDeleteMessage: true,
          honeypotChannelIds: ["channel-1"],
          rateChannelThreshold: 10,
          rateWindowSeconds: 120,
          excludedRoleIds: ["role-1"],
          modRoleIds: ["mod-role-1"],
          modQueueChannelId: "queue-channel-1",
          pingOnQueuePost: false,
        }),
      }),
      new URL("https://example.com/admin/api/bot-defense/config"),
    );

    assert.equal(response?.status, 200);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], {
      guildId: "guild-1",
      honeypotEnabled: true,
      honeypotWarnUser: true,
      honeypotDeleteMessage: false,
      rateEnabled: true,
      rateWarnUser: false,
      rateDeleteMessage: true,
      honeypotChannelIds: ["channel-1"],
      rateChannelThreshold: 10,
      rateWindowSeconds: 120,
      excludedRoleIds: ["role-1"],
      modRoleIds: ["mod-role-1"],
      modQueueChannelId: "queue-channel-1",
      pingOnQueuePost: false,
      createdAtMs: (writes[0] as { createdAtMs: number }).createdAtMs,
      updatedAtMs: (writes[0] as { updatedAtMs: number }).updatedAtMs,
    });
  } finally {
    restore();
  }
});

test("Bot Defense admin API reads config for premium guilds", async () => {
  const handler = createAdminApiHandler({
    stores: createStores({
      tier: "premium",
      readConfig: async () => ({
        guildId: "guild-1",
        honeypotEnabled: true,
        rateEnabled: false,
        honeypotChannelIds: ["channel-1"],
        rateChannelThreshold: 5,
        rateWindowSeconds: 60,
        excludedRoleIds: ["role-1"],
        modRoleIds: ["mod-role-1"],
        modQueueChannelId: "queue-channel-1",
        pingOnQueuePost: true,
        createdAtMs: 1,
        updatedAtMs: 2,
      }),
    }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/bot-defense?guildId=guild-1"),
    new URL("https://example.com/admin/api/bot-defense?guildId=guild-1"),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), {
    guildId: "guild-1",
    config: {
      guildId: "guild-1",
      honeypotEnabled: true,
      rateEnabled: false,
      honeypotChannelIds: ["channel-1"],
      rateChannelThreshold: 5,
      rateWindowSeconds: 60,
      excludedRoleIds: ["role-1"],
      modRoleIds: ["mod-role-1"],
      modQueueChannelId: "queue-channel-1",
      pingOnQueuePost: true,
      createdAtMs: 1,
      updatedAtMs: 2,
    },
  });
});

test("Bot Defense admin API deletes config for premium guilds", async () => {
  const deletes: string[] = [];
  const handler = createAdminApiHandler({
    stores: createStores({
      tier: "premium",
      deletes,
      readConfig: async () => ({ guildId: "guild-1" }),
    }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/bot-defense/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1" }),
    }),
    new URL("https://example.com/admin/api/bot-defense/delete"),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), { ok: true });
  assert.deepEqual(deletes, ["guild-1"]);
});

test("Bot Defense admin API reads retained configuration for Free Guilds", async () => {
  const handler = createAdminApiHandler({
    stores: createStores({ tier: "free" }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/bot-defense?guildId=guild-1"),
    new URL("https://example.com/admin/api/bot-defense?guildId=guild-1"),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), { guildId: "guild-1", config: null });
});

test("Bot Defense admin API lets Free Guilds configure Honeypot but not Rate Detector", async () => {
  const writes: unknown[] = [];
  const handler = createAdminApiHandler({
    stores: createStores({ tier: "free", writes }),
    discordBotToken: "token",
  });
  const { restore } = mockDiscordResources({
    channels: [
      { id: "channel-1", name: "honeypot", type: 0 },
      { id: "queue-channel-1", name: "mod-queue", type: 0 },
    ],
    roles: [{ id: "mod-role-1", name: "Moderator" }],
  });
  const body = {
    guildId: "guild-1",
    honeypotEnabled: true,
    honeypotWarnUser: true,
    honeypotDeleteMessage: true,
    rateEnabled: false,
    rateWarnUser: false,
    rateDeleteMessage: false,
    honeypotChannelIds: ["channel-1"],
    rateChannelThreshold: 5,
    rateWindowSeconds: 60,
    excludedRoleIds: [],
    modRoleIds: ["mod-role-1"],
    modQueueChannelId: "queue-channel-1",
    pingOnQueuePost: true,
  };
  try {
    const allowed = await handler(
      new Request("https://example.com/admin/api/bot-defense/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      new URL("https://example.com/admin/api/bot-defense/config"),
    );
    assert.equal(allowed?.status, 200);
    assert.equal(writes.length, 1);

    const blocked = await handler(
      new Request("https://example.com/admin/api/bot-defense/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, rateEnabled: true }),
      }),
      new URL("https://example.com/admin/api/bot-defense/config"),
    );
    assert.equal(blocked?.status, 402);
    assert.equal(
      ((await blocked?.json()) as { error: string } | undefined)?.error,
      "Rate Detector requires a paid plan.",
    );
  } finally {
    restore();
  }
});

test("Bot Defense admin API rejects an unusually broad honeypot scope", async () => {
  const writes: unknown[] = [];
  const handler = createAdminApiHandler({
    stores: createStores({ tier: "premium", writes }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/bot-defense/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        honeypotEnabled: true,
        honeypotWarnUser: false,
        honeypotDeleteMessage: true,
        rateEnabled: false,
        honeypotChannelIds: Array.from({ length: 11 }, (_, index) => `channel-${index + 1}`),
      }),
    }),
    new URL("https://example.com/admin/api/bot-defense/config"),
  );

  assert.equal(response?.status, 400);
  assert.equal(writes.length, 0);
  assert.match(JSON.stringify(await response?.json()), /no more than 10 honeypot channels/i);
});

test("Bot Defense admin API creates and returns a safe honeypot channel", async () => {
  const handler = createAdminApiHandler({
    stores: createStores({ tier: "free" }),
    discordBotToken: "token",
    discordBotUserId: "bot-1",
  });
  const calls: Array<{ method: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/guilds/guild-1/channels") && method === "GET") {
      return Response.json([]);
    }
    if (url.endsWith("/guilds/guild-1/roles")) {
      return Response.json([
        { id: "guild-1", name: "@everyone", permissions: "0", position: 0 },
        { id: "trusted-1", name: "Verified", permissions: "0", position: 1 },
      ]);
    }
    if (url.endsWith("/guilds/guild-1/channels") && method === "POST") {
      calls.push({ method, body: JSON.parse(String(init?.body)) });
      return Response.json({ id: "honeypot-1", name: "do-not-post", type: 0 });
    }
    return new Response("unexpected request", { status: 500 });
  };

  try {
    const response = await handler(
      new Request("https://example.com/admin/api/bot-defense/honeypot-channel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1", excludedRoleIds: ["trusted-1"] }),
      }),
      new URL("https://example.com/admin/api/bot-defense/honeypot-channel"),
    );

    assert.equal(response?.status, 200);
    assert.deepEqual(await response?.json(), {
      channel: { id: "honeypot-1", name: "do-not-post" },
      created: true,
    });
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bot Defense admin API saves and reloads full config", async () => {
  const stores = createStores({ tier: "premium" });
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "token",
  });

  const { restore } = mockDiscordResources({
    channels: [
      { id: "channel-1", name: "honeypot", type: 0 },
      { id: "channel-2", name: "honeypot-2", type: 0 },
      { id: "queue-channel-1", name: "mod-queue", type: 0 },
    ],
    roles: [
      { id: "role-1", name: "VIP" },
      { id: "mod-role-1", name: "Moderator" },
    ],
  });

  const configPayload = {
    guildId: "guild-1",
    honeypotEnabled: true,
    honeypotWarnUser: true,
    honeypotDeleteMessage: true,
    rateEnabled: true,
    rateWarnUser: false,
    rateDeleteMessage: true,
    honeypotChannelIds: ["channel-1", "channel-2"],
    rateChannelThreshold: 7,
    rateWindowSeconds: 90,
    excludedRoleIds: ["role-1"],
    modRoleIds: ["mod-role-1"],
    modQueueChannelId: "queue-channel-1",
    pingOnQueuePost: false,
  };

  try {
    const saveResponse = await handler(
      new Request("https://example.com/admin/api/bot-defense/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(configPayload),
      }),
      new URL("https://example.com/admin/api/bot-defense/config"),
    );

    assert.equal(saveResponse?.status, 200);
    const saveBody = (await saveResponse?.json()) as { config: BotDefenseConfig };
    assert.equal(saveBody.config.guildId, "guild-1");
    assert.equal(saveBody.config.honeypotEnabled, true);
    assert.equal(saveBody.config.honeypotWarnUser, true);
    assert.equal(saveBody.config.honeypotDeleteMessage, true);
    assert.equal(saveBody.config.rateEnabled, true);
    assert.equal(saveBody.config.rateWarnUser, false);
    assert.equal(saveBody.config.rateDeleteMessage, true);
    assert.deepEqual(saveBody.config.honeypotChannelIds, ["channel-1", "channel-2"]);
    assert.equal(saveBody.config.rateChannelThreshold, 7);
    assert.equal(saveBody.config.rateWindowSeconds, 90);
    assert.deepEqual(saveBody.config.excludedRoleIds, ["role-1"]);
    assert.deepEqual(saveBody.config.modRoleIds, ["mod-role-1"]);
    assert.equal(saveBody.config.modQueueChannelId, "queue-channel-1");
    assert.equal(saveBody.config.pingOnQueuePost, false);

    const readResponse = await handler(
      new Request("https://example.com/admin/api/bot-defense?guildId=guild-1"),
      new URL("https://example.com/admin/api/bot-defense?guildId=guild-1"),
    );

    assert.equal(readResponse?.status, 200);
    const readBody = (await readResponse?.json()) as { config: BotDefenseConfig };
    assert.deepEqual(readBody.config, saveBody.config);
  } finally {
    restore();
  }
});

function mockDiscordResources({
  channels,
  roles,
}: {
  channels: Array<{ id: string; name: string; type: number }>;
  roles: Array<{ id: string; name: string }>;
}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://discord.com/api/v10/guilds/guild-1/channels") {
      return Response.json(channels);
    }
    if (url === "https://discord.com/api/v10/guilds/guild-1/roles") {
      return Response.json(roles);
    }
    return originalFetch(input, init);
  };

  return {
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function createStores(
  options: {
    tier: "free" | "premium";
    writes?: unknown[];
    deletes?: string[];
    readConfig?: () => Promise<unknown>;
  } = { tier: "free" },
) {
  let storedConfig: unknown = null;
  return {
    configurationRevisions: createTestConfigurationRevisionCoordinator((mutation) => {
      storedConfig = mutation.next;
      if (mutation.next) options.writes?.push(mutation.next);
      else if (mutation.current && "guildId" in mutation.current) {
        options.deletes?.push(mutation.current.guildId);
      }
    }),
    blocklist: { readConfig: async () => ({ botUserId: "bot-1", guilds: {} }) },
    timedRoles: { listTimedRolesByGuild: async () => [] },
    tickets: { readTicketPanelConfig: async () => null },
    marketplace: {
      readMarketplaceConfig: async () => null,
      listMarketplacePosts: async () => [],
      listMarketplaceLogs: async () => [],
    },
    lfg: {
      readLfgConfig: async () => null,
      listLfgPosts: async () => [],
      countActiveLfgPosts: async () => 0,
      updateLfgPost: async () => {},
      listDueLfgPostExpiries: async () => [],
      listDueLfgPostRenewalReminders: async () => [],
    },
    playerCount: { listPlayerCountServers: async () => [] },
    steamLink: { readSteamLinkConfig: async () => null },
    appConfig: {},
    guildRbac: {},
    webhookProxy: {},
    guildEntitlements: {
      readGuildEntitlement: async (guildId: string) => ({
        guildId,
        tier: options.tier,
        updatedAtMs: 0,
      }),
    },
    guildR2Objects: { getGuildUsageBytes: async () => 0 },
    premiumClaims: {},
    reactionLimits: {},
    evidenceVault: {
      readConfig: async () => null,
      upsertConfig: async () => {},
    },
    imageRules: {
      readConfig: async () => null,
      upsertConfig: async () => {},
      deleteConfig: async () => {},
    },
    botDefense: {
      readConfig:
        options.readConfig ??
        (async () => {
          return storedConfig;
        }),
      upsertConfig: async (config: unknown) => {
        storedConfig = config;
        options.writes?.push(config);
      },
      deleteConfig: async (guildId: string) => {
        options.deletes?.push(guildId);
      },
      openBotFlag: async () => null,
      resolveBotFlag: async () => null,
      readOpenBotFlag: async () => null,
      isConfirmedMember: async () => false,
      setBotFlagQueueMessage: async () => {},
      recordRateMessage: async () => {},
      listMatchingMessageChannelsInWindow: async () => [],
    },
    userPreferences: {
      readUserPreferences: async () => null,
      upsertUserPreferences: async () => {},
    },
    guildAuditLog: {
      readConfig: async () => null,
      upsertConfig: async () => {},
    },
  } as never;
}
