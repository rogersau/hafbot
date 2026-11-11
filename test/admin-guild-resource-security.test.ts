import { BlocklistService } from "../src/services/blocklist-service";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createAdminApiHandler } from "./helpers/admin-api";
import { createDefaultMarketplaceConfig } from "../src/marketplace-config";
import { EventsService } from "../src/services/events-service";
import { createMemberVerificationService } from "../src/services/member-verification-service";
import { createTicketPanelService } from "../src/services/tickets/ticket-panel";
import { SuggestionService } from "../src/services/suggestion-service";
import { TimedRoleService } from "../src/services/timed-role-service";
import { defaultSuggestionsConfig } from "../src/suggestions";
import { LfgService } from "../src/services/lfg-service";
import { MarketplaceService } from "../src/services/marketplace-service";
import {
  createStaticGuildResourceValidator,
  testChannel,
  testRole,
} from "./helpers/guild-resource-validator";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

function createValidator() {
  return createStaticGuildResourceValidator({
    guilds: {
      "guild-1": {
        channels: [
          testChannel("own-text", 0, "guild-1"),
          testChannel("own-voice", 2, "guild-1"),
          testChannel("own-forum", 15, "guild-1"),
          testChannel("own-category", 4, "guild-1"),
        ],
        roles: [testRole("own-role")],
      },
      "guild-2": {
        channels: [
          testChannel("foreign-text", 0, "guild-2"),
          testChannel("foreign-voice", 2, "guild-2"),
          testChannel("foreign-forum", 15, "guild-2"),
          testChannel("foreign-category", 4, "guild-2"),
        ],
        roles: [testRole("foreign-role")],
      },
    },
  });
}

for (const feature of ["lfg", "marketplace"] as const) {
  test(`${feature} disable requires Guild write access and preserves other Guilds`, async () => {
    const fixture = createProductionRuntimeStores();
    const lfg = {
      ...createDefaultLfgConfig("guild-1"),
      noticeChannelId: "own-text",
      noticeMessageId: "notice-1",
    };
    const market = {
      ...createDefaultMarketplaceConfig("guild-1"),
      noticeChannelId: "own-text",
      noticeMessageId: "notice-1",
    };
    let discordCalls = 0;
    const discord = {
      ...createEventDiscordCounter().api,
      async deleteChannelMessage() {
        discordCalls += 1;
      },
      async createUserDmMessage() {
        throw new Error("Unexpected DM");
      },
      async addGuildMemberRole() {},
      async removeGuildMemberRole() {},
      async modifyChannel() {},
    };
    try {
      await fixture.stores.lfg.upsertLfgConfig(lfg);
      await fixture.stores.marketplace.upsertMarketplaceConfig(market);
      await fixture.stores.lfg.upsertLfgConfig({ ...lfg, guildId: "guild-2" });
      await fixture.stores.marketplace.upsertMarketplaceConfig({ ...market, guildId: "guild-2" });
      const validator = createValidator();
      let authorized = false;
      const handler = createAdminApiHandler({
        stores: fixture.stores,
        discordBotToken: "token",
        guildResources: validator,
        services: {
          lfgService: new LfgService(fixture.stores.lfg, discord, undefined, undefined, validator),
          marketplaceService: new MarketplaceService(
            fixture.stores.marketplace,
            discord,
            undefined,
            validator,
          ),
        },
        adminAccess: {
          async authorize(_request, requirement) {
            assert.equal(requirement.guildId, "guild-1");
            assert.equal(requirement.mode, "write");
            return authorized
              ? { ok: true }
              : { ok: false, error: { _tag: "Forbidden", message: "Forbidden" } };
          },
        },
      });
      const url = new URL(`https://example.com/admin/api/${feature}/disable`);
      const request = () =>
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ guildId: "guild-1" }),
        });
      assert.equal((await handler(request(), url))?.status, 403);
      assert.equal(
        (await fixture.stores.lfg.readLfgConfig("guild-1"))?.noticeChannelId,
        "own-text",
      );
      assert.equal(
        (await fixture.stores.marketplace.readMarketplaceConfig("guild-1"))?.noticeChannelId,
        "own-text",
      );
      assert.equal(discordCalls, 0);
      authorized = true;
      const response = await handler(request(), url);
      assert.equal(response?.status, 200);
      const body = (await response!.json()) as {
        config: { noticeChannelId: string | null; enabled?: boolean };
        noticeRemoved: boolean;
      };
      assert.equal(body.config.noticeChannelId, "own-text");
      assert.equal(body.config.enabled, false);
      assert.equal(body.noticeRemoved, true);
      assert.equal(discordCalls, 1);
      assert.equal(
        (await fixture.stores.lfg.readLfgConfig("guild-2"))?.noticeChannelId,
        "own-text",
      );
      assert.equal(
        (await fixture.stores.marketplace.readMarketplaceConfig("guild-2"))?.noticeChannelId,
        "own-text",
      );
      const otherConfig =
        feature === "lfg"
          ? await fixture.stores.marketplace.readMarketplaceConfig("guild-1")
          : await fixture.stores.lfg.readLfgConfig("guild-1");
      assert.equal(otherConfig?.noticeChannelId, "own-text");
    } finally {
      fixture.close();
    }
  });
}

