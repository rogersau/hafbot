/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createServerLevelsAdminRoutes } from "../src/runtime/admin-routes/server-levels";
import { ServerLevelProcessor } from "../src/server-levels/processor";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";
import {
  createStaticGuildResourceValidator,
  testChannel,
} from "./helpers/guild-resource-validator";

test("Server Levels rejects an announcement channel outside the target Guild", async () => {
  const fixture = createProductionRuntimeStores();
  try {
    const routes = createServerLevelsAdminRoutes({
      stores: fixture.stores,
      discordBotToken: "bot-token",
      guildResources: createStaticGuildResourceValidator({
        guilds: {
          "guild-1": {
            channels: [testChannel("channel-1", 0, "guild-1")],
            roles: [],
          },
        },
      }),
    });
    const route = routes.find(
      (entry) => entry.method === "POST" && entry.path === "/admin/api/server-levels/config",
    );
    assert.ok(route);
    const request = new Request("https://admin.example/admin/api/server-levels/config", {
      method: "POST",
    });

    await assert.rejects(
      async () =>
        route.handler({
          request,
          url: new URL(request.url),
          params: {},
          query: undefined,
          body: {
            guildId: "guild-1",
            enabled: true,
            announcementChannelId: "channel-in-another-guild",
          },
        }),
      { name: "GuildResourceValidationError" },
    );
    assert.equal(await fixture.stores.serverLevels!.readConfig("guild-1"), null);
  } finally {
    fixture.close();
  }
});

test("Server Levels rejects an announcement channel where the bot cannot send", async () => {
  const fixture = createProductionRuntimeStores();
  try {
    const routes = createServerLevelsAdminRoutes({
      stores: fixture.stores,
      discordBotToken: "bot-token",
      discordBotUserId: "bot-user",
      guildResources: createStaticGuildResourceValidator({
        guilds: {
          "guild-1": {
            channels: [testChannel("channel-1", 0, "guild-1")],
            roles: [],
          },
        },
      }),
      loadPermissionContext: async () => ({
        guildId: "guild-1",
        botUserId: "bot-user",
        channels: [testChannel("channel-1", 0, "guild-1")],
        roles: [
          {
            id: "guild-1",
            name: "@everyone",
            permissions: String(1n << 10n),
            position: 0,
          },
        ],
        member: { user: { id: "bot-user" }, roles: [] },
      }),
    });
    const route = routes.find(
      (entry) => entry.method === "POST" && entry.path === "/admin/api/server-levels/config",
    );
    assert.ok(route);
    const request = new Request("https://admin.example/admin/api/server-levels/config", {
      method: "POST",
    });

    const response = await route.handler({
      request,
      url: new URL(request.url),
      params: {},
      query: undefined,
      body: {
        guildId: "guild-1",
        enabled: true,
        announcementChannelId: "channel-1",
      },
    });

    assert.equal(response.status, 409);
    assert.equal(await fixture.stores.serverLevels!.readConfig("guild-1"), null);
  } finally {
    fixture.close();
  }
});

