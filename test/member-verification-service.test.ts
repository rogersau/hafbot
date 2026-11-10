/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  MemberVerificationService,
  buildMemberVerificationCustomId,
} from "../src/services/member-verification-service";
import { DiscordApiError } from "../src/discord/client";
import { GuildResourceValidator } from "../src/discord/guild-resource-validator";
import type { CreateChannelMessageInput, DiscordMessageResource } from "../src/discord/messages";
import type {
  MemberVerificationStore,
  GuildEntitlementStore,
  PlatformLinkStore,
} from "../src/runtime/contracts";
import type {
  PlatformLink,
  PlatformLinkConfig,
} from "../src/runtime/contracts/platform-link-store";
import {
  afterStoreSeed,
  createProductionRuntimeStores,
  type ProductionRuntimeStoresFixture,
  withStoreOverrides,
} from "./support/production-runtime-stores";
import type {
  MemberVerificationConfig,
  MemberVerificationState,
  MemberVerificationAttempt,
} from "../src/types";
import {
  createPermissiveGuildResourceValidator,
  testChannel,
  testRole,
} from "./helpers/guild-resource-validator";
import { createGuildFeaturesAdminRoutes } from "../src/runtime/admin-routes/guild-features";
import type { ProductAnalyticsEvent, ProductAnalyticsReporter } from "../src/product-analytics";
import type {
  ConfigurationActorContext,
  ConfigurationRevisionStore,
  VersionedConfigurationMutation,
} from "../src/configuration-revisions";
import { createTestConfigurationRevisionCoordinator } from "./support/configuration-revision-store";

const memberVerificationFixtures = new Set<ProductionRuntimeStoresFixture>();

test.after(() => {
  for (const fixture of memberVerificationFixtures) fixture.close();
  memberVerificationFixtures.clear();
});

function createVerificationStore(
  initial: {
    config?: MemberVerificationConfig | null;
    state?: MemberVerificationState | null;
    attempts?: MemberVerificationAttempt[];
  } = {},
): MemberVerificationStore {
  const fixture = createProductionRuntimeStores();
  memberVerificationFixtures.add(fixture);
  const store = fixture.stores.memberVerification;
  const ready = (async () => {
    if (initial.config) await store.upsertConfig(initial.config);
    if (initial.state) await store.upsertVerificationState(initial.state);
    for (const attempt of initial.attempts ?? []) await store.createVerificationAttempt(attempt);
  })();
  return afterStoreSeed(store, ready);
}

function createEntitlementStore(
  tier: "free" | "premium" | "premium_plus" = "premium",
): GuildEntitlementStore {
  const fixture = createProductionRuntimeStores();
  memberVerificationFixtures.add(fixture);
  const ready =
    tier === "free"
      ? Promise.resolve()
      : fixture.database.d1
          .prepare(
            "INSERT INTO guild_entitlements (guild_id, tier, plan, updated_at_ms) VALUES (?, ?, ?, ?)",
          )
          .bind("guild-1", tier, tier, 1)
          .run();
  return afterStoreSeed(fixture.stores.guildEntitlements, ready);
}

function createPlatformLinkStore(
  link?: PlatformLink,
  config?: PlatformLinkConfig,
): PlatformLinkStore {
  const fixture = createProductionRuntimeStores();
  memberVerificationFixtures.add(fixture);
  const ready = (async () => {
    if (config) await fixture.stores.platformLink.upsertPlatformLinkConfig(config);
    if (link) await fixture.stores.platformLink.upsertPlatformLink(link);
  })();
  return afterStoreSeed(fixture.stores.platformLink, ready);
}

function defaultPlatformLinkConfig(): PlatformLinkConfig {
  return {
    guildId: "guild-1",
    platform: "steam",
    linkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    panelTitle: "Link Steam",
    panelDescription: "Link Steam",
    panelButtonLabel: "Link Steam",
    panelButtonStyle: "Primary",
    allowRelink: true,
    allowMultipleLinks: false,
    requireRelinkOnRejoin: false,
    whoisFields: [],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: Date.now(),
  };
}

function createService(
  overrides: {
    store?: MemberVerificationStore;
    entitlementStore?: GuildEntitlementStore;
    addGuildMemberRole?: (guildId: string, userId: string, roleId: string) => Promise<void>;
    guildMemberHasRole?: (guildId: string, userId: string, roleId: string) => Promise<boolean>;
    readGuildMember?: (
      guildId: string,
      userId: string,
    ) => Promise<{ id?: string; username?: string } | null>;
    sendUserDm?: (
      userId: string,
      body: CreateChannelMessageInput,
    ) => Promise<DiscordMessageResource>;
    createChannelMessage?: (
      channelId: string,
      body: CreateChannelMessageInput,
    ) => Promise<DiscordMessageResource>;
    editChannelMessage?: (
      channelId: string,
      messageId: string,
      body: CreateChannelMessageInput,
    ) => Promise<void>;
    resolveGuildName?: (guildId: string) => Promise<string | null | undefined>;
    resolveFooterText?: (guildId: string) => Promise<string>;
    publicUrl?: string;
    turnstileSiteKey?: string;
    turnstileSecretKey?: string;
    platformLinkStore?: PlatformLinkStore;
    steamLinkAvailable?: boolean;
    createSteamLinkState?: (guildId: string, userId: string) => Promise<string>;
    productAnalytics?: ProductAnalyticsReporter;
    configurationRevisions?: ConfigurationRevisionStore;
    guildResources?: GuildResourceValidator;
  } = {},
) {
  const production = createProductionRuntimeStores();
  memberVerificationFixtures.add(production);
  production.database.execRaw(
    "INSERT INTO guild_entitlements (guild_id, tier, plan, updated_at_ms) VALUES ('guild-1', 'premium', 'premium', 1)",
  );
  const dmCalls: Array<{ userId: string; body: CreateChannelMessageInput }> = [];
  const channelMessages: Array<{ channelId: string; body: CreateChannelMessageInput }> = [];
  const roleCalls: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const edits: Array<{ channelId: string; messageId: string; body: CreateChannelMessageInput }> =
    [];
  const auditEvents: Array<{
    eventId: string;
    data: { reason?: string; context?: unknown; user?: { id?: string } };
  }> = [];

  const service = new MemberVerificationService({
    store: overrides.store ?? createVerificationStore(),
    guildEntitlementStore: overrides.entitlementStore ?? createEntitlementStore(),
    guildAuditLogStore: production.stores.guildAuditLog,
    guildResources: overrides.guildResources ?? createPermissiveGuildResourceValidator(),
    discordBotToken: "bot-token",
    addGuildMemberRole:
      overrides.addGuildMemberRole ??
      (async (guildId, userId, roleId) => {
        roleCalls.push({ guildId, userId, roleId });
      }),
    guildMemberHasRole:
      overrides.guildMemberHasRole ??
      (async () => {
        return false;
      }),
    readGuildMember: overrides.readGuildMember ?? (async (_guildId, userId) => ({ id: userId })),
    resolveGuildName: overrides.resolveGuildName ?? (async () => "Test Guild"),
    sendUserDm:
      overrides.sendUserDm ??
      (async (userId, body) => {
        dmCalls.push({ userId, body });
        return { id: "dm-message-1", channel_id: "dm-channel-1", content: "" };
      }),
    createChannelMessage:
      overrides.createChannelMessage ??
      (async (channelId, body) => {
        channelMessages.push({ channelId, body });
        return { id: "panel-message-1", channel_id: channelId, content: "" };
      }),
    editChannelMessage: overrides.editChannelMessage
      ? async (channelId, messageId, body) => {
          edits.push({ channelId, messageId, body });
          await overrides.editChannelMessage!(channelId, messageId, body);
        }
      : async (channelId, messageId, body) => {
          edits.push({ channelId, messageId, body });
        },
    resolveFooterText: overrides.resolveFooterText ?? (async () => "hafbot.xyz"),
    postAudit: async (eventId, data) => {
      auditEvents.push({
        eventId,
        data: { reason: data.reason, context: data.context, user: data.user },
      });
    },
    publicUrl: overrides.publicUrl,
    turnstileSiteKey: overrides.turnstileSiteKey,
    turnstileSecretKey: overrides.turnstileSecretKey,
    platformLinkStore: overrides.platformLinkStore,
    steamLinkAvailable: overrides.steamLinkAvailable,
    createSteamLinkState: overrides.createSteamLinkState,
    productAnalytics: overrides.productAnalytics,
    configurationRevisions: overrides.configurationRevisions,
  });

  return { service, dmCalls, channelMessages, roleCalls, edits, auditEvents };
}