for (const feature of ["lfg", "marketplace"] as const) {
  for (const boundary of ["delete notice", "create notice"] as const) {
    test(`${feature} automatic refresh cannot undo disable during Discord ${boundary}`, async () => {
      const fixture = createProductionRuntimeStores();
      let createdMessages = 0;
      const deletedMessages: string[] = [];
      let disabled = false;
      const discord = {
        async createChannelMessage(channelId: string) {
          createdMessages += 1;
          if (createdMessages === 2 && boundary === "create notice") {
            disabled = true;
            await service.disable("guild-1");
          }
          return {
            id: createdMessages === 1 ? "post-message" : "losing-notice",
            channel_id: channelId,
            content: "",
          };
        },
        async deleteChannelMessage(_channelId: string, messageId: string) {
          deletedMessages.push(messageId);
          if (!disabled && boundary === "delete notice") {
            disabled = true;
            await service.disable("guild-1");
          }
        },
        async editChannelMessage() {
          throw new Error("Unexpected edit");
        },
        async createUserDmMessage() {
          throw new Error("Unexpected DM");
        },
        async addGuildMemberRole() {},
        async removeGuildMemberRole() {},
        async modifyChannel() {},
      };
      const service =
        feature === "lfg"
          ? new LfgService(fixture.stores.lfg, discord)
          : new MarketplaceService(fixture.stores.marketplace, discord);
      try {
        await fixture.stores.lfg.upsertLfgConfig({
          ...createDefaultLfgConfig("guild-1"),
          noticeChannelId: "own-text",
          noticeMessageId: "old-notice",
        });
        await fixture.stores.marketplace.upsertMarketplaceConfig({
          ...createDefaultMarketplaceConfig("guild-1"),
          noticeChannelId: "own-text",
          noticeMessageId: "old-notice",
          serverChoiceEnabled: false,
        });
        const post = await service.createPost({
          guildId: "guild-1",
          channelId: "own-text",
          ownerId: "owner-1",
          ownerDisplayName: "Owner",
          serverId: "server",
          whenPlay: "Tonight",
          lookingFor: "Squad",
          extraInfo: "",
          tradeType: "have",
          have: "Sword",
          want: "Shield",
          extra: "",
        });
        assert.equal(post.active, true);
        assert.equal(createdMessages, 2);
        assert.equal(disabled, true);
        const config = await service.getConfig("guild-1");
        assert.equal(config.noticeChannelId, "own-text");
        assert.equal(config.enabled, false);
        assert.equal(config.noticeMessageId, null);
        assert.ok(
          deletedMessages.includes("losing-notice"),
          "discard the notice created by the losing refresh",
        );
      } finally {
        fixture.close();
      }
    });
  }
}

function createMemberVerificationSecurityService(
  fixture: ReturnType<typeof createProductionRuntimeStores>,
  guildResources: ReturnType<typeof createValidator>,
  onDiscordMutation: () => void = () => {},
) {
  return createMemberVerificationService({
    store: fixture.stores.memberVerification,
    guildEntitlementStore: fixture.stores.guildEntitlements,
    guildResources,
    discordBotToken: "token",
    addGuildMemberRole: async () => onDiscordMutation(),
    guildMemberHasRole: async () => false,
    resolveGuildName: async () => "Guild One",
    sendUserDm: async () => {
      onDiscordMutation();
      return { id: "dm-message", channel_id: "dm-channel", content: "" };
    },
    createChannelMessage: async (channelId) => {
      onDiscordMutation();
      return { id: "panel-message", channel_id: channelId, content: "" };
    },
    editChannelMessage: async () => onDiscordMutation(),
    configurationRevisions: fixture.stores.configurationRevisions,
  });
}

