/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createAdminApiHandler } from "./helpers/admin-api";
import type { ImageRulesConfig } from "../src/types";

test("Image Rules admin API enforces premium entitlement and saves config", async () => {
  const writes: unknown[] = [];
  const handler = createAdminApiHandler({
    stores: createStores({ writes, tier: "premium" }),
    discordBotToken: "token",
  });

  const { restore } = mockDiscordResources({
    channels: [
      { id: "channel-1", name: "screenshots", type: 0 },
      { id: "queue-channel-1", name: "mod-queue", type: 0 },
    ],
    roles: [
      { id: "role-1", name: "VIP" },
      { id: "mod-role-1", name: "Moderator" },
    ],
  });

  try {
    const response = await handler(
      new Request("https://example.com/admin/api/image-rules/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          enabled: true,
          topicDescription: "DayZ screenshots",
          autoDeleteThreshold: 0.85,
          modReviewThreshold: 0.65,
          targetChannelIds: ["channel-1"],
          excludedRoleIds: ["role-1"],
          modQueueChannelId: "queue-channel-1",
          modRoleIds: ["mod-role-1"],
          pingOnQueuePost: false,
          reactOnTopic: true,
          auditOnTopic: true,
          dryRun: false,
        }),
      }),
      new URL("https://example.com/admin/api/image-rules/config"),
    );

    assert.equal(response?.status, 200);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], {
      guildId: "guild-1",
      enabled: true,
      topicDescription: "DayZ screenshots",
      autoDeleteThreshold: 0.85,
      modReviewThreshold: 0.65,
      targetChannelIds: ["channel-1"],
      excludedRoleIds: ["role-1"],
      modQueueChannelId: "queue-channel-1",
      modRoleIds: ["mod-role-1"],
      pingOnQueuePost: false,
      reactOnTopic: true,
      auditOnTopic: true,
      dryRun: false,
      createdAtMs: (writes[0] as { createdAtMs: number }).createdAtMs,
      updatedAtMs: (writes[0] as { updatedAtMs: number }).updatedAtMs,
    });
  } finally {
    restore();
  }
});

test("Image Rules admin API reads config for premium guilds", async () => {
  const handler = createAdminApiHandler({
    stores: createStores({
      tier: "premium",
      readConfig: async () => ({
        guildId: "guild-1",
        enabled: true,
        topicDescription: "DayZ screenshots",
        autoDeleteThreshold: 0.85,
        modReviewThreshold: 0.65,
        targetChannelIds: [],
        excludedRoleIds: [],
        modQueueChannelId: null,
        modRoleIds: [],
        pingOnQueuePost: true,
        reactOnTopic: false,
        auditOnTopic: false,
        dryRun: false,
        createdAtMs: 1,
        updatedAtMs: 2,
      }),
    }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/image-rules?guildId=guild-1"),
    new URL("https://example.com/admin/api/image-rules?guildId=guild-1"),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), {
    guildId: "guild-1",
    config: {
      guildId: "guild-1",
      enabled: true,
      topicDescription: "DayZ screenshots",
      autoDeleteThreshold: 0.85,
      modReviewThreshold: 0.65,
      targetChannelIds: [],
      excludedRoleIds: [],
      modQueueChannelId: null,
      modRoleIds: [],
      pingOnQueuePost: true,
      reactOnTopic: false,
      auditOnTopic: false,
      dryRun: false,
      createdAtMs: 1,
      updatedAtMs: 2,
    },
  });
});

test("Image Rules admin API deletes config for premium guilds", async () => {
  const deletes: string[] = [];
  const handler = createAdminApiHandler({
    stores: createStores({ tier: "premium", deletes }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/image-rules/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1" }),
    }),
    new URL("https://example.com/admin/api/image-rules/delete"),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), { ok: true });
  assert.deepEqual(deletes, ["guild-1"]);
});