function defaultConfig(): MemberVerificationConfig {
  return {
    guildId: "guild-1",
    enabled: true,
    verifiedRoleId: "verified-role-1",
    title: "Welcome",
    description: "Please verify.",
    color: 0x5865f2,
    imageUrl: null,
    thumbnailUrl: null,
    rulesUrl: null,
    verifyButtonEmoji: null,
    deliveryMode: "dm",
    verificationMethod: "discord-button",
    welcomeChannelId: null,
    panelMessageId: null,
    updatedAtMs: Date.now(),
  };
}

const dashboardActor: ConfigurationActorContext = {
  actorUserId: "admin-1",
  source: "dashboard-save",
  operationId: "member-verification.save",
  correlationId: "correlation-1",
};

function createMemberVerificationRevisionStore(
  store: MemberVerificationStore,
): ConfigurationRevisionStore {
  return createTestConfigurationRevisionCoordinator(
    async (mutation: VersionedConfigurationMutation) => {
      assert.equal(mutation.feature, "member-verification");
      await store.upsertConfig(mutation.next as MemberVerificationConfig);
    },
  );
}

test("MemberVerificationService exposes the Guild administrator snapshot through its interface", async () => {
  const config = { ...defaultConfig(), verificationMethod: "steam-link" as const };
  const { service } = createService({
    store: createVerificationStore({ config }),
    entitlementStore: createEntitlementStore("free"),
    turnstileSiteKey: "turnstile-site-key",
    turnstileSecretKey: "turnstile-secret-key",
    platformLinkStore: createPlatformLinkStore(undefined, defaultPlatformLinkConfig()),
    steamLinkAvailable: true,
  });

  assert.deepEqual(await service.readAdminSnapshot("guild-1"), {
    guildId: "guild-1",
    config,
    paidMethodsAvailable: false,
    turnstileAvailable: true,
    steamLinkAvailable: true,
    steamLinkConfigured: true,
  });
});

test("MemberVerificationService saves Welcome DM configuration through its interface", async () => {
  const store = createVerificationStore();
  const revisions = createMemberVerificationRevisionStore(store);
  const { service, channelMessages } = createService({
    store,
    configurationRevisions: revisions,
  });

  const result = await service.saveAdminConfig({
    guildId: "guild-1",
    enabled: true,
    verifiedRoleId: "verified-role-1",
    actor: dashboardActor,
  });

  assert.equal(result.outcome, "saved");
  if (result.outcome !== "saved") return;
  assert.equal(result.panelOutcome, "not-required");
  assert.equal(result.config.deliveryMode, "dm");
  assert.equal(result.config.verificationMethod, "discord-button");
  assert.equal(result.config.title, "Welcome");
  assert.equal(channelMessages.length, 0);
  assert.deepEqual((await service.readAdminSnapshot("guild-1")).config, result.config);
  assert.ok(
    await revisions.readHead({
      guildId: "guild-1",
      feature: "member-verification",
      resourceKey: "default",
    }),
  );
});

test("MemberVerificationService rejects unavailable Turnstile before persistence", async () => {
  const store = createVerificationStore();
  const { service } = createService({
    store,
    configurationRevisions: createMemberVerificationRevisionStore(store),
  });

  const result = await service.saveAdminConfig({
    guildId: "guild-1",
    enabled: true,
    verifiedRoleId: "verified-role-1",
    verificationMethod: "turnstile",
    actor: dashboardActor,
  });

  assert.deepEqual(result, {
    outcome: "method-unavailable",
    reason: "turnstile-runtime-unavailable",
  });
  assert.equal((await service.readAdminSnapshot("guild-1")).config, null);
});

test("MemberVerificationService rejects incomplete activation before persistence", async () => {
  const cases = [
    {
      input: { enabled: true, verifiedRoleId: null },
      reason: "verified-role-required",
    },
    {
      input: {
        enabled: true,
        verifiedRoleId: "verified-role-1",
        deliveryMode: "channel" as const,
        welcomeChannelId: null,
      },
      reason: "welcome-channel-required",
    },
  ] as const;

  for (const testCase of cases) {
    const store = createVerificationStore();
    const { service } = createService({ store });

    const result = await service.saveAdminConfig({
      guildId: "guild-1",
      ...testCase.input,
      actor: dashboardActor,
    });

    assert.deepEqual(result, { outcome: "invalid", reason: testCase.reason });
    assert.equal(await store.readConfig("guild-1"), null);
  }
});

test("MemberVerificationService saves channel configuration and creates its Welcome Panel", async () => {
  const store = createVerificationStore();
  const revisions = createMemberVerificationRevisionStore(store);
  const { service, channelMessages, auditEvents } = createService({
    store,
    configurationRevisions: revisions,
  });

  const result = await service.saveAdminConfig({
    guildId: "guild-1",
    enabled: true,
    verifiedRoleId: "verified-role-1",
    deliveryMode: "channel",
    welcomeChannelId: "welcome-channel-1",
    actor: dashboardActor,
  });

  assert.equal(result.outcome, "saved");
  if (result.outcome !== "saved") return;
  assert.equal(result.panelOutcome, "created");
  assert.equal(result.config.panelMessageId, "panel-message-1");
  assert.equal(channelMessages.length, 1);
  assert.deepEqual((await service.readAdminSnapshot("guild-1")).config, result.config);
  const revision = await revisions.readHead({
    guildId: "guild-1",
    feature: "member-verification",
    resourceKey: "default",
  });
  assert.ok(revision);
  assert.equal(revision.snapshotJson.includes("panel-message-1"), false);
  assert.deepEqual(
    auditEvents.find((event) => event.eventId === "member-verification.panel-published")?.data
      .context,
    { messageId: "panel-message-1", refreshed: false },
  );
});

test("MemberVerificationService retains saved configuration when Welcome Panel publication fails", async () => {
  const store = createVerificationStore();
  const revisions = createMemberVerificationRevisionStore(store);
  const { service } = createService({
    store,
    configurationRevisions: revisions,
    createChannelMessage: async () => {
      throw new DiscordApiError("Missing Permissions", 403, "Missing Permissions");
    },
  });

  const result = await service.saveAdminConfig({
    guildId: "guild-1",
    enabled: true,
    verifiedRoleId: "verified-role-1",
    deliveryMode: "channel",
    welcomeChannelId: "welcome-channel-1",
    actor: dashboardActor,
  });

  assert.equal(result.outcome, "saved-panel-repair-required");
  if (result.outcome !== "saved-panel-repair-required") return;
  assert.equal(result.config.panelMessageId, null);
  assert.deepEqual((await service.readAdminSnapshot("guild-1")).config, result.config);
  assert.ok(
    await revisions.readHead({
      guildId: "guild-1",
      feature: "member-verification",
      resourceKey: "default",
    }),
  );
});

