/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createAdminApiHandler } from "./helpers/admin-api";
import { createTestConfigurationRevisionCoordinator } from "./support/configuration-revision-store";
import type { RuntimeStores } from "../src/runtime/app-types";
import type { MentionProtectionConfig } from "../src/types";
import { createDefaultMentionProtectionConfig } from "../src/services/mention-protection/message-handler";

test("Mention Protection admin API saves and reads the complete premium Guild configuration", async () => {
  let stored: MentionProtectionConfig | null = null;
  const handler = createAdminApiHandler({
    stores: createStores({
      readConfig: async () => stored,
      upsertConfig: async (config) => {
        stored = config;
      },
    }),
    discordBotToken: "token",
  });
  const restore = mockDiscordResources();

  const payload = {
    guildId: "guild-1",
    adminEnabled: true,
    spamEnabled: true,
    protectedAdminRoleIds: ["admin-role"],
    channelMode: "include",
    channelIds: ["channel-1"],
    excludedRoleIds: ["trusted-role"],
    massMentionThreshold: 7,
    burstMessageThreshold: 4,
    burstWindowSeconds: 20,
    adminRepeatPeriodMs: 3_600_000,
    spamRepeatPeriodMs: 86_400_000,
    adminInitialResponse: policy(true, false),
    adminRepeatResponse: policy(true, true, { type: "timeout", durationMs: 600_000 }),
    spamInitialResponse: policy(true, true),
    spamRepeatResponse: policy(true, true, {
      type: "timed-role",
      roleId: "restricted-role",
      durationMs: 3_600_000,
    }),
  };

  try {
    const saved = await handler(
      new Request("https://example.com/admin/api/mention-protection/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      new URL("https://example.com/admin/api/mention-protection/config"),
    );
    assert.equal(saved?.status, 200);
    const savedBody = (await saved?.json()) as { config: MentionProtectionConfig };
    assert.deepEqual(omitTimestamps(savedBody.config), payload);

    const read = await handler(
      new Request("https://example.com/admin/api/mention-protection?guildId=guild-1"),
      new URL("https://example.com/admin/api/mention-protection?guildId=guild-1"),
    );
    assert.equal(read?.status, 200);
    assert.deepEqual((await read?.json()) as unknown, {
      guildId: "guild-1",
      config: savedBody.config,
    });
  } finally {
    restore();
  }
});

test("Free saves fresh defaults while retained paid restrictions survive downgrade and re-upgrade", async () => {
  let stored: MentionProtectionConfig | null = null;
  let tier: "free" | "premium" = "free";
  const handler = createAdminApiHandler({
    stores: createStores(
      {
        readConfig: async () => stored ?? createDefaultMentionProtectionConfig("guild-1", 1_000),
        upsertConfig: async (config) => {
          stored = config;
        },
      },
      () => tier,
    ),
    discordBotToken: "token",
  });
  const restore = mockDiscordResources();
  const fresh = createDefaultMentionProtectionConfig("guild-1", 1_000);
  fresh.adminEnabled = true;
  fresh.protectedAdminRoleIds = ["admin-role"];
  const freshPayload = omitTimestamps(fresh);

  try {
    assert.deepEqual(fresh.adminRepeatResponse, policy(true, true));
    const saved = await handler(
      new Request("https://example.com/admin/api/mention-protection/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(freshPayload),
      }),
      new URL("https://example.com/admin/api/mention-protection/config"),
    );
    assert.equal(saved?.status, 200);

    const readFresh = await handler(
      new Request("https://example.com/admin/api/mention-protection?guildId=guild-1"),
      new URL("https://example.com/admin/api/mention-protection?guildId=guild-1"),
    );
    assert.equal(readFresh?.status, 200);
    assert.ok(readFresh);
    const freshBody = (await readFresh.json()) as { config: MentionProtectionConfig };
    assert.deepEqual(omitTimestamps(freshBody.config), freshPayload);

    const retainedTimeout = { type: "timeout" as const, durationMs: 600_000 };
    tier = "premium";
    const paidSave = await handler(
      new Request("https://example.com/admin/api/mention-protection/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...freshPayload,
          adminRepeatResponse: policy(true, true, retainedTimeout),
        }),
      }),
      new URL("https://example.com/admin/api/mention-protection/config"),
    );
    assert.equal(paidSave?.status, 200);
    assert.ok(paidSave);
    const retainedPayload = omitTimestamps(
      ((await paidSave.json()) as { config: MentionProtectionConfig }).config,
    );
    tier = "free";
    const edited = await handler(
      new Request("https://example.com/admin/api/mention-protection/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...retainedPayload,
          adminInitialResponse: { ...retainedPayload.adminInitialResponse, delete: false },
        }),
      }),
      new URL("https://example.com/admin/api/mention-protection/config"),
    );
    assert.equal(edited?.status, 200);
    assert.ok(edited);
    const editedConfig = ((await edited.json()) as { config: MentionProtectionConfig }).config;
    assert.equal(editedConfig.adminInitialResponse.delete, false);
    assert.deepEqual(editedConfig.adminRepeatResponse.restriction, retainedTimeout);

    const readFree = await handler(
      new Request("https://example.com/admin/api/mention-protection?guildId=guild-1"),
      new URL("https://example.com/admin/api/mention-protection?guildId=guild-1"),
    );
    assert.ok(readFree);
    assert.deepEqual(
      ((await readFree.json()) as { config: MentionProtectionConfig }).config.adminRepeatResponse
        .restriction,
      retainedTimeout,
    );

    tier = "premium";
    const readPremium = await handler(
      new Request("https://example.com/admin/api/mention-protection?guildId=guild-1"),
      new URL("https://example.com/admin/api/mention-protection?guildId=guild-1"),
    );
    assert.ok(readPremium);
    assert.deepEqual(
      ((await readPremium.json()) as { config: MentionProtectionConfig }).config.adminRepeatResponse
        .restriction,
      retainedTimeout,
    );
  } finally {
    restore();
  }
});

