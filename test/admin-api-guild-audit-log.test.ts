/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createAdminApiHandler } from "./helpers/admin-api";
import { createTestConfigurationRevisionCoordinator } from "./support/configuration-revision-store";

test("Guild Audit Log admin API reads config", async () => {
  const stores = createStores({ tier: "premium" }) as any;
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/guild-audit-log?guildId=guild-1"),
    new URL("https://example.com/admin/api/guild-audit-log?guildId=guild-1"),
  );

  assert.equal(response?.status, 200);
  const body = (await response?.json()) as Record<string, unknown>;
  assert.equal(body.guildId, "guild-1");
  assert.ok(body.config);
});

test("Guild Audit Log admin API saves config", async () => {
  const writes: unknown[] = [];
  const stores = createStores({ tier: "premium", writes });
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "token",
  });

  const { restore } = mockDiscordChannels([
    { id: "123456789012345678", name: "audit", type: 0 },
    { id: "123456789012345679", name: "member-log", type: 0 },
  ]);
  try {
    const response = await handler(
      new Request("https://example.com/admin/api/guild-audit-log/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          auditChannelId: "123456789012345678",
          groupChannelIds: { member: "123456789012345679", message: "" },
          eventStates: {
            groups: { member: true, message: false },
            overrides: { "member.nickname-change": false },
          },
        }),
      }),
      new URL("https://example.com/admin/api/guild-audit-log/config"),
    );

    assert.equal(response?.status, 200);
  } finally {
    restore();
  }
  assert.equal(writes.length, 1);
  const write = writes[0] as Record<string, unknown>;
  assert.equal(write.guildId, "guild-1");
  assert.equal(write.auditChannelId, "123456789012345678");
  assert.deepEqual(write.groupChannelIds, { member: "123456789012345679" });
});

test("Guild Audit Log admin API validates and audits Audit Exclusion Policy changes once", async () => {
  let current = {
    guildId: "guild-1",
    auditChannelId: "123456789012345678",
    groupChannelIds: {},
    eventStates: { groups: { "guild-audit-log": false }, overrides: {} },
    excludedChannelIds: [] as string[],
    excludedRoleIds: [] as string[],
    updatedAtMs: 0,
  };
  const stores = createStores({ tier: "premium" }) as any;
  stores.guildAuditLog = {
    readConfig: async () => current,
    upsertConfig: async (config: typeof current) => {
      current = config;
    },
  };
  stores.configurationRevisions = createTestConfigurationRevisionCoordinator((mutation) => {
    if (mutation.next) current = mutation.next as typeof current;
  });
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "token",
    readCustomerAdminSession: async () => ({
      user: { id: "account-1", discordUserId: "777777777777777777", name: "Admin" },
    }),
  });
  const auditBodies: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/guilds/guild-1/channels")) {
      return Response.json([
        { id: "123456789012345678", name: "audit", type: 0 },
        { id: "222222222222222222", name: "private-voice", type: 2 },
      ]);
    }
    if (url.endsWith("/guilds/guild-1/roles")) {
      return Response.json([{ id: "333333333333333333", name: "staff", type: 0 }]);
    }
    if (url.endsWith("/channels/123456789012345678/messages")) {
      auditBodies.push(String(init?.body ?? ""));
      return Response.json({ id: "audit-message-1" });
    }
    return originalFetch(input, init);
  };

  const save = () =>
    handler(
      new Request("https://example.com/admin/api/guild-audit-log/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          auditChannelId: "123456789012345678",
          eventStates: { groups: { "guild-audit-log": false }, overrides: {} },
          excludedChannelIds: ["222222222222222222"],
          excludedRoleIds: ["333333333333333333"],
        }),
      }),
      new URL("https://example.com/admin/api/guild-audit-log/config"),
    );

  try {
    assert.equal((await save())?.status, 200);
    assert.deepEqual(current.excludedChannelIds, ["222222222222222222"]);
    assert.deepEqual(current.excludedRoleIds, ["333333333333333333"]);
    assert.equal(auditBodies.length, 1);
    assert.match(auditBodies[0] ?? "", /777777777777777777/);
    assert.match(auditBodies[0] ?? "", /222222222222222222/);
    assert.match(auditBodies[0] ?? "", /333333333333333333/);

    assert.equal((await save())?.status, 200);
    assert.equal(auditBodies.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Guild Audit Log admin API rejects missing guildId", async () => {
  const stores = createStores({ tier: "premium" });
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/guild-audit-log/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auditChannelId: "123456789012345678" }),
    }),
    new URL("https://example.com/admin/api/guild-audit-log/config"),
  );

  assert.equal(response?.status, 400);
});