test("MemberVerificationService preserves a saved config when panel resource lookup fails", async () => {
  const store = createVerificationStore();
  const revisions = createMemberVerificationRevisionStore(store);
  const guildResources = new GuildResourceValidator({
    async list(guildId) {
      if (await store.readConfig(guildId)) {
        throw new DiscordApiError("Resource lookup unavailable", 503, "Service Unavailable");
      }
      return {
        channels: [testChannel("welcome-channel-1", 0, guildId)],
        roles: [testRole("verified-role-1")],
      };
    },
    async fetchChannel() {
      throw new Error("Unexpected channel fetch");
    },
  });
  const { service, channelMessages } = createService({
    store,
    configurationRevisions: revisions,
    guildResources,
  });

  const result = await service.saveAdminConfig({
    guildId: "guild-1",
    enabled: true,
    verifiedRoleId: "verified-role-1",
    deliveryMode: "channel",
    welcomeChannelId: "welcome-channel-1",
    actor: dashboardActor,
  });

  assert.equal(result.outcome, "saved-panel-repair-required");
  if (result.outcome !== "saved-panel-repair-required") return;
  assert.deepEqual(await store.readConfig("guild-1"), result.config);
  assert.ok(
    await revisions.readHead({
      guildId: "guild-1",
      feature: "member-verification",
      resourceKey: "default",
    }),
  );
  assert.deepEqual(await service.repairWelcomePanel("guild-1"), { outcome: "failed" });
  assert.equal(channelMessages.length, 0);
});

test("MemberVerificationService rejects resource lookup failures before saving", async () => {
  const store = createVerificationStore();
  const { service, channelMessages } = createService({
    store,
    guildResources: new GuildResourceValidator({
      async list() {
        throw new DiscordApiError("Resource lookup unavailable", 503, "Service Unavailable");
      },
      async fetchChannel() {
        throw new Error("Unexpected channel fetch");
      },
    }),
  });

  await assert.rejects(
    service.saveAdminConfig({
      guildId: "guild-1",
      enabled: true,
      verifiedRoleId: "verified-role-1",
      deliveryMode: "channel",
      welcomeChannelId: "welcome-channel-1",
      actor: dashboardActor,
    }),
    /Resource lookup unavailable/,
  );
  assert.equal(await store.readConfig("guild-1"), null);
  assert.equal(channelMessages.length, 0);
});

test("MemberVerificationService repairs a missing Welcome Panel through its shared lifecycle", async () => {
  const store = createVerificationStore({
    config: {
      ...defaultConfig(),
      deliveryMode: "channel",
      welcomeChannelId: "welcome-channel-1",
      panelMessageId: "missing-panel-1",
    },
  });
  const { service, channelMessages } = createService({
    store,
    editChannelMessage: async () => {
      throw new DiscordApiError("Not Found", 404, "Unknown Message");
    },
  });

  const result = await service.repairWelcomePanel("guild-1");

  assert.deepEqual(result, {
    outcome: "created",
    panelMessageId: "panel-message-1",
  });
  assert.equal(channelMessages.length, 1);
  assert.equal(
    (await service.readAdminSnapshot("guild-1")).config?.panelMessageId,
    "panel-message-1",
  );
});

test("MemberVerificationService reports why a Welcome Panel is not eligible for repair", async () => {
  const store = createVerificationStore({
    config: {
      ...defaultConfig(),
      enabled: false,
      deliveryMode: "channel",
      welcomeChannelId: "welcome-channel-1",
    },
  });
  const { service, channelMessages, edits } = createService({ store });

  const result = await service.repairWelcomePanel("guild-1");

  assert.deepEqual(result, { outcome: "not-eligible", reason: "disabled" });
  assert.equal(channelMessages.length, 0);
  assert.equal(edits.length, 0);
});

test("MemberVerificationService reports a failed Welcome Panel repair", async () => {
  const store = createVerificationStore({
    config: {
      ...defaultConfig(),
      deliveryMode: "channel",
      welcomeChannelId: "welcome-channel-1",
    },
  });
  const { service } = createService({
    store,
    createChannelMessage: async () => {
      throw new DiscordApiError("Missing Permissions", 403, "Missing Permissions");
    },
  });

  const result = await service.repairWelcomePanel("guild-1");

  assert.deepEqual(result, { outcome: "failed" });
});

test("MemberVerificationService can disable retained unavailable configuration without clearing panel state", async () => {
  const store = createVerificationStore({
    config: {
      ...defaultConfig(),
      verificationMethod: "steam-link",
      deliveryMode: "channel",
      welcomeChannelId: "welcome-channel-1",
      panelMessageId: "panel-message-1",
    },
  });
  const { service, edits, channelMessages } = createService({
    store,
    entitlementStore: createEntitlementStore("free"),
    steamLinkAvailable: false,
  });

  const result = await service.saveAdminConfig({
    guildId: "guild-1",
    enabled: false,
    verifiedRoleId: null,
    deliveryMode: "dm",
    welcomeChannelId: null,
    actor: dashboardActor,
  });

  assert.equal(result.outcome, "saved");
  if (result.outcome !== "saved") return;
  assert.equal(result.panelOutcome, "not-required");
  assert.equal(result.config.enabled, false);
  assert.equal(result.config.verificationMethod, "steam-link");
  assert.equal(result.config.verifiedRoleId, null);
  assert.equal(result.config.welcomeChannelId, null);
  assert.equal(result.config.panelMessageId, "panel-message-1");
  assert.deepEqual(edits, []);
  assert.deepEqual(channelMessages, []);
});

test("MemberVerificationService can replace retained unavailable configuration", async () => {
  const store = createVerificationStore({
    config: { ...defaultConfig(), verificationMethod: "steam-link" },
  });
  const { service } = createService({
    store,
    entitlementStore: createEntitlementStore("free"),
    steamLinkAvailable: false,
  });

  const result = await service.saveAdminConfig({
    guildId: "guild-1",
    enabled: true,
    verificationMethod: "discord-button",
    actor: dashboardActor,
  });

  assert.equal(result.outcome, "saved");
  if (result.outcome !== "saved") return;
  assert.equal(result.config.verificationMethod, "discord-button");
  assert.equal((await store.readConfig("guild-1"))?.verificationMethod, "discord-button");
});

test("MemberVerificationService preserves the recorded Welcome Panel when switching to Welcome DM", async () => {
  const store = createVerificationStore({
    config: {
      ...defaultConfig(),
      deliveryMode: "channel",
      welcomeChannelId: "welcome-channel-1",
      panelMessageId: "panel-message-1",
    },
  });
  const { service, edits, channelMessages } = createService({
    store,
    configurationRevisions: createMemberVerificationRevisionStore(store),
  });

  const result = await service.saveAdminConfig({
    guildId: "guild-1",
    enabled: true,
    deliveryMode: "dm",
    welcomeChannelId: null,
    actor: dashboardActor,
  });

  assert.equal(result.outcome, "saved");
  if (result.outcome !== "saved") return;
  assert.equal(result.panelOutcome, "not-required");
  assert.equal(result.config.panelMessageId, "panel-message-1");
  assert.deepEqual(edits, []);
  assert.deepEqual(channelMessages, []);
});

test("MemberVerificationService rejects Steam verification without Guild Steam Link configuration", async () => {
  const store = createVerificationStore();
  const { service } = createService({
    store,
    platformLinkStore: createPlatformLinkStore(),
    steamLinkAvailable: true,
  });

  const result = await service.saveAdminConfig({
    guildId: "guild-1",
    enabled: true,
    verifiedRoleId: "verified-role-1",
    verificationMethod: "steam-link",
    actor: dashboardActor,
  });

  assert.deepEqual(result, {
    outcome: "method-unavailable",
    reason: "steam-link-guild-config-missing",
  });
  assert.equal((await service.readAdminSnapshot("guild-1")).config, null);
});