test("Configured servers start with unverified subscriptions and require explicit confirmation", async () => {
  const fixture = createProductionRuntimeStores();
  try {
    await fixture.stores.serverLevels!.createConfiguredGameServer({
      id: "server-1",
      guildId: "guild-1",
      displayName: "DayZ",
      providerServerId: "cftools-1",
      maxSlots: 60,
      endpointId: "endpoint-1",
      webhookCredentialId: "credential-1",
      webhookVerifiedAtMs: null,
      subscribedEvents: [],
      capacityProposal: null,
      lastRosterReconciledAtMs: null,
      lastCapacityCheckedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const routes = createServerLevelsAdminRoutes({
      stores: fixture.stores,
      discordBotToken: "bot-token",
      guildResources: createStaticGuildResourceValidator({ guilds: {} }),
    });
    const route = routes.find(
      (entry) =>
        entry.method === "POST" &&
        entry.path === "/admin/api/server-levels/servers/:serverId/subscriptions",
    );
    assert.ok(route);
    const request = new Request("https://admin.example/admin/api/server-levels/subscriptions", {
      method: "POST",
    });

    const response = await route.handler({
      request,
      url: new URL(request.url),
      params: { serverId: "server-1" },
      query: undefined,
      body: { guildId: "guild-1", confirmation: "SUBSCRIPTIONS_CONFIGURED" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(
      (await fixture.stores.serverLevels!.readConfiguredGameServer("guild-1", "server-1"))
        ?.subscribedEvents,
      ["user.join", "user.leave", "server.restart", "server.shutdown"],
    );
  } finally {
    fixture.close();
  }
});

test("disabling Server Levels checkpoints active sessions before saving the disabled config", async () => {
  const fixture = createProductionRuntimeStores();
  const store = fixture.stores.serverLevels!;
  const disabledAtMs = 61_000;
  try {
    await store.upsertConfig({
      guildId: "guild-1",
      enabled: true,
      announcementChannelId: null,
      removedAtMs: null,
      updatedAtMs: 1,
    });
    await store.createConfiguredGameServer({
      id: "server-1",
      guildId: "guild-1",
      displayName: "DayZ",
      providerServerId: "cftools-1",
      maxSlots: 4,
      endpointId: "endpoint-1",
      webhookCredentialId: "credential-1",
      webhookVerifiedAtMs: 1,
      subscribedEvents: ["user.join", "user.leave", "server.restart", "server.shutdown"],
      capacityProposal: null,
      lastRosterReconciledAtMs: null,
      lastCapacityCheckedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await fixture.stores.platformLink.upsertPlatformLink({
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 0,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    });
    await store.upsertProcessingCursor({
      configuredGameServerId: "server-1",
      latestSeenAtMs: 1_000,
      watermarkAtMs: 1_000,
      lastDeliveryId: "join",
      population: 1,
      queueSize: 0,
      lifecycleGeneration: 0,
      updatedAtMs: 1_000,
    });
    await store.upsertCurrentPresence({
      configuredGameServerId: "server-1",
      steamId64: "76561198000000001",
      lifecycleGeneration: 0,
      joinedAtMs: 1_000,
      lastConfirmedAtMs: 1_000,
      updatedAtMs: 1_000,
    });
    await store.upsertEarningSession({
      sessionId: "session-1",
      guildId: "guild-1",
      configuredGameServerId: "server-1",
      steamId64: "76561198000000001",
      userId: "user-1",
      lifecycleGeneration: 0,
      startedAtMs: 1_000,
      lastConfirmedAtMs: 1_000,
      checkpointAtMs: 1_000,
      closedAtMs: null,
      closeReason: null,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    });
    const processor = new ServerLevelProcessor({
      store,
      platformLinks: fixture.stores.platformLink,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => true,
      now: () => disabledAtMs,
      createId: () => "lease-1",
    });
    const routes = createServerLevelsAdminRoutes({
      stores: fixture.stores,
      processor,
      now: () => disabledAtMs,
      discordBotToken: "bot-token",
      guildResources: createStaticGuildResourceValidator({ guilds: {} }),
    });
    const route = routes.find(
      (entry) => entry.method === "POST" && entry.path === "/admin/api/server-levels/config",
    );
    assert.ok(route);
    const request = new Request("https://admin.example/admin/api/server-levels/config", {
      method: "POST",
    });

    const response = await route.handler({
      request,
      url: new URL(request.url),
      params: {},
      query: undefined,
      body: { guildId: "guild-1", enabled: false },
    });

    assert.equal(response.status, 200);
    assert.equal((await store.readConfig("guild-1"))?.enabled, false);
    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
    assert.deepEqual(await store.listOpenEarningSessions("server-1"), []);
    assert.deepEqual(await store.listCurrentPresence("server-1"), []);
  } finally {
    fixture.close();
  }
});

test("changing the provider server checkpoints and clears the old attendance state", async () => {
  const fixture = createProductionRuntimeStores();
  const store = fixture.stores.serverLevels!;
  const changedAtMs = 61_000;
  try {
    await store.upsertConfig({
      guildId: "guild-1",
      enabled: true,
      announcementChannelId: null,
      removedAtMs: null,
      updatedAtMs: 1,
    });
    await store.createConfiguredGameServer({
      id: "server-1",
      guildId: "guild-1",
      displayName: "Old DayZ",
      providerServerId: "cftools-old",
      maxSlots: 4,
      endpointId: "endpoint-1",
      webhookCredentialId: "credential-1",
      webhookVerifiedAtMs: 1,
      subscribedEvents: ["user.join", "user.leave", "server.restart", "server.shutdown"],
      capacityProposal: { maxSlots: 6, observedAtMs: 1 },
      lastRosterReconciledAtMs: 1,
      lastCapacityCheckedAtMs: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await fixture.stores.platformLink.upsertPlatformLink({
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "76561198000000001",
      linkedAtMs: 0,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    });
    await store.upsertProcessingCursor({
      configuredGameServerId: "server-1",
      latestSeenAtMs: 1_000,
      watermarkAtMs: 1_000,
      lastDeliveryId: "join",
      population: 1,
      queueSize: 0,
      lifecycleGeneration: 0,
      updatedAtMs: 1_000,
    });
    await store.upsertCurrentPresence({
      configuredGameServerId: "server-1",
      steamId64: "76561198000000001",
      lifecycleGeneration: 0,
      joinedAtMs: 1_000,
      lastConfirmedAtMs: 1_000,
      updatedAtMs: 1_000,
    });
    await store.upsertEarningSession({
      sessionId: "session-1",
      guildId: "guild-1",
      configuredGameServerId: "server-1",
      steamId64: "76561198000000001",
      userId: "user-1",
      lifecycleGeneration: 0,
      startedAtMs: 1_000,
      lastConfirmedAtMs: 1_000,
      checkpointAtMs: 1_000,
      closedAtMs: null,
      closeReason: null,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    });
    await store.acceptProviderEvent({
      inboxId: "pending-old-provider-event",
      deliveryId: "pending-old-provider-delivery",
      configuredGameServerId: "server-1",
      guildId: "guild-1",
      eventType: "player.join",
      occurredAtMs: 50_000,
      steamId64: "76561198000000002",
      population: 2,
      queueSize: 0,
      receivedAtMs: 50_001,
    });
    const processor = new ServerLevelProcessor({
      store,
      platformLinks: fixture.stores.platformLink,
      readEntitlementTier: async () => "premium",
      isCurrentGuildMember: async () => true,
      now: () => changedAtMs,
      createId: () => "lease-1",
    });
    const routes = createServerLevelsAdminRoutes({
      stores: fixture.stores,
      processor,
      now: () => changedAtMs,
      discordBotToken: "bot-token",
      guildResources: createStaticGuildResourceValidator({ guilds: {} }),
    });
    const route = routes.find(
      (entry) =>
        entry.method === "PATCH" && entry.path === "/admin/api/server-levels/servers/:serverId",
    );
    assert.ok(route);
    const request = new Request("https://admin.example/admin/api/server-levels/servers/server-1", {
      method: "PATCH",
    });

    const response = await route.handler({
      request,
      url: new URL(request.url),
      params: { serverId: "server-1" },
      query: undefined,
      body: {
        guildId: "guild-1",
        displayName: "New DayZ",
        providerServerId: "cftools-new",
        maxSlots: 4,
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await store.readConfiguredGameServer("guild-1", "server-1"), {
      id: "server-1",
      guildId: "guild-1",
      displayName: "New DayZ",
      providerServerId: "cftools-new",
      maxSlots: 4,
      endpointId: "endpoint-1",
      webhookCredentialId: "credential-1",
      webhookVerifiedAtMs: null,
      subscribedEvents: [],
      capacityProposal: null,
      lastRosterReconciledAtMs: null,
      lastCapacityCheckedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: changedAtMs,
    });
    assert.equal(await store.readProcessingCursor("server-1"), null);
    assert.deepEqual(await store.listCurrentPresence("server-1"), []);
    assert.deepEqual(await store.listOpenEarningSessions("server-1"), []);
    assert.deepEqual(await store.listAcceptedProviderEvents("server-1", changedAtMs), []);
    assert.deepEqual(await store.listPendingIngressOutbox(10), []);
    assert.equal((await store.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
  } finally {
    fixture.close();
  }
});