function createDefaultLfgConfig(guildId: string) {
  return {
    guildId,
    noticeChannelId: null,
    noticeMessageId: null,
    notificationRoleId: null,
    noticeColor: 0x2b2d31,
    counterVoiceChannelId: null,
    counterDisplayFormat: "LFG ({count})",
    approvalFlowEnabled: false,
    approvalAuditChannelId: null,
    approvalVoiceCategoryId: null,
    expiryAction: "close" as const,
    expiryDurationHours: 24,
    serverOptions: [{ id: "server", label: "Server", emoji: null }],
    updatedAtMs: 1,
  };
}

function seedPremiumEntitlement(fixture: ReturnType<typeof createProductionRuntimeStores>) {
  fixture.database.execRaw(
    "INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ('guild-1', 'premium', 1)",
  );
}

function createEventDiscordCounter() {
  let calls = 0;
  return {
    api: {
      async createChannelMessage(channelId: string) {
        calls += 1;
        return { id: "message-1", channel_id: channelId, content: "" };
      },
      async editChannelMessage(channelId: string, messageId: string) {
        calls += 1;
        return { id: messageId, channel_id: channelId, content: "" };
      },
      async createThread() {
        calls += 1;
        return { id: "thread-1" };
      },
      async addThreadMember() {
        calls += 1;
      },
      async removeThreadMember() {
        calls += 1;
      },
      async addGuildMemberRole() {
        calls += 1;
      },
      async removeGuildMemberRole() {
        calls += 1;
      },
    },
    calls: () => calls,
  };
}

test("Suggestions config rejects foreign Guild resources with generic HTTP 400", async () => {
  const fixture = createProductionRuntimeStores();
  try {
    const service = new SuggestionService(fixture.stores.suggestions!);
    const handler = createAdminApiHandler({
      stores: fixture.stores,
      discordBotToken: "token",
      guildResources: createValidator(),
      services: { suggestionService: service },
    });
    const config = {
      ...defaultSuggestionsConfig("guild-1", 1),
      enabled: true,
      forumChannelId: "foreign-forum",
      panelChannelId: "own-text",
      prompts: [{ id: "change", label: "What should change?", required: true }],
    };

    const response = await handler(
      new Request("https://example.com/admin/api/suggestions/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      }),
      new URL("https://example.com/admin/api/suggestions/config"),
    );

    assert.equal(response?.status, 400);
    const body = (await response!.json()) as { error: string };
    assert.equal(body.error, "Invalid Discord resource.");
    assert.equal(body.error.includes("foreign-forum"), false);
    assert.equal(await fixture.stores.suggestions!.readConfig("guild-1"), null);
  } finally {
    fixture.close();
  }
});

test("Suggestions publish revalidates persisted resources before Discord", async () => {
  const fixture = createProductionRuntimeStores();
  let discordCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    discordCalls += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    const config = {
      ...defaultSuggestionsConfig("guild-1", 1),
      enabled: true,
      forumChannelId: "own-forum",
      panelChannelId: "foreign-text",
    };
    await fixture.stores.suggestions!.upsertConfig(config);
    const service = new SuggestionService(fixture.stores.suggestions!);
    const handler = createAdminApiHandler({
      stores: fixture.stores,
      discordBotToken: "token",
      guildResources: createValidator(),
      services: { suggestionService: service },
    });

    const response = await handler(
      new Request("https://example.com/admin/api/suggestions/panel/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1" }),
      }),
      new URL("https://example.com/admin/api/suggestions/panel/publish"),
    );

    assert.equal(response?.status, 400);
    assert.equal(discordCalls, 0);
    assert.deepEqual(await fixture.stores.suggestions!.readConfig("guild-1"), config);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

test("Member Verification config rejects a foreign role before persistence", async () => {
  const fixture = createProductionRuntimeStores();
  try {
    const guildResources = createValidator();
    const handler = createAdminApiHandler({
      stores: fixture.stores,
      discordBotToken: "token",
      guildResources,
      services: {
        memberVerificationService: createMemberVerificationSecurityService(fixture, guildResources),
      },
    });

    const response = await handler(
      new Request("https://example.com/admin/api/member-verification/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          enabled: false,
          verifiedRoleId: "foreign-role",
        }),
      }),
      new URL("https://example.com/admin/api/member-verification/config"),
    );

    assert.equal(response?.status, 400);
    assert.equal(await fixture.stores.memberVerification.readConfig("guild-1"), null);
  } finally {
    fixture.close();
  }
});