test("Guild Audit Log admin API rejects stale channel ids", async () => {
  const stores = createStores({ tier: "premium" });
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "token",
  });
  const { restore } = mockDiscordChannels([{ id: "999999999999999999", name: "other", type: 0 }]);

  try {
    const response = await handler(
      new Request("https://example.com/admin/api/guild-audit-log/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          auditChannelId: "123456789012345678",
          eventStates: { groups: {}, overrides: {} },
        }),
      }),
      new URL("https://example.com/admin/api/guild-audit-log/config"),
    );

    assert.equal(response?.status, 400);
  } finally {
    restore();
  }
});

test("Guild Audit Log admin API rejects stale group channel ids", async () => {
  const stores = createStores({ tier: "premium" });
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "token",
  });
  const { restore } = mockDiscordChannels([{ id: "999999999999999999", name: "other", type: 0 }]);

  try {
    const response = await handler(
      new Request("https://example.com/admin/api/guild-audit-log/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          auditChannelId: "",
          groupChannelIds: { member: "123456789012345678" },
          eventStates: { groups: {}, overrides: {} },
        }),
      }),
      new URL("https://example.com/admin/api/guild-audit-log/config"),
    );

    assert.equal(response?.status, 400);
  } finally {
    restore();
  }
});

test("Guild Audit Log admin API rejects unknown group channel keys", async () => {
  const stores = createStores({ tier: "premium" });
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/guild-audit-log/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        auditChannelId: "",
        groupChannelIds: { madeUpGroup: "123456789012345678" },
        eventStates: { groups: {}, overrides: {} },
      }),
    }),
    new URL("https://example.com/admin/api/guild-audit-log/config"),
  );

  assert.equal(response?.status, 400);
});

test("Guild Audit Log admin API rejects invalid channel ids", async () => {
  const stores = createStores({ tier: "premium" });
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/guild-audit-log/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        auditChannelId: "not-a-channel",
        eventStates: { groups: {}, overrides: {} },
      }),
    }),
    new URL("https://example.com/admin/api/guild-audit-log/config"),
  );

  assert.equal(response?.status, 400);
});

test("Guild Audit Log admin API rejects unknown event state keys", async () => {
  const stores = createStores({ tier: "premium" });
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/guild-audit-log/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        auditChannelId: "123456789012345678",
        eventStates: {
          groups: { madeUpGroup: true },
          overrides: { "member.join": true },
        },
      }),
    }),
    new URL("https://example.com/admin/api/guild-audit-log/config"),
  );

  assert.equal(response?.status, 400);
});

test("Guild Audit Log admin API works for any tier", async () => {
  const stores = createStores({ tier: "free" });
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/guild-audit-log?guildId=guild-1"),
    new URL("https://example.com/admin/api/guild-audit-log?guildId=guild-1"),
  );

  assert.equal(response?.status, 200);
});

test("Guild Audit Log viewers can inspect but cannot change the Audit Exclusion Policy", async () => {
  const handler = createAdminApiHandler({
    stores: createStores({ tier: "free" }),
    discordBotToken: "token",
    adminAccess: {
      authorize(_request, requirement) {
        return requirement.mode === "read"
          ? Promise.resolve({ ok: true as const })
          : Promise.resolve({
              ok: false as const,
              error: { _tag: "Forbidden" as const, message: "Read-only access" },
            });
      },
    },
  });

  const readResponse = await handler(
    new Request("https://example.com/admin/api/guild-audit-log?guildId=guild-1"),
    new URL("https://example.com/admin/api/guild-audit-log?guildId=guild-1"),
  );
  const writeResponse = await handler(
    new Request("https://example.com/admin/api/guild-audit-log/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1", excludedRoleIds: [] }),
    }),
    new URL("https://example.com/admin/api/guild-audit-log/config"),
  );
  const capabilityResponse = await handler(
    new Request("https://example.com/admin/api/guild-audit-log/capabilities?guildId=guild-1"),
    new URL("https://example.com/admin/api/guild-audit-log/capabilities?guildId=guild-1"),
  );

  assert.equal(readResponse?.status, 200);
  assert.equal(writeResponse?.status, 403);
  assert.equal(capabilityResponse?.status, 403);
});

function mockDiscordChannels(channels: Array<{ id: string; name: string; type: number }>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://discord.com/api/v10/guilds/guild-1/channels") {
      return Response.json(channels);
    }
    if (url === "https://discord.com/api/v10/guilds/guild-1/roles") {
      return Response.json([]);
    }
    return originalFetch(input, init);
  };

  return {
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function createStores(options: { tier: "free" | "premium"; writes?: unknown[] }) {
  return {
    configurationRevisions: createTestConfigurationRevisionCoordinator((mutation) => {
      if (mutation.next) options.writes?.push(mutation.next);
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
    guildAuditLog: {
      readConfig: async () => ({
        guildId: "guild-1",
        auditChannelId: "123456789012345678",
        groupChannelIds: {},
        eventStates: { groups: {}, overrides: {} },
        updatedAtMs: 0,
      }),
      upsertConfig: async (config: unknown) => {
        options.writes?.push(config);
      },
    },
  } as never;
}