test("MemberVerificationService refreshes an existing Welcome Panel during save", async () => {
  const store = createVerificationStore({
    config: {
      ...defaultConfig(),
      deliveryMode: "channel",
      welcomeChannelId: "welcome-channel-1",
      panelMessageId: "panel-message-1",
    },
  });
  const { service, edits, channelMessages, auditEvents } = createService({
    store,
    configurationRevisions: createMemberVerificationRevisionStore(store),
  });

  const result = await service.saveAdminConfig({
    guildId: "guild-1",
    enabled: true,
    title: "Updated welcome",
    actor: dashboardActor,
  });

  assert.equal(result.outcome, "saved");
  if (result.outcome !== "saved") return;
  assert.equal(result.panelOutcome, "refreshed");
  assert.equal(result.config.panelMessageId, "panel-message-1");
  assert.equal(edits.length, 1);
  assert.deepEqual(channelMessages, []);
  assert.deepEqual(
    auditEvents.find((event) => event.eventId === "member-verification.panel-published")?.data
      .context,
    { messageId: "panel-message-1", refreshed: true },
  );
});

test("MemberVerificationService recreates a missing Welcome Panel during save", async () => {
  const store = createVerificationStore({
    config: {
      ...defaultConfig(),
      deliveryMode: "channel",
      welcomeChannelId: "welcome-channel-1",
      panelMessageId: "missing-panel-1",
    },
  });
  const { service, edits, channelMessages } = createService({
    store,
    configurationRevisions: createMemberVerificationRevisionStore(store),
    editChannelMessage: async () => {
      throw new DiscordApiError("Not Found", 404, "Unknown Message");
    },
  });

  const result = await service.saveAdminConfig({
    guildId: "guild-1",
    enabled: true,
    title: "Updated welcome",
    actor: dashboardActor,
  });

  assert.equal(result.outcome, "saved");
  if (result.outcome !== "saved") return;
  assert.equal(result.panelOutcome, "created");
  assert.equal(result.config.panelMessageId, "panel-message-1");
  assert.equal(edits.length, 1);
  assert.equal(channelMessages.length, 1);
  assert.equal((await store.readConfig("guild-1"))?.panelMessageId, "panel-message-1");
});

async function createManualDmAdminRoute(options: {
  config?: MemberVerificationConfig;
  readGuildMember: (guildId: string, userId: string) => Promise<{ id?: string } | null>;
}) {
  const fixture = createProductionRuntimeStores();
  memberVerificationFixtures.add(fixture);
  await fixture.stores.memberVerification.upsertConfig(options.config ?? defaultConfig());
  const { service } = createService({
    store: fixture.stores.memberVerification,
    readGuildMember: options.readGuildMember,
  });
  const route = createGuildFeaturesAdminRoutes({
    stores: fixture.stores,
    adminAccess: {} as never,
    discordBotToken: "bot-token",
    guildResources: createPermissiveGuildResourceValidator(),
    readCustomerAdminSession: async () => ({
      user: { id: "session-1", discordUserId: "admin-1", name: "Admin" },
    }),
    memberVerificationService: service,
  }).find((candidate) => candidate.path === "/admin/api/member-verification/send-welcome-dm");
  assert.ok(route);
  return { route, store: fixture.stores.memberVerification };
}

test("MemberVerificationService.handleMemberAdd sends welcome DM to new members", async () => {
  const { service, dmCalls, roleCalls, auditEvents } = createService({
    store: createVerificationStore({ config: defaultConfig() }),
  });

  await service.handleMemberAdd({ guildId: "guild-1", userId: "user-1" });

  assert.equal(dmCalls.length, 1);
  assert.equal(dmCalls[0]?.userId, "user-1");
  assert.equal(dmCalls[0]?.body.embeds?.[0]?.title, "Welcome");
  assert.equal(dmCalls[0]?.body.embeds?.[0]?.description, "Please verify.");
  assert.equal(dmCalls[0]?.body.components?.length, 1);
  assert.equal(
    (dmCalls[0]?.body.components?.[0] as { components?: { custom_id?: string }[] })?.components?.[0]
      ?.custom_id,
    buildMemberVerificationCustomId("guild-1"),
  );
  assert.deepEqual(roleCalls, []);

  const dmSentEvent = auditEvents.find((e) => e.eventId === "member-verification.dm-sent");
  assert.ok(dmSentEvent);
});

test("MemberVerificationService welcome DM Verify button carries a unicode verifyButtonEmoji", async () => {
  const store = createVerificationStore({
    config: { ...defaultConfig(), verifyButtonEmoji: "✅" },
  });
  const { service, dmCalls } = createService({ store });

  await service.handleMemberAdd({ guildId: "guild-1", userId: "user-1" });

  const verifyButton = (
    dmCalls[0]?.body.components?.[0] as { components?: Array<{ emoji?: unknown }> }
  )?.components?.[0];
  assert.deepEqual(verifyButton?.emoji, { name: "✅" });
});

test("MemberVerificationService welcome DM Verify button splits a custom verifyButtonEmoji into id/name/animated", async () => {
  const store = createVerificationStore({
    config: { ...defaultConfig(), verifyButtonEmoji: ":a:verified:111" },
  });
  const { service, dmCalls } = createService({ store });

  await service.handleMemberAdd({ guildId: "guild-1", userId: "user-1" });

  const verifyButton = (
    dmCalls[0]?.body.components?.[0] as { components?: Array<{ emoji?: unknown }> }
  )?.components?.[0];
  assert.deepEqual(verifyButton?.emoji, { id: "111", name: "verified", animated: true });
});

test("MemberVerificationService welcome DM Verify button omits emoji when verifyButtonEmoji is null", async () => {
  const { service, dmCalls } = createService({
    store: createVerificationStore({ config: defaultConfig() }),
  });

  await service.handleMemberAdd({ guildId: "guild-1", userId: "user-1" });

  const verifyButton = dmCalls[0]?.body.components?.[0] as {
    components?: Array<{ emoji?: unknown }>;
  };
  assert.equal(verifyButton?.components?.[0]?.emoji, undefined);
});

test("MemberVerificationService.handleMemberAdd restores role for previously verified members", async () => {
  const { service, dmCalls, roleCalls } = createService({
    store: createVerificationStore({
      config: defaultConfig(),
      state: { guildId: "guild-1", userId: "user-1", verifiedAtMs: Date.now() },
    }),
  });

  await service.handleMemberAdd({ guildId: "guild-1", userId: "user-1" });

  assert.equal(roleCalls.length, 1);
  assert.deepEqual(roleCalls[0], {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "verified-role-1",
  });
  assert.equal(dmCalls.length, 0);
});

test("MemberVerificationService.handleMemberAdd welcomes unverified joiners without an entitlement gate", async () => {
  const { service, dmCalls, roleCalls } = createService({
    store: createVerificationStore({ config: defaultConfig() }),
    entitlementStore: createEntitlementStore("free"),
  });

  await service.handleMemberAdd({ guildId: "guild-1", userId: "user-1" });

  assert.equal(dmCalls.length, 1);
  assert.equal(roleCalls.length, 0);
});

test("MemberVerificationService.handleMemberAdd keeps enhanced verification dormant on Free", async () => {
  const { service, dmCalls } = createService({
    store: createVerificationStore({
      config: { ...defaultConfig(), verificationMethod: "turnstile" },
    }),
    entitlementStore: createEntitlementStore("free"),
  });

  await service.handleMemberAdd({ guildId: "guild-1", userId: "user-1" });

  assert.equal(dmCalls.length, 0);
});

test("MemberVerificationService.handleMemberAdd restores role for verified members", async () => {
  const { service, dmCalls, roleCalls } = createService({
    store: createVerificationStore({
      config: defaultConfig(),
      state: { guildId: "guild-1", userId: "user-1", verifiedAtMs: Date.now() },
    }),
  });

  await service.handleMemberAdd({ guildId: "guild-1", userId: "user-1" });

  assert.equal(dmCalls.length, 0);
  assert.equal(roleCalls.length, 1);
  assert.deepEqual(roleCalls[0], {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "verified-role-1",
  });
});

