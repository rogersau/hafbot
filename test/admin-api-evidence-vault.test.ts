/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createAdminApiHandler as createBaseAdminApiHandler } from "./helpers/admin-api";
import { isRecord } from "../src/unknown-parse";
import { createPermissiveGuildResourceValidator } from "./helpers/guild-resource-validator";

function createAdminApiHandler(options: Parameters<typeof createBaseAdminApiHandler>[0]) {
  return createBaseAdminApiHandler({
    guildResources: createPermissiveGuildResourceValidator(),
    ...options,
  });
}

test("Evidence Vault admin API enforces premium entitlement and saves config", async () => {
  const writes: unknown[] = [];
  const handler = createAdminApiHandler({
    stores: createStores({ writes, tier: "premium" }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/evidence-vault/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1", auditChannelId: "audit", accessRoleIds: [] }),
    }),
    new URL("https://example.com/admin/api/evidence-vault/config"),
  );

  assert.equal(response?.status, 200);
  assert.equal(writes.length, 1);
});

test("Evidence Vault admin API saves multiple access roles", async () => {
  const writes: unknown[] = [];
  const handler = createAdminApiHandler({
    stores: createStores({ writes, tier: "premium" }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/evidence-vault/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        auditChannelId: "audit",
        accessRoleIds: ["staff-role-1", "staff-role-2"],
      }),
    }),
    new URL("https://example.com/admin/api/evidence-vault/config"),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(writes, [
    {
      guildId: "guild-1",
      auditChannelId: "audit",
      accessRoleIds: ["staff-role-1", "staff-role-2"],
      subjectsEnabled: false,
      evidenceFields: [],
      updatedAtMs:
        writes[0] && isRecord(writes[0]) ? (writes[0] as { updatedAtMs: number }).updatedAtMs : 0,
    },
  ]);
});

test("Evidence Vault admin API validates and saves Evidence Fields", async () => {
  const writes: unknown[] = [];
  const handler = createAdminApiHandler({
    stores: createStores({ writes, tier: "premium" }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/evidence-vault/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        auditChannelId: "audit",
        evidenceFields: [
          { label: "Case Reference", type: "short_text" },
          {
            key: "kind",
            label: "Evidence type",
            type: "enum",
            allowedValues: ["video", "video", "image"],
          },
        ],
      }),
    }),
    new URL("https://example.com/admin/api/evidence-vault/config"),
  );

  assert.equal(response?.status, 200);
  assert.deepEqual((writes[0] as { evidenceFields: unknown[] }).evidenceFields, [
    { key: "case_reference", label: "Case Reference", type: "short_text" },
    { key: "kind", label: "Evidence type", type: "enum", allowedValues: ["video", "image"] },
  ]);
});

test("Evidence Vault admin API rejects Enum fields with no allowed values", async () => {
  const handler = createAdminApiHandler({
    stores: createStores({ tier: "premium" }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/evidence-vault/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        auditChannelId: "audit",
        evidenceFields: [{ label: "Evidence type", type: "enum", allowedValues: [] }],
      }),
    }),
    new URL("https://example.com/admin/api/evidence-vault/config"),
  );

  assert.equal(response?.status, 400);
});

test("Evidence Vault admin API returns enum value usage counts", async () => {
  const handler = createAdminApiHandler({
    stores: createStores({
      tier: "premium",
      config: {
        guildId: "guild-1",
        auditChannelId: "audit",
        accessRoleIds: [],
        subjectsEnabled: false,
        evidenceFields: [
          {
            key: "evidence_type",
            label: "Evidence type",
            type: "enum",
            allowedValues: ["Video", "Image"],
          },
        ],
        updatedAtMs: 0,
      },
      records: [
        {
          guildId: "guild-1",
          evidenceFieldValues: [
            { key: "evidence_type", label: "Evidence type", type: "enum", value: "Video" },
          ],
        },
        {
          guildId: "guild-1",
          evidenceFieldValues: [
            { key: "evidence_type", label: "Evidence type", type: "enum", value: "Video" },
          ],
        },
        {
          guildId: "guild-1",
          evidenceFieldValues: [{ key: "other", label: "Other", type: "enum", value: "Ignored" }],
        },
      ],
    }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/evidence-vault?guildId=guild-1"),
    new URL("https://example.com/admin/api/evidence-vault?guildId=guild-1"),
  );

  assert.equal(response?.status, 200);
  const body = (await response?.json()) as { enumValueUsage: unknown };
  assert.deepEqual(body.enumValueUsage, {
    evidence_type: { Video: 2 },
  });
});

test("Evidence Vault admin API exposes Free usage and configuration", async () => {
  const handler = createAdminApiHandler({
    stores: createStores({ tier: "free", records: [{ guildId: "guild-1" }] }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/evidence-vault?guildId=guild-1"),
    new URL("https://example.com/admin/api/evidence-vault?guildId=guild-1"),
  );

  assert.equal(response?.status, 200);
  const body = (await response?.json()) as {
    config: unknown;
    recordUsage: { used: number; max: number | null };
  };
  assert.equal(body.config, null);
  assert.deepEqual(body.recordUsage, { used: 1, max: 30 });
});

test("Evidence Vault admin API lets Free Guilds save the full configuration", async () => {
  const writes: unknown[] = [];
  const handler = createAdminApiHandler({
    stores: createStores({ tier: "free", writes }),
    discordBotToken: "token",
  });

  const response = await handler(
    new Request("https://example.com/admin/api/evidence-vault/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        auditChannelId: "audit",
        accessRoleIds: ["staff"],
        subjectsEnabled: true,
        evidenceFields: [{ label: "Case", type: "short_text" }],
      }),
    }),
    new URL("https://example.com/admin/api/evidence-vault/config"),
  );

  assert.equal(response?.status, 200);
  assert.equal(writes.length, 1);
});

function createStores(options: {
  tier: "free" | "premium";
  writes?: unknown[];
  config?: unknown;
  records?: unknown[];
}) {
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
      readConfig: async () => options.config ?? null,
      listRecords: async () => options.records ?? [],
      upsertConfig: async (config: unknown) => {
        options.writes?.push(config);
      },
    },
  } as never;
}