test("disabled Mention Protection sections may preserve actionless policies", async () => {
  let stored: MentionProtectionConfig | null = null;
  const handler = createAdminApiHandler({
    stores: createStores({
      readConfig: async () => stored,
      upsertConfig: async (config) => {
        stored = config;
      },
    }),
    discordBotToken: "token",
  });
  const restore = mockDiscordResources();
  const noAction = policy(false, false);
  try {
    const response = await handler(
      new Request("https://example.com/admin/api/mention-protection/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          adminEnabled: false,
          spamEnabled: false,
          protectedAdminRoleIds: [],
          channelMode: "exclude",
          channelIds: [],
          excludedRoleIds: [],
          massMentionThreshold: 5,
          burstMessageThreshold: 5,
          burstWindowSeconds: 10,
          adminRepeatPeriodMs: 60_000,
          spamRepeatPeriodMs: 60_000,
          adminInitialResponse: noAction,
          adminRepeatResponse: noAction,
          spamInitialResponse: noAction,
          spamRepeatResponse: noAction,
        }),
      }),
      new URL("https://example.com/admin/api/mention-protection/config"),
    );

    assert.equal(response?.status, 200);
    const body = (await response?.json()) as { config: MentionProtectionConfig };
    assert.equal(body.config.adminInitialResponse.reply, false);
  } finally {
    restore();
  }
});

