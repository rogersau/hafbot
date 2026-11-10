/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import { createAdminApiHandler } from "./helpers/admin-api";
import { getGuildEntitlementLimits } from "../src/types";

test("GET /admin/api/entitlement returns tier, limits, supportInvite, and R2 usage for free guild", async () => {
  const usageCalls: string[] = [];
  const handler = createAdminApiHandler({
    stores: createStores({
      readGuildEntitlement: async (guildId: string) => ({ guildId, tier: "free", updatedAtMs: 0 }),
      getGuildUsageBytes: async (guildId: string) => {
        usageCalls.push(guildId);
        return 12_345;
      },
    }),
    discordBotToken: "token",
    discordSupportInvite: "https://discord.gg/HpRPkdm6dv",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/entitlement?guildId=guild-1"),
    new URL("https://example.com/admin/api/entitlement?guildId=guild-1"),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), {
    tier: "free",
    limits: getGuildEntitlementLimits("free"),
    supportInvite: "https://discord.gg/HpRPkdm6dv",
    r2Usage: {
      usedBytes: 12_345,
      reservedBytes: 0,
      maxBytes: getGuildEntitlementLimits("free").r2MaxBytes,
      lastReconciledAtMs: null,
    },
  });
  assert.deepEqual(usageCalls, ["guild-1"]);
});

test("GET /admin/api/entitlement returns tier, limits, and null supportInvite when not configured", async () => {
  const handler = createAdminApiHandler({
    stores: createStores({
      readGuildEntitlement: async (guildId: string) => ({
        guildId,
        tier: "premium",
        updatedAtMs: 0,
      }),
    }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/entitlement?guildId=guild-1"),
    new URL("https://example.com/admin/api/entitlement?guildId=guild-1"),
  );

  assert.equal(response?.status, 200);
  const body = (await response?.json()) as {
    tier: string;
    limits: unknown;
    supportInvite: unknown;
  };
  assert.equal(body.tier, "premium");
  assert.deepEqual(body.limits, getGuildEntitlementLimits("premium"));
  assert.equal(body.supportInvite, null);
});

test("GET /admin/api/entitlement requires guildId", async () => {
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/entitlement"),
    new URL("https://example.com/admin/api/entitlement"),
  );

  assert.equal(response?.status, 400);
  assert.equal(
    ((await response?.json()) as { error: string } | undefined)?.error,
    "guildId is required",
  );
});

test("GET /admin/api/entitlement returns 401 when authorization fails", async () => {
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: {
      authorize() {
        return Promise.resolve({
          ok: false as const,
          error: { _tag: "Unauthorized" as const, message: "Unauthorized" },
        });
      },
    },
  });

  const response = await handler(
    new Request("https://example.com/admin/api/entitlement?guildId=guild-1"),
    new URL("https://example.com/admin/api/entitlement?guildId=guild-1"),
  );

  assert.equal(response?.status, 401);
  assert.equal(((await response?.json()) as { error: string } | undefined)?.error, "Unauthorized");
});

test("GET /admin/api/entitlement returns 403 when authorization is forbidden", async () => {
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
    adminAccess: {
      authorize() {
        return Promise.resolve({
          ok: false as const,
          error: { _tag: "Forbidden" as const, message: "Forbidden" },
        });
      },
    },
  });

  const response = await handler(
    new Request("https://example.com/admin/api/entitlement?guildId=guild-1"),
    new URL("https://example.com/admin/api/entitlement?guildId=guild-1"),
  );

  assert.equal(response?.status, 403);
  assert.equal(((await response?.json()) as { error: string } | undefined)?.error, "Forbidden");
});

test("GET /admin/api/entitlement returns free tier when guildEntitlements store returns free", async () => {
  const handler = createAdminApiHandler({
    stores: createStores(),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/entitlement?guildId=guild-1"),
    new URL("https://example.com/admin/api/entitlement?guildId=guild-1"),
  );

  assert.equal(response?.status, 200);
  const body = (await response?.json()) as {
    tier: string;
    limits: unknown;
    supportInvite: unknown;
  };
  assert.equal(body.tier, "free");
  assert.deepEqual(body.limits, getGuildEntitlementLimits("free"));
});

function createStores(options?: {
  readGuildEntitlement?: (
    guildId: string,
  ) => Promise<{ guildId: string; tier: "free" | "premium"; updatedAtMs: number }>;
  getGuildUsageBytes?: (guildId: string) => Promise<number>;
}) {
  return {
    blocklist: {
      readConfig: async () => ({ botUserId: "bot-1", guilds: {} }),
    },
    timedRoles: {
      listTimedRolesByGuild: async () => [],
    },
    tickets: {
      readTicketPanelConfig: async () => null,
      upsertTicketPanelConfig: async () => {},
    },
    marketplace: {
      readMarketplaceConfig: async () => null,
      listMarketplacePosts: async () => [],
      listMarketplaceLogs: async () => [],
      upsertMarketplaceConfig: async () => {},
      closeMarketplacePost: async () => null,
    },
    lfg: {
      readLfgConfig: async () => null,
      listLfgPosts: async () => [],
      countActiveLfgPosts: async () => 0,
      upsertLfgConfig: async () => {},
      closeLfgPost: async () => null,
      updateLfgPost: async () => {},
      listDueLfgPostExpiries: async () => [],
      listDueLfgRenewalReminders: async () => [],
    },
    playerCount: {
      listPlayerCountServers: async () => [],
      readPlayerCountServer: async () => null,
      upsertPlayerCountServer: async () => {},
      deletePlayerCountServer: async () => false,
    },
    appConfig: {
      upsertAppConfig: async () => {},
    },
    guildRbac: {
      readGuildAdminRoleId: async () => null,
      upsertGuildAdminRoleId: async () => {},
    },
    steamLink: {
      readSteamLinkConfig: async () => null,
      upsertSteamLinkConfig: async () => {},
      listSteamLinks: async () => [],
    },
    webhookProxy: {
      listWebhookProxyConfigs: async () => [],
      readWebhookProxyConfig: async () => null,
      upsertWebhookProxyConfig: async () => {},
      deleteWebhookProxyConfig: async () => {},
      listWebhookProxyForwardLogs: async () => [],
    },
    guildEntitlements: {
      readGuildEntitlement:
        options?.readGuildEntitlement ??
        (async (guildId: string) => ({ guildId, tier: "free" as const, updatedAtMs: 0 })),
    },
    guildR2Objects: {
      getGuildUsageBytes: options?.getGuildUsageBytes ?? (async () => 0),
    },
  } as never;
}