test("Member Verification channel save rejects a foreign channel before Discord or persistence", async () => {
  const fixture = createProductionRuntimeStores();
  let discordCalls = 0;
  try {
    const guildResources = createValidator();
    const handler = createAdminApiHandler({
      stores: fixture.stores,
      discordBotToken: "token",
      guildResources,
      services: {
        memberVerificationService: createMemberVerificationSecurityService(
          fixture,
          guildResources,
          () => {
            discordCalls += 1;
          },
        ),
      },
    });

    const response = await handler(
      new Request("https://example.com/admin/api/member-verification/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          enabled: true,
          verifiedRoleId: "own-role",
          deliveryMode: "channel",
          verificationMethod: "discord-button",
          welcomeChannelId: "foreign-text",
        }),
      }),
      new URL("https://example.com/admin/api/member-verification/config"),
    );

    assert.equal(response?.status, 400);
    assert.equal(discordCalls, 0);
    assert.equal(await fixture.stores.memberVerification.readConfig("guild-1"), null);
  } finally {
    fixture.close();
  }
});

test("Timed Role config rejects a foreign role with HTTP 400 before persistence", async () => {
  const fixture = createProductionRuntimeStores();
  try {
    const validator = createValidator();
    const service = new TimedRoleService(fixture.stores.timedRoles, "token", validator);
    const handler = createAdminApiHandler({
      stores: fixture.stores,
      discordBotToken: "token",
      guildResources: validator,
      adminRouteServices: { timedRoleService: service } as never,
    });

    const response = await handler(
      new Request("https://example.com/admin/api/timed-roles/new-member-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          roles: [{ roleId: "foreign-role", durationInput: "1h", dmMessage: null }],
        }),
      }),
      new URL("https://example.com/admin/api/timed-roles/new-member-config"),
    );

    assert.equal(response?.status, 400);
    const config = await fixture.stores.timedRoles.readNewMemberTimedRoleConfig?.("guild-1");
    assert.deepEqual(config?.roles ?? [], []);
  } finally {
    fixture.close();
  }
});

test("Timed Role assignment rejects a foreign role before Discord or persistence", async () => {
  const fixture = createProductionRuntimeStores();
  let discordCalls = 0;
  try {
    const validator = createValidator();
    const service = new TimedRoleService(
      fixture.stores.timedRoles,
      "token",
      validator,
      async () => {
        discordCalls += 1;
      },
    );
    const handler = createAdminApiHandler({
      stores: fixture.stores,
      discordBotToken: "token",
      guildResources: validator,
      adminRouteServices: { timedRoleService: service } as never,
    });

    const response = await handler(
      new Request("https://example.com/admin/api/timed-roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          action: "add",
          userId: "user-1",
          roleId: "foreign-role",
          duration: "1h",
        }),
      }),
      new URL("https://example.com/admin/api/timed-roles"),
    );

    assert.equal(response?.status, 400);
    assert.equal(discordCalls, 0);
    assert.deepEqual(await fixture.stores.timedRoles.listTimedRolesByGuild("guild-1"), []);
  } finally {
    fixture.close();
  }
});

test("Marketplace config and publish reject foreign channels with HTTP 400", async () => {
  const fixture = createProductionRuntimeStores();
  let discordCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    discordCalls += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    const handler = createAdminApiHandler({
      stores: fixture.stores,
      discordBotToken: "token",
      guildResources: createValidator(),
    });
    const foreignConfig = {
      ...createDefaultMarketplaceConfig("guild-1"),
      noticeChannelId: "foreign-text",
    };
    const saveResponse = await handler(
      new Request("https://example.com/admin/api/marketplace/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(foreignConfig),
      }),
      new URL("https://example.com/admin/api/marketplace/config"),
    );
    assert.equal(saveResponse?.status, 400);
    assert.equal(await fixture.stores.marketplace.readMarketplaceConfig("guild-1"), null);
    assert.equal(discordCalls, 0);

    const saved = {
      ...createDefaultMarketplaceConfig("guild-1"),
      noticeChannelId: "own-text",
    };
    await fixture.stores.marketplace.upsertMarketplaceConfig(saved);
    const publishResponse = await handler(
      new Request("https://example.com/admin/api/marketplace/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1", channelId: "foreign-text" }),
      }),
      new URL("https://example.com/admin/api/marketplace/publish"),
    );
    assert.equal(publishResponse?.status, 400);
    assert.equal(discordCalls, 0);
    assert.deepEqual(await fixture.stores.marketplace.readMarketplaceConfig("guild-1"), saved);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