test("MemberVerificationService.handleMemberAdd restores role for verified members even when disabled", async () => {
  const { service, dmCalls, roleCalls } = createService({
    store: createVerificationStore({
      config: { ...defaultConfig(), enabled: false },
      state: { guildId: "guild-1", userId: "user-1", verifiedAtMs: Date.now() },
    }),
  });

  await service.handleMemberAdd({ guildId: "guild-1", userId: "user-1" });

  assert.equal(dmCalls.length, 0);
  assert.equal(roleCalls.length, 1);
  assert.deepEqual(roleCalls[0], {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "verified-role-1",
  });
});

test("MemberVerificationService.handleMemberAdd does nothing when config is disabled and member is unverified", async () => {
  const config = { ...defaultConfig(), enabled: false };
  const { service, dmCalls, roleCalls } = createService({
    store: createVerificationStore({ config }),
  });

  await service.handleMemberAdd({ guildId: "guild-1", userId: "user-1" });

  assert.equal(dmCalls.length, 0);
  assert.equal(roleCalls.length, 0);
});

test("MemberVerificationService.handleMemberAdd sends welcome DM on an unverified (re)join", async () => {
  // The gateway cannot distinguish a fresh join from an unverified rejoin
  // (GUILD_MEMBER_ADD fires identically for both), so both receive the DM.
  const { service, dmCalls, auditEvents } = createService({
    store: createVerificationStore({ config: defaultConfig() }),
  });

  await service.handleMemberAdd({ guildId: "guild-1", userId: "user-1" });

  assert.equal(dmCalls.length, 1);
  const dmSentEvent = auditEvents.find((e) => e.eventId === "member-verification.dm-sent");
  assert.ok(dmSentEvent);
});

test("MemberVerificationService.handleVerifyButton grants role and records state", async () => {
  const store = createVerificationStore({ config: defaultConfig() });
  const events: ProductAnalyticsEvent[] = [];
  const { service, roleCalls, edits, auditEvents } = createService({
    store,
    productAnalytics: { report: async (event) => void events.push(event) },
  });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
    messageId: "dm-message-1",
    channelId: "dm-channel-1",
  })) as { data: { content: string } };

  assert.equal(roleCalls.length, 1);
  assert.deepEqual(roleCalls[0], {
    guildId: "guild-1",
    userId: "user-1",
    roleId: "verified-role-1",
  });

  const state = await store.readVerificationState("guild-1", "user-1");
  assert.ok(state);
  assert.equal(state!.userId, "user-1");
  assert.equal(response.data.content, "✅ You're now verified — welcome to Test Guild.");

  assert.equal(edits.length, 1);
  assert.equal(edits[0]?.messageId, "dm-message-1");
  assert.equal(
    (edits[0]?.body.components?.[0] as { components?: { label?: string; disabled?: boolean }[] })
      ?.components?.[0]?.label,
    "Verified ✅",
  );
  assert.equal(
    (edits[0]?.body.components?.[0] as { components?: { label?: string; disabled?: boolean }[] })
      ?.components?.[0]?.disabled,
    true,
  );

  const verifyEvent = auditEvents.find((e) => e.eventId === "member-verification.verify");
  assert.ok(verifyEvent);
  assert.deepEqual(events, [
    {
      name: "feature_outcome",
      insertionId: events[0]!.insertionId,
      guildId: "guild-1",
      feature: "member_verification",
      action: "verification_role_granted",
      status: "success",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /user-1|verified-role-1|dm-message-1/);
});

test("MemberVerificationService.handleVerifyButton edits DM even without guild name", async () => {
  const { service, edits } = createService({
    store: createVerificationStore({ config: defaultConfig() }),
    resolveGuildName: async () => null,
  });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
    messageId: "dm-message-1",
    channelId: "dm-channel-1",
  })) as { data: { content: string } };

  assert.equal(response.data.content, "✅ You're now verified — welcome.");
  assert.equal(edits.length, 1);
});

test("MemberVerificationService.handleVerifyButton is idempotent when member already has role", async () => {
  const store = createVerificationStore({ config: defaultConfig() });
  const { service, roleCalls, edits, auditEvents } = createService({
    store,
    guildMemberHasRole: async () => true,
  });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
    messageId: "dm-message-1",
    channelId: "dm-channel-1",
  })) as { data: { content: string } };

  assert.equal(roleCalls.length, 0);
  assert.equal(edits.length, 0);
  assert.equal(response.data.content, "You're already verified 👍");

  const state = await store.readVerificationState("guild-1", "user-1");
  assert.ok(state);
  assert.equal(auditEvents.length, 0);
});

test("MemberVerificationService.handleVerifyButton re-grants role when sticky state exists but role is missing", async () => {
  const store = createVerificationStore({
    config: defaultConfig(),
    state: { guildId: "guild-1", userId: "user-1", verifiedAtMs: Date.now() },
  });
  const { service, roleCalls, edits } = createService({ store });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
    messageId: "dm-message-1",
    channelId: "dm-channel-1",
  })) as { data: { content: string } };

  assert.equal(roleCalls.length, 1);
  assert.equal(edits.length, 1);
  assert.equal(response.data.content, "✅ You're now verified — welcome to Test Guild.");
});

test("MemberVerificationService.handleVerifyButton verifies without an entitlement gate", async () => {
  const { service, roleCalls, auditEvents } = createService({
    store: createVerificationStore({ config: defaultConfig() }),
    entitlementStore: createEntitlementStore("free"),
  });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
  })) as { data: { content: string } };

  assert.equal(roleCalls.length, 1);
  assert.match(response.data.content, /now verified/);
  assert.equal(
    auditEvents.some((e) => e.eventId === "member-verification.verify-failed"),
    false,
  );
});

test("MemberVerificationService.handleVerifyButton keeps enhanced methods paid", async () => {
  const { service, roleCalls, auditEvents } = createService({
    store: createVerificationStore({
      config: { ...defaultConfig(), verificationMethod: "turnstile" },
    }),
    entitlementStore: createEntitlementStore("free"),
  });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
  })) as { data: { content: string } };

  assert.equal(roleCalls.length, 0);
  assert.equal(response.data.content, "This verification method requires a paid plan.");
  const failedEvent = auditEvents.find(
    (event) => event.eventId === "member-verification.verify-failed",
  );
  assert.equal(
    (failedEvent?.data as { reason?: string } | undefined)?.reason,
    "advanced-method-paid",
  );
});

test("MemberVerificationService.handleVerifyButton fails gracefully when role grant fails", async () => {
  const { service, roleCalls, auditEvents } = createService({
    store: createVerificationStore({ config: defaultConfig() }),
    addGuildMemberRole: async () => {
      throw new DiscordApiError("Missing Permissions", 403, "Missing Permissions");
    },
  });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
  })) as { data: { content: string } };

  assert.equal(roleCalls.length, 0);
  assert.equal(
    response.data.content,
    "Couldn't grant your verified role right now — staff have been notified.",
  );

  const failedEvent = auditEvents.find((e) => e.eventId === "member-verification.verify-failed");
  assert.ok(failedEvent);
  assert.ok((failedEvent.data as { reason?: string }).reason);
});

test("MemberVerificationService.sendWelcomeDm audits dm-undeliverable for closed DMs", async () => {
  const { service, auditEvents } = createService({
    store: createVerificationStore({ config: defaultConfig() }),
    sendUserDm: async () => {
      throw new DiscordApiError("Cannot DM user", 403, "Cannot send messages to this user");
    },
  });

  await service.sendWelcomeDm({ guildId: "guild-1", userId: "user-1" });

  const event = auditEvents.find((e) => e.eventId === "member-verification.dm-undeliverable");
  assert.ok(event);
});

test("MemberVerificationService.sendWelcomeDm audits dm-undeliverable for non-403 DM failures", async () => {
  const { service, auditEvents } = createService({
    store: createVerificationStore({ config: defaultConfig() }),
    sendUserDm: async () => {
      throw new Error("Network error");
    },
  });

  await service.sendWelcomeDm({ guildId: "guild-1", userId: "user-1" });

  const event = auditEvents.find((e) => e.eventId === "member-verification.dm-undeliverable");
  assert.ok(event);
});