test("Free configures Admin Mention Protection while paid controls remain dormant", async () => {
  const retained: MentionProtectionConfig = {
    guildId: "guild-1",
    adminEnabled: true,
    spamEnabled: true,
    protectedAdminRoleIds: ["admin-role"],
    channelMode: "exclude",
    channelIds: [],
    excludedRoleIds: ["trusted-role"],
    massMentionThreshold: 5,
    burstMessageThreshold: 5,
    burstWindowSeconds: 10,
    adminRepeatPeriodMs: 60_000,
    spamRepeatPeriodMs: 60_000,
    adminInitialResponse: policy(true, false),
    adminRepeatResponse: policy(true, false, { type: "timeout", durationMs: 600_000 }),
    spamInitialResponse: policy(true, true),
    spamRepeatResponse: policy(true, true, {
      type: "timed-role",
      roleId: "restricted-role",
      durationMs: 3_600_000,
    }),
    createdAtMs: 1,
    updatedAtMs: 2,
  };
  let stored = retained;
  const handler = createAdminApiHandler({
    stores: createStores(
      {
        readConfig: async () => stored,
        upsertConfig: async (config) => {
          stored = config;
        },
      },
      "free",
    ),
    discordBotToken: "token",
  });
  const restore = mockDiscordResources();
  const retainedPayload = omitTimestamps(retained);
  try {
    const allowed = await handler(
      new Request("https://example.com/admin/api/mention-protection/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...retainedPayload,
          adminInitialResponse: { ...retainedPayload.adminInitialResponse, delete: true },
        }),
      }),
      new URL("https://example.com/admin/api/mention-protection/config"),
    );
    assert.equal(allowed?.status, 200);
    assert.equal(stored.adminInitialResponse.delete, true);
    assert.equal(stored.spamEnabled, true);
    assert.equal(stored.adminRepeatResponse.restriction.type, "timeout");

    const blockedSpam = await handler(
      new Request("https://example.com/admin/api/mention-protection/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...omitTimestamps(stored), spamEnabled: false }),
      }),
      new URL("https://example.com/admin/api/mention-protection/config"),
    );
    assert.equal(blockedSpam?.status, 402);
    assert.match(JSON.stringify(await blockedSpam?.json()), /Mention Spam Protection/);

    const blockedRestriction = await handler(
      new Request("https://example.com/admin/api/mention-protection/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...omitTimestamps(stored),
          adminRepeatResponse: policy(true, false),
        }),
      }),
      new URL("https://example.com/admin/api/mention-protection/config"),
    );
    assert.equal(blockedRestriction?.status, 402);
    assert.match(JSON.stringify(await blockedRestriction?.json()), /member restrictions/);
  } finally {
    restore();
  }
});

function policy(
  reply: boolean,
  deleteMessage: boolean,
  restriction: MentionProtectionConfig["adminInitialResponse"]["restriction"] = {
    type: "none",
  },
) {
  return { reply, delete: deleteMessage, restriction };
}

function omitTimestamps(config: MentionProtectionConfig) {
  const { createdAtMs: _createdAtMs, updatedAtMs: _updatedAtMs, ...rest } = config;
  return rest;
}

function createStores(
  mentionProtection: {
    readConfig: RuntimeStores["mentionProtection"]["readConfig"];
    upsertConfig: RuntimeStores["mentionProtection"]["upsertConfig"];
  },
  tier: "free" | "premium" | (() => "free" | "premium") = "premium",
): RuntimeStores {
  return {
    configurationRevisions: createTestConfigurationRevisionCoordinator(async (mutation) => {
      if (mutation.next) await mentionProtection.upsertConfig(mutation.next as never);
    }),
    guildEntitlements: {
      readGuildEntitlement: async (guildId: string) => ({
        guildId,
        tier: typeof tier === "function" ? tier() : tier,
        updatedAtMs: 1,
      }),
    },
    mentionProtection: {
      ...mentionProtection,
      deleteConfig: async () => {},
      clearBurstWindow: async () => {},
      recordBurstMessage: async () => 0,
      claimMessageBreaches: async () => [],
      claimAction: async () => "satisfied",
      recordActionOutcome: async () => {},
    },
  } as unknown as RuntimeStores;
}

function mockDiscordResources() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/guilds/guild-1/channels")) {
      return Response.json([{ id: "channel-1", name: "general", type: 0 }]);
    }
    if (url.endsWith("/guilds/guild-1/roles")) {
      return Response.json([
        { id: "admin-role", name: "Admin" },
        { id: "trusted-role", name: "Trusted" },
        { id: "restricted-role", name: "Restricted" },
      ]);
    }
    return new Response("unexpected request", { status: 500 });
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}