test("LFG config and publish reject foreign channels with HTTP 400", async () => {
  const fixture = createProductionRuntimeStores();
  let discordCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    discordCalls += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    const handler = createAdminApiHandler({
      stores: fixture.stores,
      discordBotToken: "token",
      guildResources: createValidator(),
    });
    const foreignConfig = {
      ...createDefaultLfgConfig("guild-1"),
      noticeChannelId: "foreign-text",
    };
    const saveResponse = await handler(
      new Request("https://example.com/admin/api/lfg/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(foreignConfig),
      }),
      new URL("https://example.com/admin/api/lfg/config"),
    );
    assert.equal(saveResponse?.status, 400);
    assert.equal(await fixture.stores.lfg.readLfgConfig("guild-1"), null);
    assert.equal(discordCalls, 0);

    const saved = { ...createDefaultLfgConfig("guild-1"), noticeChannelId: "own-text" };
    await fixture.stores.lfg.upsertLfgConfig(saved);
    const publishResponse = await handler(
      new Request("https://example.com/admin/api/lfg/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1", channelId: "foreign-text" }),
      }),
      new URL("https://example.com/admin/api/lfg/publish"),
    );
    assert.equal(publishResponse?.status, 400);
    assert.equal(discordCalls, 0);
    assert.deepEqual(await fixture.stores.lfg.readLfgConfig("guild-1"), saved);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

test("Event create rejects a foreign channel with HTTP 400 before persistence", async () => {
  const fixture = createProductionRuntimeStores();
  seedPremiumEntitlement(fixture);
  const discord = createEventDiscordCounter();
  try {
    const validator = createValidator();
    const service = new EventsService(
      fixture.stores.events,
      discord.api,
      undefined,
      undefined,
      undefined,
      validator,
    );
    const handler = createAdminApiHandler({
      stores: fixture.stores,
      discordBotToken: "token",
      guildResources: validator,
      services: { eventsService: service },
    });

    const response = await handler(
      new Request("https://example.com/admin/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          templateId: null,
          title: "Foreign event",
          description: "Must not persist",
          channelId: "foreign-text",
          startsAtMs: Date.now() + 60_000,
          endsAtMs: null,
          signupCutoffAtMs: null,
          signupMode: "single_choice",
          threadEnabled: false,
          waitlistedMembersJoinThread: false,
          groups: [
            {
              id: "group-1",
              label: "Group",
              emoji: null,
              capacity: null,
              waitlistEnabled: false,
              allowedRoleIds: [],
              blockedRoleIds: [],
              grantRoleId: null,
            },
          ],
          reminders: [],
        }),
      }),
      new URL("https://example.com/admin/api/events"),
    );

    assert.equal(response?.status, 400);
    const body = (await response!.json()) as { error: string };
    assert.equal(body.error, "Invalid Discord resource.");
    assert.equal(body.error.includes("foreign-text"), false);
    assert.deepEqual(await fixture.stores.events.listEvents("guild-1"), []);
    assert.equal(discord.calls(), 0);
  } finally {
    fixture.close();
  }
});