test("manual Welcome DM rejects a user who belongs only to another Guild before delivery", async () => {
  const membershipChecks: Array<{ guildId: string; userId: string }> = [];
  const { service, dmCalls, auditEvents } = createService({
    store: createVerificationStore({ config: defaultConfig() }),
    readGuildMember: async (guildId, userId) => {
      membershipChecks.push({ guildId, userId });
      return guildId === "guild-2" ? { id: userId } : null;
    },
  });

  const result = await service.sendManualWelcomeDm({
    guildId: "guild-1",
    userId: "other-guild-user",
    actorUserId: "admin-1",
  });

  assert.deepEqual(result, { outcome: "not-member" });
  assert.deepEqual(membershipChecks, [{ guildId: "guild-1", userId: "other-guild-user" }]);
  assert.equal(dmCalls.length, 0);
  assert.deepEqual(auditEvents.at(-1), {
    eventId: "member-verification.dm-blocked",
    data: {
      reason: "not-member",
      context: { source: "manual", outcome: "blocked", actorUserId: "admin-1" },
      user: { id: "other-guild-user" },
    },
  });
});

test("manual Welcome DM rejects an unknown Discord user before delivery", async () => {
  const { service, dmCalls } = createService({
    store: createVerificationStore({ config: defaultConfig() }),
    readGuildMember: async () => null,
  });

  const result = await service.sendManualWelcomeDm({
    guildId: "guild-1",
    userId: "unknown-user",
    actorUserId: "admin-1",
  });

  assert.deepEqual(result, { outcome: "not-member" });
  assert.equal(dmCalls.length, 0);
});

test("manual Welcome DM allows a current member and audits the actor and target", async () => {
  const consumedScopes: Array<{ scopeType: string; scopeId: string; limit: number }> = [];
  const store = withStoreOverrides(createVerificationStore({ config: defaultConfig() }), {
    async consumeManualDmRateLimit(input) {
      consumedScopes.push({
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        limit: input.limit,
      });
      return { allowed: true, retryAfterMs: input.windowMs };
    },
  });
  const { service, dmCalls, auditEvents } = createService({
    store,
    readGuildMember: async (_guildId, userId) => ({ id: userId, username: "Current Member" }),
  });

  const result = await service.sendManualWelcomeDm({
    guildId: "guild-1",
    userId: "member-1",
    actorUserId: "admin-1",
  });

  assert.deepEqual(result, { outcome: "sent" });
  assert.equal(dmCalls.length, 1);
  assert.deepEqual(consumedScopes, [
    { scopeType: "guild", scopeId: "guild-1", limit: 25 },
    { scopeType: "actor", scopeId: "admin-1", limit: 10 },
    { scopeType: "target", scopeId: "member-1", limit: 1 },
  ]);
  assert.deepEqual(auditEvents.at(-1), {
    eventId: "member-verification.dm-sent",
    data: {
      reason: undefined,
      context: { source: "manual", actorUserId: "admin-1", outcome: "delivered" },
      user: { id: "member-1", username: "Current Member" },
    },
  });
});

test("manual Welcome DM rejects disabled verification and audits the blocked outcome", async () => {
  let membershipChecked = false;
  const { service, dmCalls, auditEvents } = createService({
    store: createVerificationStore({ config: { ...defaultConfig(), enabled: false } }),
    readGuildMember: async () => {
      membershipChecked = true;
      return { id: "member-1" };
    },
  });

  const result = await service.sendManualWelcomeDm({
    guildId: "guild-1",
    userId: "member-1",
    actorUserId: "admin-1",
  });

  assert.deepEqual(result, { outcome: "disabled" });
  assert.equal(membershipChecked, false);
  assert.equal(dmCalls.length, 0);
  assert.equal(auditEvents.at(-1)?.eventId, "member-verification.dm-blocked");
  assert.equal(auditEvents.at(-1)?.data.reason, "disabled");
});

test("manual Welcome DM audits a paid-method rejection with the actor and target", async () => {
  const { service, dmCalls, auditEvents } = createService({
    store: createVerificationStore({
      config: { ...defaultConfig(), verificationMethod: "steam-link" },
    }),
    entitlementStore: createEntitlementStore("free"),
  });

  const result = await service.sendManualWelcomeDm({
    guildId: "guild-1",
    userId: "member-1",
    actorUserId: "admin-1",
  });

  assert.deepEqual(result, { outcome: "paid-required" });
  assert.equal(dmCalls.length, 0);
  assert.deepEqual(auditEvents.at(-1), {
    eventId: "member-verification.dm-blocked",
    data: {
      reason: "paid-required",
      context: { source: "manual", outcome: "blocked", actorUserId: "admin-1" },
      user: { id: "member-1" },
    },
  });
});

test("manual Welcome DM rate limits repeated sends to the same target", async () => {
  const { service, dmCalls, auditEvents } = createService({
    store: createVerificationStore({ config: defaultConfig() }),
  });

  const first = await service.sendManualWelcomeDm({
    guildId: "guild-1",
    userId: "member-1",
    actorUserId: "admin-1",
  });
  const repeated = await service.sendManualWelcomeDm({
    guildId: "guild-1",
    userId: "member-1",
    actorUserId: "admin-1",
  });

  assert.deepEqual(first, { outcome: "sent" });
  assert.equal(repeated.outcome, "rate-limited");
  assert.equal(dmCalls.length, 1);
  assert.deepEqual(auditEvents.at(-1), {
    eventId: "member-verification.dm-blocked",
    data: {
      reason: "rate-limited",
      context: {
        source: "manual",
        outcome: "blocked",
        actorUserId: "admin-1",
        scope: "target",
      },
      user: { id: "member-1" },
    },
  });
});

test("manual Welcome DM Admin route returns a generic 404 for a non-member", async () => {
  const { route } = await createManualDmAdminRoute({ readGuildMember: async () => null });

  const request = () =>
    route.handler({
      request: new Request("https://example.com/admin/api/member-verification/send-welcome-dm", {
        method: "POST",
      }),
      url: new URL("https://example.com/admin/api/member-verification/send-welcome-dm"),
      params: {},
      query: undefined,
      body: { guildId: "guild-1", userId: "unknown-user" },
    });

  const response = await request();
  const repeated = await request();

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Member not found." });
  assert.equal(repeated.status, 429);
});

test("manual Welcome DM Admin route rate limits repeated disabled requests", async () => {
  const { route } = await createManualDmAdminRoute({
    config: { ...defaultConfig(), enabled: false },
    readGuildMember: async () => {
      throw new Error("Disabled verification must not query Discord membership.");
    },
  });
  const request = () =>
    route.handler({
      request: new Request("https://example.com/admin/api/member-verification/send-welcome-dm", {
        method: "POST",
      }),
      url: new URL("https://example.com/admin/api/member-verification/send-welcome-dm"),
      params: {},
      query: undefined,
      body: { guildId: "guild-1", userId: "member-1" },
    });

  const response = await request();
  const repeated = await request();

  assert.equal(response.status, 409);
  assert.equal(repeated.status, 429);
});

test("manual Welcome DM Admin route returns retry guidance during target cooldown", async () => {
  const { route, store } = await createManualDmAdminRoute({
    readGuildMember: async (_guildId, userId) => ({ id: userId }),
  });
  await store.consumeManualDmRateLimit({
    guildId: "guild-1",
    scopeType: "target",
    scopeId: "member-1",
    nowMs: Date.now(),
    windowMs: 300_000,
    limit: 1,
  });

  const response = await route.handler({
    request: new Request("https://example.com/admin/api/member-verification/send-welcome-dm", {
      method: "POST",
    }),
    url: new URL("https://example.com/admin/api/member-verification/send-welcome-dm"),
    params: {},
    query: undefined,
    body: { guildId: "guild-1", userId: "member-1" },
  });

  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
});