test("Image Rules admin API blocks free Guilds", async () => {
  const handler = createAdminApiHandler({
    stores: createStores({ tier: "free" }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/image-rules?guildId=guild-1"),
    new URL("https://example.com/admin/api/image-rules?guildId=guild-1"),
  );

  assert.equal(response?.status, 402);
  assert.equal(
    ((await response?.json()) as { error: string } | undefined)?.error,
    "This feature is premium-only.",
  );
});

test("Image Rules admin API saves and reloads full config", async () => {
  const stores = createStores({ tier: "premium" });
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "token",
  });

  const { restore } = mockDiscordResources({
    channels: [
      { id: "channel-1", name: "screenshots", type: 0 },
      { id: "channel-2", name: "memes", type: 0 },
      { id: "queue-channel-1", name: "mod-queue", type: 0 },
    ],
    roles: [
      { id: "role-1", name: "VIP" },
      { id: "mod-role-1", name: "Moderator" },
    ],
  });

  const configPayload = {
    guildId: "guild-1",
    enabled: true,
    topicDescription: "DayZ screenshots",
    autoDeleteThreshold: 0.9,
    modReviewThreshold: 0.75,
    targetChannelIds: ["channel-1", "channel-2"],
    excludedRoleIds: ["role-1"],
    modQueueChannelId: "queue-channel-1",
    modRoleIds: ["mod-role-1"],
    pingOnQueuePost: false,
    reactOnTopic: true,
    auditOnTopic: true,
    dryRun: true,
  };

  try {
    const saveResponse = await handler(
      new Request("https://example.com/admin/api/image-rules/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(configPayload),
      }),
      new URL("https://example.com/admin/api/image-rules/config"),
    );

    assert.equal(saveResponse?.status, 200);
    const saveBody = (await saveResponse?.json()) as { config: ImageRulesConfig };
    assert.equal(saveBody.config.guildId, "guild-1");
    assert.equal(saveBody.config.enabled, true);
    assert.equal(saveBody.config.topicDescription, "DayZ screenshots");
    assert.equal(saveBody.config.autoDeleteThreshold, 0.9);
    assert.equal(saveBody.config.modReviewThreshold, 0.75);
    assert.deepEqual(saveBody.config.targetChannelIds, ["channel-1", "channel-2"]);
    assert.deepEqual(saveBody.config.excludedRoleIds, ["role-1"]);
    assert.equal(saveBody.config.modQueueChannelId, "queue-channel-1");
    assert.deepEqual(saveBody.config.modRoleIds, ["mod-role-1"]);
    assert.equal(saveBody.config.pingOnQueuePost, false);
    assert.equal(saveBody.config.reactOnTopic, true);
    assert.equal(saveBody.config.auditOnTopic, true);
    assert.equal(saveBody.config.dryRun, true);

    const readResponse = await handler(
      new Request("https://example.com/admin/api/image-rules?guildId=guild-1"),
      new URL("https://example.com/admin/api/image-rules?guildId=guild-1"),
    );

    assert.equal(readResponse?.status, 200);
    const readBody = (await readResponse?.json()) as { config: ImageRulesConfig };
    assert.deepEqual(readBody.config, saveBody.config);
  } finally {
    restore();
  }
});

test("Image Rules admin API rejects invalid thresholds", async () => {
  const handler = createAdminApiHandler({
    stores: createStores({ tier: "premium" }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/image-rules/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        enabled: true,
        autoDeleteThreshold: 0.7,
        modReviewThreshold: 0.7,
        targetChannelIds: ["channel-1"],
      }),
    }),
    new URL("https://example.com/admin/api/image-rules/config"),
  );

  assert.equal(response?.status, 400);
  const body = (await response?.json()) as { error: string };
  assert.ok(body.error.includes("modReviewThreshold"));
});

test("Image Rules admin API rejects empty target channels when enabled", async () => {
  const handler = createAdminApiHandler({
    stores: createStores({ tier: "premium" }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/image-rules/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        enabled: true,
        targetChannelIds: [],
      }),
    }),
    new URL("https://example.com/admin/api/image-rules/config"),
  );

  assert.equal(response?.status, 400);
  const body = (await response?.json()) as { error: string };
  assert.ok(body.error.includes("target channel"));
});

test("Image Rules admin API rejects unknown target channels", async () => {
  const handler = createAdminApiHandler({
    stores: createStores({ tier: "premium" }),
    discordBotToken: "token",
  });

  const { restore } = mockDiscordResources({
    channels: [{ id: "channel-1", name: "screenshots", type: 0 }],
    roles: [],
  });

  try {
    const response = await handler(
      new Request("https://example.com/admin/api/image-rules/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          enabled: true,
          targetChannelIds: ["unknown-channel"],
        }),
      }),
      new URL("https://example.com/admin/api/image-rules/config"),
    );

    assert.equal(response?.status, 400);
    const body = (await response?.json()) as { error: string };
    assert.ok(body.error.includes("unknown-channel"));
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
      listDueLfgRenewalReminders: async () => [],
    },
    playerCount: { listPlayerCountServers: async () => [] },
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