test("Event publish rejects a persisted foreign channel with HTTP 400 before Discord", async () => {
  const fixture = createProductionRuntimeStores();
  seedPremiumEntitlement(fixture);
  const discord = createEventDiscordCounter();
  try {
    const event = {
      guildId: "guild-1",
      id: "event-foreign",
      templateId: null,
      title: "Foreign event",
      description: "Must not publish",
      status: "draft" as const,
      channelId: "foreign-text",
      messageId: null,
      threadId: null,
      startsAtMs: Date.now() + 60_000,
      endsAtMs: null,
      signupCutoffAtMs: Date.now() + 60_000,
      signupMode: "single_choice" as const,
      participationMode: "individual" as const,
      requiredTeamSize: null,
      threadEnabled: false,
      waitlistedMembersJoinThread: false,
      groups: [
        {
          id: "group-1",
          label: "Group",
          emoji: null,
          capacity: null,
          waitlistEnabled: false,
          allowedRoleIds: [],
          blockedRoleIds: [],
          grantRoleId: null,
        },
      ],
      reminders: [],
      createdAtMs: 1,
      updatedAtMs: 1,
      publishedAtMs: null,
      cancelledAtMs: null,
      endedAtMs: null,
      archivedAtMs: null,
    };
    await fixture.stores.events.upsertEvent(event);
    const validator = createValidator();
    const service = new EventsService(
      fixture.stores.events,
      discord.api,
      undefined,
      undefined,
      undefined,
      validator,
    );
    const handler = createAdminApiHandler({
      stores: fixture.stores,
      discordBotToken: "token",
      guildResources: validator,
      services: { eventsService: service },
    });

    const response = await handler(
      new Request("https://example.com/admin/api/events/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1", eventId: event.id }),
      }),
      new URL("https://example.com/admin/api/events/publish"),
    );

    assert.equal(response?.status, 400);
    assert.equal(discord.calls(), 0);
    assert.deepEqual(await fixture.stores.events.readEvent("guild-1", event.id), event);
  } finally {
    fixture.close();
  }
});

test("Player Count save rejects a foreign voice channel with HTTP 400 before persistence", async () => {
  const fixture = createProductionRuntimeStores();
  seedPremiumEntitlement(fixture);
  try {
    const handler = createAdminApiHandler({
      stores: fixture.stores,
      discordBotToken: "token",
      guildResources: createValidator(),
    });

    const response = await handler(
      new Request("https://example.com/admin/api/player-count/server", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          name: "Foreign server",
          provider: "steam-web",
          providerServerId: "127.0.0.1:27015",
          channelId: "foreign-voice",
          alertChannelId: null,
        }),
      }),
      new URL("https://example.com/admin/api/player-count/server"),
    );

    assert.equal(response?.status, 400);
    assert.deepEqual(await fixture.stores.playerCount.listPlayerCountServers("guild-1"), []);
  } finally {
    fixture.close();
  }
});

test("Ticket save rejects a foreign channel with HTTP 400 before persistence or Discord", async () => {
  const fixture = createProductionRuntimeStores();
  let discordCalls = 0;
  try {
    const validator = createValidator();
    const service = createTicketPanelService({
      store: fixture.stores.tickets,
      entitlements: fixture.stores.guildEntitlements,
      guildResources: validator,
      discord: {
        async publish() {
          discordCalls += 1;
          return "message-1";
        },
        async deleteMessage() {
          discordCalls += 1;
        },
        async recordConfigChange() {
          discordCalls += 1;
        },
      },
    });
    const handler = createAdminApiHandler({
      stores: fixture.stores,
      discordBotToken: "token",
      guildResources: validator,
      services: { ticketPanelService: service },
    });

    const response = await handler(
      new Request("https://example.com/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          panelId: "panel-1",
          panelName: "Support",
          panelChannelId: "foreign-text",
          categoryChannelId: "own-category",
          transcriptChannelId: "own-text",
          panelMessageId: null,
          ticketTypes: [
            {
              id: "support",
              label: "Support",
              emoji: null,
              buttonStyle: "primary",
              supportRoleId: "own-role",
              allowedCreatorRoleIds: [],
              channelNamePrefix: "ticket",
              questions: [],
            },
          ],
        }),
      }),
      new URL("https://example.com/admin/api/tickets/panel"),
    );

    assert.equal(response?.status, 400);
    assert.deepEqual(await fixture.stores.tickets.listTicketPanelConfigs?.("guild-1"), []);
    assert.equal(discordCalls, 0);
  } finally {
    fixture.close();
  }
});