test("MemberVerificationService.buildWelcomeMessage includes rules link when configured", async () => {
  const { service, dmCalls } = createService({
    store: createVerificationStore({
      config: { ...defaultConfig(), rulesUrl: "https://example.com/rules" },
    }),
  });

  await service.sendWelcomeDm({ guildId: "guild-1", userId: "user-1" });

  assert.equal(dmCalls.length, 1);
  const row = dmCalls[0]?.body.components?.[0] as { components: unknown[] };
  assert.equal(dmCalls[0]?.body.components?.length, 1);
  assert.equal(row.components.length, 2);
});

test("MemberVerificationService.handleMemberAdd does not DM in channel mode", async () => {
  const { service, dmCalls, channelMessages, roleCalls } = createService({
    store: createVerificationStore({
      config: { ...defaultConfig(), deliveryMode: "channel", welcomeChannelId: "welcome-1" },
    }),
  });

  await service.handleMemberAdd({ guildId: "guild-1", userId: "user-1" });

  // Channel mode performs no per-join delivery; the panel is published on save.
  assert.equal(dmCalls.length, 0);
  assert.equal(channelMessages.length, 0);
  assert.equal(roleCalls.length, 0);
});

test("MemberVerificationService.handleVerifyButton leaves the shared panel button enabled", async () => {
  const store = createVerificationStore({
    config: {
      ...defaultConfig(),
      deliveryMode: "channel",
      welcomeChannelId: "welcome-1",
      panelMessageId: "panel-message-1",
    },
  });
  const { service, roleCalls, edits } = createService({ store });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
    messageId: "panel-message-1",
    channelId: "welcome-1",
  })) as { data: { content: string } };

  // Role is granted, ephemeral confirmation shown...
  assert.equal(roleCalls.length, 1);
  assert.equal(response.data.content, "✅ You're now verified — welcome to Test Guild.");
  // ...but the shared panel button is NOT disabled for everyone.
  assert.equal(edits.length, 0);
});

test("MemberVerificationService.handleVerifyButton leaves an orphaned panel button enabled after a switch back to dm mode", async () => {
  // A Guild published a channel panel, then switched deliveryMode back to
  // "dm". The panel message still exists in Discord and still carries a Verify
  // button; panelMessageId is preserved across the switch. The discriminator
  // is "is this message the persisted panel?" — NOT the current deliveryMode —
  // so a click on that orphaned shared panel must not disable it for everyone.
  const store = createVerificationStore({
    config: {
      ...defaultConfig(),
      deliveryMode: "dm",
      welcomeChannelId: "welcome-1",
      panelMessageId: "panel-message-1",
    },
  });
  const { service, edits } = createService({ store });

  await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
    messageId: "panel-message-1",
    channelId: "welcome-1",
  });

  assert.equal(edits.length, 0);
});

test("MemberVerificationService.handleVerifyButton still disables the button for a DM message", async () => {
  const store = createVerificationStore({
    config: {
      ...defaultConfig(),
      // Even in channel mode, a click from a DM-style message disables that button.
      deliveryMode: "channel",
      welcomeChannelId: "welcome-1",
      panelMessageId: "panel-message-1",
    },
  });
  const { service, edits } = createService({ store });

  await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
    messageId: "some-dm-message",
    channelId: "some-dm-channel",
  });

  assert.equal(edits.length, 1);
});

test("MemberVerificationService.handleVerifyButton with turnstile method creates a verification attempt and returns a URL", async () => {
  const store = createVerificationStore({
    config: { ...defaultConfig(), verificationMethod: "turnstile" },
  });
  const { service, roleCalls, auditEvents } = createService({
    store,
    publicUrl: "https://example.com",
    turnstileSiteKey: "site-key",
    turnstileSecretKey: "secret-key",
  });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
  })) as { data: { content: string } };

  assert.equal(roleCalls.length, 0);
  assert.ok(response.data.content.includes("https://example.com/verify/"));
  assert.ok(response.data.content.includes("sig="));

  const match = /verify\/([^?\s]+)\?sig=([^\s]+)/.exec(response.data.content);
  assert.ok(match, "expected signed verification URL");
  const attemptId = decodeURIComponent(match[1] ?? "");
  const signature = decodeURIComponent(match[2] ?? "");
  const attempts = await store.listActiveVerificationAttempts("guild-1", "user-1");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.userId, "user-1");
  assert.equal(attempts[0]?.id, attemptId);

  const { verifyAttemptToken } = await import("../src/services/member-verification-token");
  assert.ok(await verifyAttemptToken(attempts[0]!, signature, "secret-key"));

  const createdEvent = auditEvents.find((e) => e.eventId === "member-verification.attempt-created");
  assert.ok(createdEvent);
});

test("MemberVerificationService.handleVerifyButton with turnstile method reuses an active attempt", async () => {
  const attempt: MemberVerificationAttempt = {
    id: "11111111-1111-1111-1111-111111111111",
    guildId: "guild-1",
    userId: "user-1",
    messageId: null,
    channelId: null,
    createdAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 14 * 60 * 1000,
    usedAtMs: null,
  };
  const store = createVerificationStore({
    config: { ...defaultConfig(), verificationMethod: "turnstile" },
    attempts: [attempt],
  });
  const { service } = createService({
    store,
    publicUrl: "https://example.com",
    turnstileSiteKey: "site-key",
    turnstileSecretKey: "secret-key",
  });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
  })) as { data: { content: string } };

  assert.ok(response.data.content.includes(attempt.id));
  assert.ok(response.data.content.includes("sig="));
  const attempts = await store.listActiveVerificationAttempts("guild-1", "user-1");
  assert.equal(attempts.length, 1);
});

test("MemberVerificationService.handleVerifyButton with turnstile method fails gracefully when publicUrl is missing", async () => {
  const store = createVerificationStore({
    config: { ...defaultConfig(), verificationMethod: "turnstile" },
  });
  const { service, roleCalls, auditEvents } = createService({ store });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
  })) as { data: { content: string } };

  assert.equal(roleCalls.length, 0);
  assert.equal(response.data.content, "Verification is currently unavailable for this server.");

  const failedEvent = auditEvents.find((e) => e.eventId === "member-verification.verify-failed");
  assert.ok(failedEvent);
  assert.equal((failedEvent.data as { reason?: string }).reason, "turnstile-not-configured");
});

test("MemberVerificationService.handleVerifyButton with steam-link method grants role when Steam link exists", async () => {
  const store = createVerificationStore({
    config: { ...defaultConfig(), verificationMethod: "steam-link" },
  });
  const platformLinkStore = createPlatformLinkStore(
    {
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "123456789",
      linkedAtMs: Date.now(),
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    },
    defaultPlatformLinkConfig(),
  );
  const { service, roleCalls, auditEvents } = createService({
    store,
    platformLinkStore,
  });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
  })) as { data: { content: string } };

  assert.equal(roleCalls.length, 1);
  assert.ok(response.data.content.includes("verified"));

  const verifyEvent = auditEvents.find((e) => e.eventId === "member-verification.verify");
  assert.ok(verifyEvent);
  assert.equal(
    (verifyEvent.data as { context?: { method?: string } }).context?.method,
    "steam-link",
  );
});

test("MemberVerificationService requires relinking when the retained Steam link is inactive", async () => {
  const store = createVerificationStore({
    config: { ...defaultConfig(), verificationMethod: "steam-link" },
  });
  const platformLinkStore = createPlatformLinkStore(
    {
      guildId: "guild-1",
      userId: "user-1",
      platform: "steam",
      platformId: "123456789",
      linkedAtMs: Date.now(),
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: false,
    },
    defaultPlatformLinkConfig(),
  );
  const { service, roleCalls } = createService({
    store,
    platformLinkStore,
    publicUrl: "https://example.com",
    createSteamLinkState: async () => "steam-state-relink",
  });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
    user: { id: "user-1", username: "member" },
    messageId: "message-1",
    channelId: "channel-1",
  })) as { data: { content: string } };

  assert.match(response.data.content, /steam-state-relink/);
  assert.deepEqual(roleCalls, []);
});