for (const feature of ["blocklist", "evidence-vault", "player-link", "player-count"] as const) {
  test(`${feature} availability requires Guild write access and retains saved settings`, async () => {
    const fixture = createProductionRuntimeStores();
    const config = {
      guildId: "guild-1",
      platform: "steam" as const,
      linkedRoleId: "own-role",
      logChannelId: null,
      gameAppIds: [],
      panelTitle: "Link",
      panelDescription: "Link account",
      panelButtonLabel: "Link",
      panelButtonStyle: "Primary",
      allowRelink: false,
      allowMultipleLinks: false,
      requireRelinkOnRejoin: false,
      whoisFields: [],
      customLinks: [],
      panelChannelId: "own-text",
      panelMessageId: "panel",
      updatedAtMs: 1,
    };
    const playerCount = {
      id: "server-1",
      guildId: "guild-1",
      name: "Server",
      provider: "steam-web" as const,
      providerServerId: "127.0.0.1:27015",
      channelId: "own-voice",
      alertChannelId: null,
      refreshIntervalMinutes: 10,
      displayFormat: "{count}/{max}",
      offlineFormat: "Offline",
      failureThreshold: 3,
      renameOffsetMinutes: 0,
      lastRenamedAtMs: null,
      lastPlayerCount: 12,
      lastMaxSlots: 60,
      lastQueueSize: 0,
      lastFetchedAtMs: 1,
      steamHost: "127.0.0.1",
      steamPort: 27015,
      consecutiveFailureCount: 0,
      lastErrorMessage: null,
      lastErrorAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    try {
      await fixture.stores.blocklist.applyGuildEmojiMutation({
        guildId: "guild-1",
        emoji: "🚫",
        action: "add",
      });
      await fixture.stores.evidenceVault.upsertConfig({
        guildId: "guild-1",
        auditChannelId: "own-text",
        accessRoleIds: ["own-role"],
        subjectsEnabled: true,
        updatedAtMs: 1,
      });
      await fixture.stores.platformLink.upsertPlatformLinkConfig(config);
      await fixture.stores.playerCount.upsertPlayerCountServer(playerCount);
      await fixture.stores.playerCount.upsertPlayerCountServer({
        ...playerCount,
        id: "foreign",
        guildId: "guild-2",
      });
      let authorized = false;
      const handler = createAdminApiHandler({
        stores: fixture.stores,
        discordBotToken: "token",
        adminRouteServices: {
          blocklistService: new BlocklistService(fixture.stores.blocklist),
        } as never,
        adminAccess: {
          async authorize(_request, requirement) {
            assert.equal(requirement.mode, "write");
            assert.equal(requirement.guildId, "guild-1");
            return authorized
              ? { ok: true }
              : { ok: false, error: { _tag: "Forbidden", message: "Forbidden" } };
          },
        },
      });
      const url = new URL(`https://example.com/admin/api/${feature}/enabled`);
      const request = (enabled: unknown, id = "server-1") =>
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ guildId: "guild-1", enabled, platform: "steam", id }),
        });
      assert.equal((await handler(request(false), url))?.status, 403);
      authorized = true;
      assert.equal((await handler(request("false"), url))?.status, 400);
      assert.equal((await handler(request(false), url))?.status, 200);
      const readEnabled = async () =>
        feature === "blocklist"
          ? (await fixture.stores.blocklist.readGuildConfig("guild-1")).guilds["guild-1"]?.enabled
          : feature === "evidence-vault"
            ? (await fixture.stores.evidenceVault.readConfig("guild-1"))?.enabled
            : feature === "player-link"
              ? (await fixture.stores.platformLink.readPlatformLinkConfig("guild-1", "steam"))
                  ?.enabled
              : (await fixture.stores.playerCount.readPlayerCountServer("server-1"))?.enabled;
      assert.equal(await readEnabled(), false);
      assert.equal(
        (await fixture.stores.blocklist.readGuildConfig("guild-1")).guilds["guild-1"]?.emojis[0],
        "🚫",
      );
      assert.equal(
        (await fixture.stores.evidenceVault.readConfig("guild-1"))?.auditChannelId,
        "own-text",
      );
      assert.equal(
        (await fixture.stores.platformLink.readPlatformLinkConfig("guild-1", "steam"))
          ?.panelMessageId,
        "panel",
      );
      assert.equal(
        (await fixture.stores.playerCount.readPlayerCountServer("server-1"))?.lastPlayerCount,
        12,
      );
      if (feature === "player-count") {
        assert.equal((await handler(request(false, "foreign"), url))?.status, 404);
        assert.notEqual(
          (await fixture.stores.playerCount.readPlayerCountServer("foreign"))?.enabled,
          false,
        );
      }
      assert.equal((await handler(request(true), url))?.status, 200);
      assert.notEqual(await readEnabled(), false);
    } finally {
      fixture.close();
    }
  });
}