test("MemberVerificationService.handleVerifyButton with steam-link method returns a Steam Link URL when no link exists", async () => {
  const store = createVerificationStore({
    config: { ...defaultConfig(), verificationMethod: "steam-link" },
  });
  const platformLinkStore = createPlatformLinkStore(undefined, defaultPlatformLinkConfig());
  const createSteamLinkState = async () => "steam-state-1";
  const { service, roleCalls, auditEvents } = createService({
    store,
    platformLinkStore,
    publicUrl: "https://example.com",
    createSteamLinkState,
  });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
  })) as { data: { content: string } };

  assert.equal(roleCalls.length, 0);
  assert.ok(response.data.content.includes("https://example.com/auth/steam?state=steam-state-1"));

  const requiredEvent = auditEvents.find(
    (e) => e.eventId === "member-verification.steam-link-required",
  );
  assert.ok(requiredEvent);
});

test("MemberVerificationService.handleVerifyButton with steam-link method fails gracefully when platformLinkStore is missing", async () => {
  const store = createVerificationStore({
    config: { ...defaultConfig(), verificationMethod: "steam-link" },
  });
  const { service, roleCalls, auditEvents } = createService({ store });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
  })) as { data: { content: string } };

  assert.equal(roleCalls.length, 0);
  assert.equal(response.data.content, "Verification is currently unavailable for this server.");

  const failedEvent = auditEvents.find((e) => e.eventId === "member-verification.verify-failed");
  assert.ok(failedEvent);
  assert.equal((failedEvent.data as { reason?: string }).reason, "steam-link-runtime-unavailable");
});

test("MemberVerificationService blocks Steam auth when Guild Platform Link config is missing", async () => {
  const store = createVerificationStore({
    config: { ...defaultConfig(), verificationMethod: "steam-link" },
  });
  const platformLinkStore = createPlatformLinkStore();
  let stateCreated = false;
  const { service, auditEvents } = createService({
    store,
    platformLinkStore,
    publicUrl: "https://example.com",
    createSteamLinkState: async () => {
      stateCreated = true;
      return "should-not-be-created";
    },
  });

  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
  })) as { data: { content: string } };

  assert.equal(response.data.content, "Verification is currently unavailable for this server.");
  assert.equal(stateCreated, false);
  assert.equal(
    auditEvents.find((event) => event.eventId === "member-verification.verify-failed")?.data.reason,
    "steam-link-guild-config-missing",
  );
});

test("MemberVerificationService keeps Steam runtime availability independent from Guild config", async () => {
  const store = createVerificationStore({
    config: { ...defaultConfig(), verificationMethod: "steam-link" },
  });
  const { service, auditEvents } = createService({
    store,
    platformLinkStore: createPlatformLinkStore(undefined, defaultPlatformLinkConfig()),
    steamLinkAvailable: false,
    publicUrl: "https://example.com",
    createSteamLinkState: async () => "should-not-be-created",
  });
  const response = (await service.handleVerifyButton({
    guildId: "guild-1",
    userId: "user-1",
  })) as { data: { content: string } };
  assert.equal(response.data.content, "Verification is currently unavailable for this server.");
  assert.equal(
    auditEvents.find((event) => event.eventId === "member-verification.verify-failed")?.data.reason,
    "steam-link-runtime-unavailable",
  );
});

test("MemberVerificationService.completeVerification records verified state and audits the method", async () => {
  const store = createVerificationStore({ config: defaultConfig() });
  const { service, roleCalls, auditEvents } = createService({ store });

  const result = await service.completeVerification({
    guildId: "guild-1",
    userId: "user-1",
    method: "turnstile",
  });

  assert.equal(roleCalls.length, 1);
  assert.equal(result.outcome, "verified");
  assert.ok(result.message.includes("verified"));

  const state = await store.readVerificationState("guild-1", "user-1");
  assert.ok(state);

  const verifyEvent = auditEvents.find((e) => e.eventId === "member-verification.verify");
  assert.ok(verifyEvent);
  assert.equal(
    (verifyEvent.data as { context?: { method?: string } }).context?.method,
    "turnstile",
  );
});

test("MemberVerificationService.completeVerification returns a typed already-verified outcome", async () => {
  const store = createVerificationStore({ config: defaultConfig() });
  const { service, roleCalls, auditEvents } = createService({
    store,
    guildMemberHasRole: async () => true,
  });

  assert.deepEqual(
    await service.completeVerification({
      guildId: "guild-1",
      userId: "user-1",
      method: "discord-button",
    }),
    { outcome: "already-verified", message: "You're already verified 👍" },
  );
  assert.ok(await store.readVerificationState("guild-1", "user-1"));
  assert.deepEqual(roleCalls, []);
  assert.deepEqual(auditEvents, []);
});

test("MemberVerificationService.completeVerification returns a typed failure when Discord rejects the role", async () => {
  const store = createVerificationStore({ config: defaultConfig() });
  const { service, edits, auditEvents } = createService({
    store,
    addGuildMemberRole: async () => {
      throw new DiscordApiError("Missing permissions", 403, "");
    },
  });

  assert.deepEqual(
    await service.completeVerification({
      guildId: "guild-1",
      userId: "user-1",
      method: "discord-button",
      messageId: "dm-message",
      channelId: "dm-channel",
    }),
    {
      outcome: "failed",
      message: "Couldn't grant your verified role right now — staff have been notified.",
    },
  );
  assert.equal(await store.readVerificationState("guild-1", "user-1"), null);
  assert.deepEqual(edits, []);
  assert.equal(auditEvents[0]?.eventId, "member-verification.verify-failed");
});

test("verification recovers a role grant whose trust checkpoint failed without granting twice", async () => {
  const store = createVerificationStore({ config: defaultConfig() });
  let checkpointFailed = false;
  let hasRole = false;
  let grants = 0;
  const interruptedStore = withStoreOverrides(store, {
    upsertVerificationState: async (state) => {
      if (!checkpointFailed) {
        checkpointFailed = true;
        throw new Error("checkpoint unavailable");
      }
      await store.upsertVerificationState(state);
    },
  });
  const { service } = createService({
    store: interruptedStore,
    guildMemberHasRole: async () => hasRole,
    addGuildMemberRole: async () => {
      grants++;
      hasRole = true;
    },
  });
  const input = { guildId: "guild-1", userId: "user-1", method: "discord-button" as const };
  await assert.rejects(service.completeVerification(input), /checkpoint unavailable/);
  assert.equal(await store.readVerificationState("guild-1", "user-1"), null);
  assert.equal((await service.completeVerification(input)).outcome, "already-verified");
  assert.equal(grants, 1);
  assert.ok(await store.readVerificationState("guild-1", "user-1"));
});

test("failed rejoin restoration retains sticky trust and retries without a new welcome", async () => {
  const state = { guildId: "guild-1", userId: "user-1", verifiedAtMs: 123 };
  const store = createVerificationStore({ config: { ...defaultConfig(), enabled: false }, state });
  let grants = 0;
  const { service, dmCalls } = createService({
    store,
    addGuildMemberRole: async () => {
      if (++grants === 1) throw new Error("role unavailable");
    },
  });
  await service.handleMemberAdd(state);
  assert.deepEqual(await store.readVerificationState("guild-1", "user-1"), state);
  await service.handleMemberAdd(state);
  assert.equal(grants, 2);
  assert.equal(dmCalls.length, 0);
  assert.deepEqual(await store.readVerificationState("guild-1", "user-1"), state);
});
