import { testWebhookCredential, webhookTargets } from "./support/webhook-credentials";
import type { Cache } from "../src/runtime/discord-json-cache";
import type { QueueProducer } from "../src/runtime/queue-types";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { escapeHtmlAttribute } from "../src/runtime/app";
import { createTestRuntimeApp, type TestRuntimeAppOptions } from "./support/create-runtime-app";
import { buildTicketOpeningMessage } from "../src/services/tickets/ticket-lifecycle";
import { createDiscordGuildResourceValidator } from "../src/discord/guild-resource-validator";
import { isRecord } from "../src/unknown-parse";
import { renderAdminShell } from "../src/runtime/admin-shell";
import { createCustomerAuth } from "./support/sqlite/runtime/auth/auth";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import { createSqliteTicketTranscriptCapabilityStore } from "./support/sqlite/runtime/sqlite-ticket-transcript-capability-store";
import { purgeExpiredTicketTranscripts } from "../src/runtime/ticket-transcript-retention";
import type { GatewayController, RuntimeStore } from "../src/runtime/contracts";
import {
  buildTicketCloseConfirmCustomId,
  buildTicketCloseCustomId,
  buildTicketCloseDeclineCustomId,
  buildTicketCloseRequestCustomId,
  buildTicketClaimCustomId,
  buildTicketOpenCustomId,
  buildTicketModalResponse,
  buildTicketTranscriptAttachmentPath,
  buildTicketTranscriptPath,
} from "../src/tickets";
import type {
  ReactionLimitConfig,
  TicketInstance,
  TicketPanelConfig,
  TimedRoleAssignment,
  TimedRoleAutomationRule,
  WebhookProxyConfig,
  WebhookProxyForwardLog,
} from "../src/types";

import type { RuntimeStores } from "../src/runtime/app-types";
import { buildEphemeralMessage } from "../src/discord-interactions";
import type { CreateChannelMessageInput } from "../src/discord/messages";
import { createWebhookCredentialKeyRing } from "../src/security/webhook-credentials";
import { signSensitiveComponentId } from "../src/security/sensitive-component-ids";
import { createComponentIdSigner } from "../src/security/component-id-signer";
import type { OperationalEvent } from "../src/observability/operational-reporter";
import {
  WebhookCredentialService,
  type StoredWebhookCredential,
  type WebhookCredentialStore,
} from "../src/security/webhook-credentials/store";
import { createLegacyAdminSessionCookie as createAdminSessionCookie } from "./support/legacy-admin-session";
import { createMemoryWorkspaceStore } from "./helpers/memory-workspace-store";
import {
  createProductionRuntimeStores,
  type ProductionRuntimeStoresFixture,
  withStoreOverrides,
} from "./support/production-runtime-stores";
import {
  createPermissiveGuildResourceValidator,
  createStaticGuildResourceValidator,
  testChannel,
} from "./helpers/guild-resource-validator";

function createRuntimeApp(options: TestRuntimeAppOptions) {
  return createTestRuntimeApp({
    customerAuth: createCustomerAuthMock({
      organizations: [{ id: "workspace-1", name: "Workspace", slug: "workspace", role: "owner" }],
    }),
    workspaceStore: createPermissiveWorkspaceStoreMock(),
    guildResources: createPermissiveGuildResourceValidator(),
    ...options,
  });
}

const createUnauthenticatedRuntimeApp = createTestRuntimeApp;

const runtimeStoreFixtures = new Set<ProductionRuntimeStoresFixture>();

test.after(() => {
  for (const fixture of runtimeStoreFixtures) fixture.close();
  runtimeStoreFixtures.clear();
});

const FLAT_RUNTIME_STORE_ALIASES: Record<
  string,
  readonly [group: keyof RuntimeStores, method: string]
> = {
  readConfig: ["blocklist", "readConfig"],
  createEventTemplate: ["events", "createTemplate"],
  upsertEventTemplate: ["events", "upsertTemplate"],
  readEventTemplate: ["events", "readTemplate"],
  listEventTemplates: ["events", "listTemplates"],
  listDueEventReminders: ["events", "listDueReminders"],
  updateEventReminderSentAt: ["events", "updateReminderSentAt"],
  upsertEventSignup: ["events", "upsertSignup"],
  deleteEventSignup: ["events", "deleteSignup"],
  listEventSignups: ["events", "listSignups"],
  listUserEventSignups: ["events", "listUserSignups"],
  upsertGuildR2Object: ["guildR2Objects", "upsertObject"],
  deleteGuildR2Object: ["guildR2Objects", "deleteObject"],
  getGuildR2UsageBytes: ["guildR2Objects", "getGuildUsageBytes"],
  readEvidenceVaultConfig: ["evidenceVault", "readConfig"],
  upsertEvidenceVaultConfig: ["evidenceVault", "upsertConfig"],
  createEvidenceVaultRecord: ["evidenceVault", "createRecord"],
  readEvidenceVaultRecord: ["evidenceVault", "readRecord"],
  listEvidenceVaultRecords: ["evidenceVault", "listRecords"],
  searchEvidenceVaultRecordsBySubject: ["evidenceVault", "searchRecordsBySubject"],
  updateEvidenceVaultRecordStatus: ["evidenceVault", "updateRecordStatus"],
  updateEvidenceVaultRecordSubjects: ["evidenceVault", "updateRecordSubjects"],
  updateEvidenceVaultRecordEvidenceFieldValues: [
    "evidenceVault",
    "updateRecordEvidenceFieldValues",
  ],
  updateEvidenceVaultRecordPlaceholder: ["evidenceVault", "updateRecordPlaceholder"],
  readEvidenceVaultImage: ["evidenceVault", "readImage"],
  readImageRulesConfig: ["imageRules", "readConfig"],
  upsertImageRulesConfig: ["imageRules", "upsertConfig"],
  deleteImageRulesConfig: ["imageRules", "deleteConfig"],
  createImageRulesModQueueItem: ["imageRules", "createModQueueItem"],
  readImageRulesModQueueItem: ["imageRules", "readModQueueItem"],
  setImageRulesModQueueItemQueueMessage: ["imageRules", "setModQueueItemQueueMessage"],
  claimImageRulesModQueueItemRestore: ["imageRules", "claimModQueueItemRestore"],
  markImageRulesModQueueItemApproved: ["imageRules", "markModQueueItemApproved"],
  markImageRulesModQueueItemRestored: ["imageRules", "markModQueueItemRestored"],
  markImageRulesModQueueItemRestoreFailed: ["imageRules", "markModQueueItemRestoreFailed"],
};

/**
 * Production-store compatibility helper for RuntimeApp tests.
 *
 * Every unmodified persistence method comes from the production Cloudflare store
 * over SQLite. Flat legacy method names are translated into narrow overrides so
 * tests can still inject a provider failure or observe a specific boundary while
 * the rest of the HAF-owned persistence contract stays production-shaped.
 */
function createRuntimeStoresWithOverrides(oldStore: object): RuntimeStores {
  const fixture = createProductionRuntimeStores();
  runtimeStoreFixtures.add(fixture);
  const groupedOverrides = new Map<keyof RuntimeStores, Record<string, unknown>>();

  const addOverride = (group: keyof RuntimeStores, method: string, value: unknown) => {
    const overrides = groupedOverrides.get(group) ?? {};
    overrides[method] = value;
    groupedOverrides.set(group, overrides);
  };

  for (const [legacyName, value] of Object.entries(oldStore)) {
    if (legacyName in fixture.stores && isRecord(value)) {
      groupedOverrides.set(legacyName as keyof RuntimeStores, value);
      continue;
    }

    const alias = FLAT_RUNTIME_STORE_ALIASES[legacyName];
    if (alias) {
      addOverride(alias[0], alias[1], value);
      continue;
    }

    const matches = (
      Object.entries(fixture.stores) as Array<
        [keyof RuntimeStores, RuntimeStores[keyof RuntimeStores]]
      >
    ).filter(([, store]) => legacyName in (store as object));
    assert.equal(
      matches.length,
      1,
      `Expected exactly one production RuntimeStore method for legacy override ${legacyName}`,
    );
    addOverride(matches[0][0], legacyName, value);
  }

  const legacy = oldStore as Record<string, unknown>;
  const readTicketPanel = legacy.readTicketPanelConfig;
  if (typeof readTicketPanel === "function") {
    if (!("readTicketPanelConfigById" in legacy)) {
      addOverride(
        "tickets",
        "readTicketPanelConfigById",
        async (guildId: string, panelId: string) => {
          const panel = await Reflect.apply(readTicketPanel, legacy, [guildId]);
          return panel && ((panel as { panelId?: string }).panelId ?? "main") === panelId
            ? panel
            : null;
        },
      );
    }
    if (!("listTicketPanelConfigs" in legacy)) {
      addOverride("tickets", "listTicketPanelConfigs", async (guildId: string) => {
        const panel = await Reflect.apply(readTicketPanel, legacy, [guildId]);
        return panel ? [panel] : [];
      });
    }
  }

  const observePanelUpsert = legacy.upsertTicketPanelConfig;
  const observePanelDelete = legacy.deleteTicketPanelConfig;
  const observeWebhookUpsert = legacy.upsertWebhookProxyConfig;
  const observeWebhookDelete = legacy.deleteWebhookProxyConfig;
  if (
    typeof observePanelUpsert === "function" ||
    typeof observePanelDelete === "function" ||
    typeof observeWebhookUpsert === "function" ||
    typeof observeWebhookDelete === "function"
  ) {
    const configurationRevisions = fixture.stores.configurationRevisions;
    assert.ok(configurationRevisions);
    const productionCommit =
      configurationRevisions.commitTicketPanelMutation.bind(configurationRevisions);
    addOverride(
      "configurationRevisions",
      "commitTicketPanelMutation",
      async (mutation: {
        nextPanel?: unknown;
        currentPanel?: { guildId: string; panelId?: string } | null;
      }) => {
        await productionCommit(mutation as never);
        if (mutation.nextPanel && typeof observePanelUpsert === "function") {
          await Reflect.apply(observePanelUpsert, legacy, [mutation.nextPanel]);
        } else if (mutation.currentPanel && typeof observePanelDelete === "function") {
          await Reflect.apply(observePanelDelete, legacy, [
            mutation.currentPanel.guildId,
            mutation.currentPanel.panelId ?? "main",
          ]);
        }
      },
    );
    const productionCommitVersionedMutation =
      configurationRevisions.commitVersionedMutation?.bind(configurationRevisions);
    if (productionCommitVersionedMutation) {
      addOverride(
        "configurationRevisions",
        "commitVersionedMutation",
        async (mutation: { feature: string; current?: unknown; next?: unknown }) => {
          await productionCommitVersionedMutation(mutation as never);
          if (mutation.feature === "tickets") {
            if (mutation.next && typeof observePanelUpsert === "function") {
              await Reflect.apply(observePanelUpsert, legacy, [mutation.next]);
            } else if (mutation.current && typeof observePanelDelete === "function") {
              const currentPanel = mutation.current as { guildId: string; panelId?: string };
              await Reflect.apply(observePanelDelete, legacy, [
                currentPanel.guildId,
                currentPanel.panelId ?? "main",
              ]);
            }
          } else if (mutation.feature === "webhook-proxy" && mutation.next) {
            if (typeof legacy.upsertWebhookProxyConfig === "function") {
              await Reflect.apply(legacy.upsertWebhookProxyConfig, legacy, [mutation.next]);
            }
          } else if (mutation.feature === "webhook-proxy" && mutation.current) {
            if (typeof legacy.deleteWebhookProxyConfig === "function") {
              const currentConfig = mutation.current as { guildId: string; publicId: string };
              await Reflect.apply(legacy.deleteWebhookProxyConfig, legacy, [
                { guildId: currentConfig.guildId, publicId: currentConfig.publicId },
              ]);
            }
          }
        },
      );
    }
  }

  return Object.fromEntries(
    (
      Object.entries(fixture.stores) as Array<
        [keyof RuntimeStores, RuntimeStores[keyof RuntimeStores]]
      >
    ).map(([group, store]) => [
      group,
      groupedOverrides.has(group)
        ? withStoreOverrides(store as object, groupedOverrides.get(group) ?? {})
        : store,
    ]),
  ) as unknown as RuntimeStores;
}

test("createRuntimeApp serves the admin login shell but not admin static assets", async () => {
  const app = createUnauthenticatedRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const loginResponse = await app.fetch(new Request("https://runtime.example/admin/login"));
  assert.equal(loginResponse.status, 200);
  assert.match(loginResponse.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await loginResponse.text(), /admin-root/);

  const assetResponse = await app.fetch(
    new Request("https://runtime.example/admin/assets/admin.js"),
  );
  assert.equal(assetResponse.status, 404);
  assert.equal(await assetResponse.text(), "Not found");
});

test("createRuntimeApp suppresses suspended guild admin, interaction, and billing entry points", async () => {
  const stores = createRuntimeStoresWithOverrides({} as RuntimeStore);
  stores.guildServiceSuspensions = {
    async readActiveSuspension(guildId) {
      return guildId === "guild-blocked"
        ? {
            guildId,
            reason: "private reason",
            createdAtMs: 1,
            createdByUserId: "admin",
            removedAtMs: null,
            removedByUserId: null,
          }
        : null;
    },
    async listSuspensions() {
      return [];
    },
    async suspendGuild() {},
    async restoreGuild() {},
    async listAuditEvents() {
      return [];
    },
  };
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores,
    gateway: {} as GatewayController,
  });

  const admin = await app.fetch(
    new Request("https://runtime.example/admin/api/tickets?guildId=guild-blocked"),
  );
  assert.equal(admin.status, 503);
  assert.equal(
    ((await admin.json()) as { error: string }).error,
    "Service unavailable for this server.",
  );

  const interaction = await app.fetch(
    new Request("https://runtime.example/interactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guild_id: "guild-blocked", type: 2 }),
    }),
  );
  assert.deepEqual(await interaction.json(), {
    type: 4,
    data: { content: "Service unavailable for this server.", flags: 64 },
  });

  const billing = await app.fetch(
    new Request("https://runtime.example/api/billing/assignment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-blocked", tier: "pro" }),
    }),
  );
  assert.equal(billing.status, 503);
  assert.doesNotMatch(await billing.text(), /private reason/);
});

test("createRuntimeApp resolves suspended guilds from link state and verification attempts", async () => {
  const stores = createRuntimeStoresWithOverrides({} as RuntimeStore);
  stores.guildServiceSuspensions = {
    async readActiveSuspension(guildId) {
      return guildId === "guild-blocked"
        ? {
            guildId,
            reason: "private",
            createdAtMs: 1,
            createdByUserId: "admin",
            removedAtMs: null,
            removedByUserId: null,
          }
        : null;
    },
    async listSuspensions() {
      return [];
    },
    async suspendGuild() {},
    async restoreGuild() {},
    async listAuditEvents() {
      return [];
    },
  };
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    stores,
    gateway: {} as GatewayController,
    services: {
      steamLinkService: {
        async readPendingLink() {
          return { guildId: "guild-blocked" };
        },
      },
      platformLinkService: {
        async readPendingLink() {
          return { guildId: "guild-blocked" };
        },
      },
      memberVerificationService: {
        async readVerificationAttempt() {
          return { guildId: "guild-blocked" };
        },
      },
    } as any,
  });

  for (const url of [
    "https://runtime.example/auth/steam/callback?state=opaque",
    "https://runtime.example/auth/xbox/callback?state=opaque",
    "https://runtime.example/verify/attempt-1?sig=opaque",
  ]) {
    const response = await app.fetch(new Request(url));
    assert.equal(response.status, 503);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "Service unavailable for this server.",
    );
  }
});

test("createRuntimeApp excludes suspended guilds inside limited LFG due queries", async () => {
  const excludedCalls: string[][] = [];
  const stores = createRuntimeStoresWithOverrides({
    async listDueLfgPostExpiries(_nowMs: number, _limit: number, excluded: string[] = []) {
      excludedCalls.push(excluded);
      return [];
    },
    async listDueLfgRenewalReminders(_nowMs: number, _limit: number, excluded: string[] = []) {
      excludedCalls.push(excluded);
      return [];
    },
  });
  stores.guildServiceSuspensions = {
    async readActiveSuspension() {
      return null;
    },
    async listSuspensions() {
      return [
        {
          guildId: "guild-blocked",
          reason: "private",
          createdAtMs: 1,
          createdByUserId: "admin",
          removedAtMs: null,
          removedByUserId: null,
        },
      ];
    },
    async suspendGuild() {},
    async restoreGuild() {},
    async listAuditEvents() {
      return [];
    },
  };
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    stores,
    gateway: {} as GatewayController,
  });

  await app.refreshPlayerCount();

  assert.deepEqual(excludedCalls, [["guild-blocked"], ["guild-blocked"]]);
});

test("createRuntimeApp filters suspended guild work from scheduled services", async () => {
  const stores = createRuntimeStoresWithOverrides({
    async listExpiredTimedRoles() {
      return [
        {
          guildId: "guild-blocked",
          userId: "user-1",
          roleId: "role-1",
          targetDisplayName: null,
          durationInput: "1h",
          expiresAtMs: 1,
          createdAtMs: 0,
          updatedAtMs: 0,
        },
      ];
    },
  });
  stores.guildServiceSuspensions = {
    async readActiveSuspension(guildId) {
      return guildId === "guild-blocked"
        ? {
            guildId,
            reason: "private",
            createdAtMs: 1,
            createdByUserId: "admin",
            removedAtMs: null,
            removedByUserId: null,
          }
        : null;
    },
    async listSuspensions() {
      return [];
    },
    async suspendGuild() {},
    async restoreGuild() {},
    async listAuditEvents() {
      return [];
    },
  };
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    stores,
    gateway: {} as GatewayController,
  });
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await app.refreshPlayerCount();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(calls, []);
});

test("createRuntimeApp runs bounded 180-day feedback retention and continues after purge failure", async () => {
  const stores = createRuntimeStoresWithOverrides({});
  const calls: Array<{ beforeMs: number; limit: number }> = [];
  const original = stores.adminFeedback!;
  stores.adminFeedback = {
    ...original,
    purgeExpired: async (beforeMs, limit) => {
      calls.push({ beforeMs, limit });
      throw new Error("retention unavailable");
    },
  };
  const before = Date.now();
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    stores,
    gateway: {} as GatewayController,
    features: { ...ALL_FEATURES_ENABLED, playerCount: false },
  });
  await app.refreshPlayerCount();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.limit, 100);
  assert.ok(calls[0]!.beforeMs >= before - 180 * 24 * 60 * 60 * 1000 - 100);
  assert.ok(calls[0]!.beforeMs <= Date.now() - 180 * 24 * 60 * 60 * 1000);
});

test("createRuntimeApp purges retained Ticket transcript capabilities and objects", async () => {
  const fixture = createProductionRuntimeStores();
  runtimeStoreFixtures.add(fixture);
  const capabilities = createSqliteTicketTranscriptCapabilityStore(fixture.database.d1);
  const nowMs = Date.now();
  await capabilities.issue({
    objectId: "expired-transcript-object",
    guildId: "guild-1",
    channelId: "channel-1",
    accessToken: "expired-token",
    createdAtMs: nowMs - 20_000,
    expiresAtMs: nowMs - 10_000,
    retentionExpiresAtMs: nowMs - 1,
  });
  const deleted: Array<{ guildId: string; channelId: string; objectId: string }> = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    stores: fixture.stores,
    gateway: {} as GatewayController,
    features: { ...ALL_FEATURES_ENABLED, playerCount: false },
    ticketTranscriptCapabilities: capabilities,
    ticketTranscriptBlobs: {
      putHtml: async () => {},
      getHtml: async () => null,
      putAttachment: async () => {},
      getAttachment: async () => null,
      deleteTranscriptArtifacts: async (input) => {
        deleted.push(input);
      },
    },
  });

  await app.refreshPlayerCount();

  assert.deepEqual(deleted, [
    { guildId: "guild-1", channelId: "channel-1", objectId: "expired-transcript-object" },
  ]);
  assert.equal(
    await capabilities.revoke({
      guildId: "guild-1",
      channelId: "channel-1",
      revokedAtMs: nowMs,
    }),
    false,
  );
});

test("Ticket transcript retention continues after an artifact deletion fails", async () => {
  const attempted: string[] = [];
  const deletedMetadata: string[] = [];
  const expired = [
    { objectId: "blocked-object", guildId: "guild-1", channelId: "channel-1" },
    { objectId: "purged-object", guildId: "guild-1", channelId: "channel-2" },
  ];

  const purged = await purgeExpiredTicketTranscripts({
    capabilities: {
      listRetentionExpired: async () => expired,
      deleteRetentionExpired: async ({ objectId }: { objectId: string }) => {
        deletedMetadata.push(objectId);
        return true;
      },
    } as never,
    blobs: {
      putHtml: async () => {},
      getHtml: async () => null,
      putAttachment: async () => {},
      getAttachment: async () => null,
      deleteTranscriptArtifacts: async ({ objectId }) => {
        attempted.push(objectId);
        if (objectId === "blocked-object") throw new Error("R2 unavailable");
      },
    },
    nowMs: 10_000,
    limit: 100,
  });

  assert.equal(purged, 1);
  assert.deepEqual(attempted, ["blocked-object", "purged-object"]);
  assert.deepEqual(deletedMetadata, ["purged-object"]);
});

test("renderAdminShell serves static admin shell references with runtime data", async () => {
  const response = renderAdminShell(
    true,
    "/admin/guild-1/blocklist",
    '?name="quoted"',
    "Sign in <now>",
    {
      name: `Jane "Discord" Admin`,
      email: `jane+"discord"@example.com`,
      image: "https://cdn.discordapp.com/avatars/user/avatar.png?size=64&tag=<x>",
    },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);

  const html = await response.text();
  assert.match(html, /<link rel="stylesheet" href="\/admin\/assets\/admin\.css" \/>/);
  assert.match(html, /<script type="module" src="\/admin\/assets\/admin\.js"><\/script>/);
  assert.match(html, /<title>Sign in &lt;now&gt;<\/title>/);
  assert.match(html, /<div id="admin-root"[^>]*data-authenticated="true"/);
  const styleNonce = html.match(/data-csp-style-nonce="([^"]+)"/)?.[1];
  assert.ok(styleNonce);
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    new RegExp(`style-src [^;]*'nonce-${styleNonce}'`),
  );
  assert.doesNotMatch(html, /data-global-admin=/);
  assert.match(html, /data-initial-path="\/admin\/guild-1\/blocklist"/);
  assert.match(html, /data-initial-search="\?name=&quot;quoted&quot;"/);
  assert.match(html, /data-user-name="Jane &quot;Discord&quot; Admin"/);
  assert.match(html, /data-user-email="jane\+&quot;discord&quot;@example\.com"/);
  assert.match(
    html,
    /data-user-image="https:\/\/cdn\.discordapp\.com\/avatars\/user\/avatar\.png\?size=64&amp;tag=&lt;x&gt;"/,
  );
});

test("createRuntimeApp signs out customer admins through Better Auth on admin logout", async () => {
  const handledAuthPaths: Array<{ pathname: string; method: string; cookie: string | null }> = [];
  const app = createTestRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    customerAuth: {
      handler: async (request: Request) => {
        const url = new URL(request.url);
        handledAuthPaths.push({
          pathname: url.pathname,
          method: request.method,
          cookie: request.headers.get("cookie"),
        });
        return Response.json(
          { ok: true },
          { headers: { "set-cookie": "better-auth.session_token=; Path=/; Max-Age=0" } },
        );
      },
      api: {
        getSession: async () => ({
          user: {
            id: "user-1",
            discordUserId: "discord-user-1",
            name: "Customer User",
          },
        }),
      },
    } as never,
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/admin/logout", {
      method: "POST",
      headers: { cookie: "better-auth.session_token=session-1" },
    }),
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin/login");
  assert.deepEqual(handledAuthPaths, [
    {
      pathname: "/api/auth/sign-out",
      method: "POST",
      cookie: "better-auth.session_token=session-1",
    },
  ]);
  assert.match(response.headers.get("set-cookie") ?? "", /better-auth\.session_token=.*Max-Age=0/);
});

test("createRuntimeApp logs out real Discord sessions through the browser form boundary", async () => {
  const fixture = createProductionRuntimeStores();
  const origin = "https://runtime.example";
  const customerAuth = createCustomerAuth({
    betterAuthSecret: "runtime-logout-test-secret-with-at-least-32-characters",
    betterAuthUrl: origin,
    discordOAuthClientId: "logout-test-client",
    discordOAuthClientSecret: "logout-test-client-secret",
    database: fixture.database.d1,
  });
  const app = createTestRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    customerAuth,
    stores: fixture.stores,
    gateway: {} as GatewayController,
  });
  const originalFetch = globalThis.fetch;
  const discordRequests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    discordRequests.push(request.url);
    if (request.url === "https://discord.com/api/oauth2/token") {
      assert.equal(request.method, "POST");
      assert.equal(new URLSearchParams(await request.text()).get("code"), "logout-test-code");
      return Response.json({
        access_token: "logout-test-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "identify email guilds",
      });
    }
    assert.equal(request.url, "https://discord.com/api/users/%40me");
    assert.equal(request.headers.get("authorization"), "Bearer logout-test-access-token");
    return Response.json({
      id: "123456789012345678",
      username: "friend-account",
      global_name: "Friend Account",
      email: "friend@example.com",
      verified: true,
      avatar: "test-avatar",
    });
  };

  const setCookies = (response: Response): string[] =>
    (response.headers as Headers & { getSetCookie: () => string[] }).getSetCookie();
  const cookieHeader = (response: Response): string =>
    setCookies(response)
      .filter((cookie) => !/;\s*Max-Age=0(?:;|$)/i.test(cookie))
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

  try {
    const signIn = await app.fetch(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "discord", callbackURL: "/admin" }),
      }),
    );
    assert.equal(signIn.status, 200);
    const authorizationUrl = new URL((await signIn.json<{ url: string }>()).url);
    const callbackUrl = new URL(`${origin}/api/auth/callback/discord`);
    callbackUrl.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
    callbackUrl.searchParams.set("code", "logout-test-code");
    const callback = await app.fetch(
      new Request(callbackUrl, { headers: { cookie: cookieHeader(signIn) } }),
    );
    assert.equal(callback.status, 302);
    assert.equal(new URL(callback.headers.get("location")!, origin).pathname, "/admin");
    assert.deepEqual(discordRequests, [
      "https://discord.com/api/oauth2/token",
      "https://discord.com/api/users/%40me",
    ]);
    const originalCookie = cookieHeader(callback);
    assert.match(originalCookie, /__Secure-better-auth\.session_token=/);
    const sessionHeaders = new Headers({ cookie: originalCookie });
    const signedInSession = await customerAuth.api.getSession({ headers: sessionHeaders });
    assert.equal(signedInSession?.user.name, "Friend Account");

    for (const untrustedOrigin of ["https://untrusted.example", "null"]) {
      const rejected = await app.fetch(
        new Request(`${origin}/admin/logout`, {
          method: "POST",
          headers: {
            cookie: originalCookie,
            origin: untrustedOrigin,
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-mode": "navigate",
          },
          body: "",
        }),
      );
      assert.equal(rejected.status, 403, `logout rejects ${untrustedOrigin} origin`);
      assert.equal(rejected.headers.get("location"), null);
      assert.equal(setCookies(rejected).length, 0);
      const retainedSession = await customerAuth.api.getSession({ headers: sessionHeaders });
      assert.equal(retainedSession?.session.id, signedInSession?.session.id);
    }

    const logout = await app.fetch(
      new Request(`${origin}/admin/logout`, {
        method: "POST",
        headers: {
          cookie: originalCookie,
          origin,
          referer: `${origin}/`,
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "same-origin",
        },
        body: "",
      }),
    );
    assert.equal(logout.status, 302);
    assert.equal(logout.headers.get("location"), "/admin/login");
    const expiredCookies = setCookies(logout);
    assert.ok(expiredCookies.length >= 2);
    assert.ok(expiredCookies.every((cookie) => /;\s*Max-Age=0(?:;|$)/i.test(cookie)));
    assert.ok(
      expiredCookies.some((cookie) => cookie.startsWith("__Secure-better-auth.session_token=")),
    );
    assert.ok(
      expiredCookies.some((cookie) => cookie.startsWith("__Secure-better-auth.session_data=")),
    );
    assert.equal(await customerAuth.api.getSession({ headers: sessionHeaders }), null);

    const login = await app.fetch(
      new Request(`${origin}/admin/login`, { headers: { cookie: originalCookie } }),
    );
    assert.equal(login.status, 200);
    assert.equal(login.headers.get("location"), null);
    assert.doesNotMatch(await login.text(), /data-authenticated="true"/);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

test("createRuntimeApp serves authenticated dashboard shells for nested admin pages", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });
  const response = await app.fetch(
    new Request("https://runtime.example/admin/guild-1/tickets", {}),
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-authenticated="true"/);
  assert.match(html, /data-initial-path="\/admin\/guild-1\/tickets"/);
});

test("createRuntimeApp redirects unauthenticated nested admin pages to login", async () => {
  const app = createUnauthenticatedRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(new Request("https://runtime.example/admin/guild-1/tickets"));

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin/login?next=%2Fadmin%2Fguild-1%2Ftickets");
});

test("escapeHtmlAttribute escapes characters unsafe in HTML attributes", () => {
  assert.equal(escapeHtmlAttribute(`"/admin?<tag>&'`), "&quot;/admin?&lt;tag&gt;&amp;&#39;");
});

test("createRuntimeApp handles health checks", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(new Request("https://runtime.example/health"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "OK");
});

test("createRuntimeApp serves Microsoft identity association JSON", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/.well-known/microsoft-identity-association.json"),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), {
    associatedApplications: [{ applicationId: "b8574ee2-584c-48d7-893f-9ffe940b2f97" }],
  });
});

test("createRuntimeApp serves terms of service page", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(new Request("https://runtime.example/terms"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  assert.match(html, /Terms of Service/i);
});

test("createRuntimeApp serves privacy policy page", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(new Request("https://runtime.example/privacy"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  assert.match(html, /Privacy Policy/i);
  assert.match(html, /PostHog/i);
  assert.match(html, /13 months/i);
  assert.match(html, /Global Privacy Control/i);
  assert.match(html, /Share anonymous product usage/i);
});

test("createRuntimeApp redirects /install to the Discord bot installation URL", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    discordApplicationId: "123456789012345678",
    discordInstallPermissions: "268561488",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(new Request("https://runtime.example/install"));
  assert.equal(response.status, 302);

  const location = response.headers.get("location");
  assert.ok(location);
  const installUrl = new URL(location);
  assert.equal(installUrl.origin + installUrl.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(installUrl.searchParams.get("client_id"), "123456789012345678");
  assert.equal(installUrl.searchParams.get("permissions"), "268561488");
  assert.equal(installUrl.searchParams.get("scope"), "bot applications.commands");
});

test("createRuntimeApp returns 404 for /install when Discord application ID is missing", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(new Request("https://runtime.example/install"));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "Discord install link is not configured",
  });
});

test("createRuntimeApp forwards configured public webhook proxy requests", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; body: string | undefined }> = [];
  const queuedDeliveries: unknown[] = [];
  const logs: WebhookProxyForwardLog[] = [];
  const config: WebhookProxyConfig = {
    guildId: "guild-1",
    publicId: "public_webhook_1234",
    name: "Alerts",
    enabled: true,
    banLookupEnabled: false,
    banLookupCredentialId: null,
    banLookupAppIds: [],
    destinations: [
      {
        id: "main",
        label: "Main",
        credentialId: testWebhookCredential("https://discord.com/api/webhooks/900001/main"),
      },
      {
        id: "errors",
        label: "Errors",
        credentialId: testWebhookCredential("https://discord.com/api/webhooks/2/errors"),
      },
    ],
    defaultDestinationIds: ["main"],
    routingRules: [
      { id: "errors", label: "Errors", pattern: "error", flags: "i", destinationIds: ["errors"] },
    ],
    createdAtMs: 1,
    updatedAtMs: 1,
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), body: init?.body as string | undefined });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium" as const, updatedAtMs: 0 };
        },
        async readWebhookProxyConfig(publicId: string) {
          return publicId === config.publicId ? config : null;
        },
        async createWebhookProxyForwardLog(log: WebhookProxyForwardLog) {
          logs.push(log);
        },
      }),
      webhookProxyDeliveryQueue: {
        async send(message) {
          queuedDeliveries.push(message);
        },
      } as QueueProducer<unknown>,
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      new Request("https://runtime.example/webhooks/public_webhook_1234", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "error happened" }),
      }),
    );

    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.deepEqual(fetchCalls, []);
    assert.deepEqual(queuedDeliveries, [
      {
        version: 2,
        config: { guildId: "guild-1", publicId: "public_webhook_1234" },
        destinations: webhookTargets([
          {
            id: "errors",
            label: "Errors",
            credentialId: testWebhookCredential("https://discord.com/api/webhooks/2/errors"),
          },
        ]),
        body: JSON.stringify({ content: "error happened" }),
        contentType: "application/json",
      },
    ]);
    assert.equal(logs.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request-scoped runtime apps keep known webhooks available when invalid admission is exhausted", async () => {
  const publicId = "review_cache_webhook_1234";
  const config: WebhookProxyConfig = {
    guildId: "guild-review-cache",
    publicId,
    name: "Review cache",
    enabled: true,
    banLookupEnabled: false,
    banLookupCredentialId: null,
    banLookupAppIds: [],
    destinations: [
      {
        id: "main",
        label: "Main",
        credentialId: testWebhookCredential("https://discord.com/api/webhooks/900001/main"),
      },
    ],
    defaultDestinationIds: ["main"],
    routingRules: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  let configReads = 0;
  let rejectInvalidAdmission = false;
  const queuedDeliveries: unknown[] = [];
  const stores = createRuntimeStoresWithOverrides({
    async readGuildEntitlement(guildId: string) {
      return { guildId, tier: "premium" as const, updatedAtMs: 0 };
    },
    async readWebhookProxyConfig(candidate: string) {
      configReads += 1;
      return candidate === publicId ? config : null;
    },
  });
  const publicWebhookSourceCaches = {
    webhookProxy: new Map(),
    banCase: new Map(),
  };
  const webhookIngressGuard = {
    getByName(name: string) {
      return {
        async reserve() {
          if (rejectInvalidAdmission && name.startsWith("invalid-source:")) {
            return {
              ok: false as const,
              reason: "rate_limited" as const,
              retryAfterSeconds: 60,
            };
          }
          return {
            ok: true as const,
            leaseId: `${name}-lease`,
            expiresAtMs: Date.now() + 30_000,
          };
        },
        async registerBody() {
          return { ok: true as const };
        },
        async complete() {},
      };
    },
  } as never;
  const fetchThroughNewRuntime = (candidate: string) =>
    createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores,
      gateway: {} as GatewayController,
      publicWebhookSourceCaches,
      webhookIngressGuard,
      webhookProxyDeliveryQueue: {
        async send(message) {
          queuedDeliveries.push(message);
        },
      } as QueueProducer<unknown>,
    }).fetch(
      new Request(`https://runtime.example/webhooks/${candidate}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

  assert.equal((await fetchThroughNewRuntime(publicId)).status, 204);
  rejectInvalidAdmission = true;
  const unknown = await fetchThroughNewRuntime("unknown_review_webhook_1234");
  const known = await fetchThroughNewRuntime(publicId);

  assert.equal(unknown.status, 429);
  assert.equal(unknown.headers.get("retry-after"), "60");
  assert.equal(known.status, 204);
  assert.equal(configReads, 1);
  assert.equal(queuedDeliveries.length, 2);
});

test("createRuntimeApp applies content replacements to plain-text webhook proxy requests", async () => {
  const credentials = createTestWebhookCredentialService();
  const credential = await credentials.replace(
    {
      kind: "proxy_destination",
      guildId: "guild-1",
      publicId: "public_webhook_1234",
      destinationId: "main",
    },
    "https://discord.com/api/webhooks/900001/main",
  );
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; body: string | undefined }> = [];
  const config: WebhookProxyConfig = {
    guildId: "guild-1",
    publicId: "public_webhook_1234",
    name: "Alerts",
    enabled: true,
    banLookupEnabled: false,
    banLookupCredentialId: null,
    banLookupAppIds: [],
    destinations: [
      {
        id: "main",
        label: "Main",
        credentialId: credential.credentialId,
      },
    ],
    defaultDestinationIds: ["main"],
    routingRules: [],
    contentReplacements: [
      {
        id: "cftools-profile",
        label: "CFTools profile",
        pattern: "\\b(7656119\\d{10})\\b",
        flags: "g",
        replacement: "[$1](https://app.cftools.cloud/profile/$1)",
      },
    ],
    createdAtMs: 1,
    updatedAtMs: 1,
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), body: init?.body as string | undefined });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium" as const, updatedAtMs: 0 };
        },
        async readWebhookProxyConfig(publicId: string) {
          return publicId === config.publicId ? config : null;
        },
      }),
      webhookCredentialService: credentials,
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      new Request("https://runtime.example/webhooks/public_webhook_1234", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: [
          "ColdAsFk",
          "Player Name:",
          "Cyanide ()",
          "Player Steam ID:",
          "76561197970527691",
        ].join("\n"),
      }),
    );

    assert.equal(response.status, 204);
    assert.deepEqual(fetchCalls, [
      {
        url: "https://discord.com/api/webhooks/900001/main",
        body: [
          "ColdAsFk",
          "Player Name:",
          "Cyanide ()",
          "Player Steam ID:",
          "[76561197970527691](https://app.cftools.cloud/profile/76561197970527691)",
        ].join("\n"),
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp applies content replacements inside embed field values", async () => {
  const credentials = createTestWebhookCredentialService();
  const credential = await credentials.replace(
    {
      kind: "proxy_destination",
      guildId: "guild-1",
      publicId: "public_webhook_1234",
      destinationId: "main",
    },
    "https://discord.com/api/webhooks/900001/main",
  );
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; body: string | undefined }> = [];
  const config: WebhookProxyConfig = {
    guildId: "guild-1",
    publicId: "public_webhook_1234",
    name: "Alerts",
    enabled: true,
    banLookupEnabled: false,
    banLookupCredentialId: null,
    banLookupAppIds: [],
    destinations: [
      {
        id: "main",
        label: "Main",
        credentialId: credential.credentialId,
      },
    ],
    defaultDestinationIds: ["main"],
    routingRules: [],
    contentReplacements: [
      {
        id: "cftools-profile",
        label: "CFTools profile",
        pattern: "\\b(7656119\\d{10})\\b",
        flags: "g",
        replacement: "[$1](https://app.cftools.cloud/profile/$1)",
      },
    ],
    createdAtMs: 1,
    updatedAtMs: 1,
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), body: init?.body as string | undefined });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium" as const, updatedAtMs: 0 };
        },
        async readWebhookProxyConfig(publicId: string) {
          return publicId === config.publicId ? config : null;
        },
      }),
      webhookCredentialService: credentials,
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      new Request("https://runtime.example/webhooks/public_webhook_1234", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          embeds: [
            {
              title: "ColdAsFk",
              fields: [{ name: "Player Steam ID", value: "76561197970527691", inline: true }],
            },
          ],
        }),
      }),
    );

    assert.equal(response.status, 204);
    assert.deepEqual(fetchCalls, [
      {
        url: "https://discord.com/api/webhooks/900001/main",
        body: JSON.stringify({
          embeds: [
            {
              title: "ColdAsFk",
              fields: [
                {
                  name: "Player Steam ID",
                  value: "[76561197970527691](https://app.cftools.cloud/profile/76561197970527691)",
                  inline: true,
                },
              ],
            },
          ],
        }),
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp invalidates cached webhook configs after admin updates", async () => {
  const credentials = createTestWebhookCredentialService();
  const credential = await credentials.replace(
    {
      kind: "proxy_destination",
      guildId: "guild-1",
      publicId: "public_webhook_1234",
      destinationId: "main",
    },
    "https://discord.com/api/webhooks/900001/main",
  );
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; body: string | undefined }> = [];
  let readCount = 0;
  let config: WebhookProxyConfig = {
    guildId: "guild-1",
    publicId: "public_webhook_1234",
    name: "Alerts",
    enabled: true,
    banLookupEnabled: false,
    banLookupCredentialId: null,
    banLookupAppIds: [],
    destinations: [
      {
        id: "main",
        label: "Main",
        credentialId: credential.credentialId,
      },
    ],
    defaultDestinationIds: ["main"],
    routingRules: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), body: init?.body as string | undefined });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium" as const, updatedAtMs: 0 };
        },
        async readWebhookProxyConfig(publicId: string) {
          readCount += 1;
          return publicId === config.publicId ? config : null;
        },
        async upsertWebhookProxyConfig(nextConfig: WebhookProxyConfig) {
          config = nextConfig;
        },
      }),
      webhookCredentialService: credentials,
      gateway: {} as GatewayController,
    });

    const firstWebhookResponse = await app.fetch(
      new Request("https://runtime.example/webhooks/public_webhook_1234", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "first" }),
      }),
    );
    assert.equal(firstWebhookResponse.status, 204);

    const updateResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/webhook-proxy/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: "guild-1",
          publicId: "public_webhook_1234",
          name: "Alerts",
          enabled: true,
          destinations: [
            {
              id: "alt",
              label: "Alt",
              credential: {
                action: "replace",
                url: "https://discord.com/api/webhooks/900000/alt",
              },
            },
          ],
          defaultDestinationIds: ["alt"],
          routingRules: [],
        }),
      }),
    );
    assert.equal(updateResponse.status, 200);

    const secondWebhookResponse = await app.fetch(
      new Request("https://runtime.example/webhooks/public_webhook_1234", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "second" }),
      }),
    );
    assert.equal(secondWebhookResponse.status, 204);

    assert.equal(readCount, 3);
    assert.deepEqual(fetchCalls, [
      {
        url: "https://discord.com/api/webhooks/900001/main",
        body: JSON.stringify({ content: "first" }),
      },
      {
        url: "https://discord.com/api/webhooks/900000/alt",
        body: JSON.stringify({ content: "second" }),
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp creates webhook proxy configs with generated public IDs", async () => {
  const savedConfigs: WebhookProxyConfig[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readGuildEntitlement(guildId: string) {
        return { guildId, tier: "premium" as const, updatedAtMs: 0 };
      },
      async upsertWebhookProxyConfig(config: WebhookProxyConfig) {
        savedConfigs.push(config);
      },
    }),
    webhookCredentialService: createTestWebhookCredentialService(),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/webhook-proxy/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "1483606177261551777",
        publicId: "",
        name: "New webhook",
        enabled: true,
        destinations: [
          {
            id: "main",
            label: "Main",
            credential: {
              action: "replace",
              // Deliberately synthetic, format-valid credential; no live webhook is used.
              url: "https://discord.com/api/webhooks/900000/alt",
            },
          },
        ],
        defaultDestinationIds: ["main"],
        routingRules: [],
        contentReplacements: [
          {
            id: "cftools-profile",
            label: "CFTools profile",
            pattern: "\\b(7656119\\d{10})\\b",
            flags: "g",
            replacement: "[$1](https://app.cftools.cloud/profile/$1)",
          },
        ],
        workspaceId: "",
      }),
    }),
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; publicId: string };
  assert.equal(body.ok, true);
  assert.match(body.publicId, /^[A-Za-z0-9_-]{16,64}$/);
  const savedConfig = savedConfigs[0];
  assert.ok(savedConfig);
  assert.equal(savedConfig.publicId, body.publicId);
  assert.equal(savedConfig.guildId, "1483606177261551777");
  assert.deepEqual(savedConfig.contentReplacements, [
    {
      id: "cftools-profile",
      label: "CFTools profile",
      pattern: "\\b(7656119\\d{10})\\b",
      flags: "g",
      replacement: "[$1](https://app.cftools.cloud/profile/$1)",
    },
  ]);
});

test("createRuntimeApp preserves encrypted webhook credentials through an Admin edit", async () => {
  const webhookUrl = "https://discord.com/api/webhooks/900000/synthetic_secret";
  const credentials = createTestWebhookCredentialService();
  const owner = {
    kind: "proxy_destination" as const,
    guildId: "guild-1",
    publicId: "public_webhook_1234",
    destinationId: "main",
  };
  const credential = await credentials.replace(owner, webhookUrl);
  const currentConfig: WebhookProxyConfig = {
    guildId: "guild-1",
    publicId: "public_webhook_1234",
    name: "Alerts",
    enabled: true,
    banLookupEnabled: false,
    banLookupCredentialId: null,
    banLookupAppIds: [],
    destinations: [{ id: "main", label: "Main", credentialId: credential.credentialId }],
    defaultDestinationIds: ["main"],
    routingRules: [
      { id: "errors", label: "Errors", pattern: "error", flags: "i", destinationIds: ["main"] },
    ],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  let savedConfig: WebhookProxyConfig | undefined;
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readGuildEntitlement(guildId: string) {
        return { guildId, tier: "premium" as const, updatedAtMs: 0 };
      },
      async listWebhookProxyConfigs() {
        return [currentConfig];
      },
      async readWebhookProxyConfig() {
        return currentConfig;
      },
      async upsertWebhookProxyConfig(config: WebhookProxyConfig) {
        savedConfig = config;
      },
    }),
    webhookCredentialService: credentials,
    gateway: {} as GatewayController,
  });

  const getResponse = await app.fetch(
    new Request("https://runtime.example/admin/api/webhook-proxy?guildId=guild-1"),
  );
  assert.equal(getResponse.status, 200);
  const resource = (await getResponse.json()) as {
    configs: Array<{
      destinations: Array<{ id: string; label: string; credential: { credentialId: string } }>;
    }>;
  };
  const destination = resource.configs[0]?.destinations[0];
  assert.ok(destination);
  assert.equal(destination.id, "main");
  assert.doesNotMatch(JSON.stringify(resource), /synthetic_secret/);

  const saveResponse = await app.fetch(
    new Request("https://runtime.example/admin/api/webhook-proxy/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: currentConfig.guildId,
        publicId: currentConfig.publicId,
        name: currentConfig.name,
        enabled: currentConfig.enabled,
        destinations: [
          {
            id: destination.id,
            label: destination.label,
            credential: { action: "preserve", credentialId: destination.credential.credentialId },
          },
        ],
        defaultDestinationIds: currentConfig.defaultDestinationIds,
        routingRules: currentConfig.routingRules,
      }),
    }),
  );
  assert.equal(saveResponse.status, 200);
  assert.equal(savedConfig?.destinations[0]?.credentialId, credential.credentialId);
  assert.equal((await credentials.resolve(credential.credentialId, owner)).url, webhookUrl);
  assert.doesNotMatch(JSON.stringify(savedConfig), /synthetic_secret/);
  assert.deepEqual(savedConfig?.routingRules, currentConfig.routingRules);
  assert.equal(savedConfig?.destinations[0]?.id, "main");
});

function createTestWebhookCredentialService(): WebhookCredentialService {
  const credentials = new Map<string, StoredWebhookCredential>();
  const store: WebhookCredentialStore = {
    async readById(credentialId) {
      return credentials.get(credentialId) ?? null;
    },
    async readByOwner(owner) {
      return (
        [...credentials.values()].find(
          (credential) => JSON.stringify(credential.owner) === JSON.stringify(owner),
        ) ?? null
      );
    },
    async upsert(credential) {
      credentials.set(credential.credentialId, credential);
    },
    async delete(credentialId) {
      credentials.delete(credentialId);
    },
  };
  return new WebhookCredentialService(
    store,
    createWebhookCredentialKeyRing({ keyV1: Buffer.alloc(32, 7).toString("base64") }),
  );
}

test("createRuntimeApp rejects webhook proxy admin access for Free Guilds", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({}),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/webhook-proxy?guildId=guild-1", {}),
  );

  assert.equal(response.status, 402);
  assert.equal(
    ((await response.json()) as { error: string }).error,
    "This feature is premium-only.",
  );
});

test("createRuntimeApp hides disabled webhook proxy public routes", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    features: { ...ALL_FEATURES_ENABLED, webhookProxy: false },
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/webhooks/public_webhook_1234", { method: "POST" }),
  );

  assert.equal(response.status, 404);
});

test("createRuntimeApp handles Discord PING interactions", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": "ignored-for-test",
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({ type: 1 }),
    }),
  );

  assert.deepEqual(await response.json(), { type: 1 });
});

test("createRuntimeApp returns immediate private /help for ordinary members with features disabled", async () => {
  const disabledFeatures = { ...ALL_FEATURES_ENABLED };
  for (const key of Object.keys(disabledFeatures) as Array<keyof typeof disabledFeatures>) {
    disabledFeatures[key] = false;
  }
  const deferred: Promise<unknown>[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
    features: disabledFeatures,
    waitUntil: (promise) => {
      deferred.push(promise);
    },
  });
  const response = await app.fetch(
    new Request("https://runtime.example/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": "ignored-for-test",
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({
        type: 2,
        guild_id: "guild-1",
        member: { permissions: "0", user: { id: "member-1" } },
        data: { name: "help" },
      }),
    }),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    type: number;
    data: { flags: number; content: string };
  };
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
  assert.match(body.data.content, /https:\/\/docs\.hafbot\.xyz\/commands/);
  assert.match(body.data.content, /https:\/\/docs\.hafbot\.xyz\/guides\/discord-ticket-bot/);
  assert.match(body.data.content, /https:\/\/docs\.hafbot\.xyz\//);
  assert.match(body.data.content, /https:\/\/hafbot\.xyz\/admin/);
  assert.match(body.data.content, /server admins/i);
  assert.ok(body.data.content.length <= 2_000);
  assert.equal(deferred.length, 0, "help should not depend on deferred Discord requests");
});

test("createRuntimeApp handles /blocklist list command with empty guild", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readConfig() {
        return { guilds: {}, botUserId: "bot-user-id" };
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": "ignored-for-test",
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({
        type: 2,
        guild_id: "guild-1",
        member: { permissions: "8" },
        data: {
          name: "blocklist",
          options: [{ type: 1, name: "list" }],
        },
      }),
    }),
  );

  assert.deepEqual(await response.json(), {
    type: 4,
    data: { flags: 64, content: "No emojis are blocked in this server." },
  });
});

test("createRuntimeApp routes Hide Evidence for Evidence Vault access role members", async () => {
  let hideCalled = false;
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
    services: {
      evidenceVaultService: {
        hideEvidence: async () => {
          hideCalled = true;
          return {
            ok: true,
            record: {} as never,
            message: "Evidence hidden in the Evidence Vault.",
          };
        },
      } as never,
    },
  });

  const response = await app.fetch(
    new Request("https://runtime.example/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": "ignored-for-test",
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({
        type: 2,
        guild_id: "guild-1",
        channel_id: "source",
        member: { permissions: "0", roles: ["staff"], user: { id: "hider" } },
        data: {
          name: "Hide Evidence",
          type: 3,
          target_id: "message-1",
          resolved: {
            messages: {
              "message-1": { id: "message-1", channel_id: "source", content: "proof" },
            },
          },
        },
      }),
    }),
  );

  assert.equal(hideCalled, true);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("Evidence hidden in the Evidence Vault."),
  );
});

test("createRuntimeApp returns ephemeral Evidence Vault search embeds", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
    services: {
      evidenceVaultService: {
        searchEvidence: async () => ({
          allowed: true,
          content: "",
          records: [],
          message: {
            embeds: [{ title: "Evidence Vault Search", color: 0xfee75c, fields: [] }],
            components: [
              {
                type: 1,
                components: [
                  { type: 2, style: 1, label: "View 1", custom_id: "evidence-vault:see:record-1" },
                ],
              },
            ],
          },
        }),
      } as never,
    },
  });

  const response = await app.fetch(
    createInteractionRequest({
      type: 2,
      guild_id: "guild-1",
      member: { permissions: "8", roles: [], user: { id: "searcher" } },
      data: {
        name: "evidence-vault",
        options: [
          { type: 1, name: "search", options: [{ name: "user", value: "76561198000000000" }] },
        ],
      },
    }),
  );

  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      flags: 64,
      embeds: [{ title: "Evidence Vault Search", color: 0xfee75c, fields: [] }],
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 1, label: "View 1", custom_id: "evidence-vault:see:record-1" },
          ],
        },
      ],
    },
  });
});

test("createRuntimeApp opens Evidence Fields search modal when no subject is supplied", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
    services: {
      evidenceVaultService: {
        buildEvidenceFieldSearchModal: async () => ({
          ok: true,
          modal: {
            title: "Search Evidence Vault",
            custom_id: "evidence-vault:field-search",
            components: [],
          },
        }),
      } as never,
    },
  });

  const response = await app.fetch(
    createInteractionRequest({
      type: 2,
      guild_id: "guild-1",
      member: { permissions: "8", roles: [], user: { id: "searcher" } },
      data: {
        name: "evidence-vault",
        options: [{ type: 1, name: "search", options: [] }],
      },
    }),
  );

  assert.deepEqual(await response.json(), {
    type: 9,
    data: {
      title: "Search Evidence Vault",
      custom_id: "evidence-vault:field-search",
      components: [],
    },
  });
});

test("createRuntimeApp routes structured Evidence Vault slash search options", async () => {
  let captured: {
    subjectInput?: string | null;
    sourceText?: string | null;
    fieldInputs: string[];
  } | null = null;
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
    services: {
      evidenceVaultService: {
        searchEvidenceFieldForm: async (input: any) => {
          captured = {
            subjectInput: input.subjectInput,
            sourceText: input.sourceText,
            fieldInputs: input.fieldInputs,
          };
          return {
            allowed: true,
            content: "",
            records: [],
            message: { embeds: [{ title: "Evidence Vault Search", color: 0xfee75c }] },
          };
        },
      } as never,
    },
  });

  const response = await app.fetch(
    createInteractionRequest({
      type: 2,
      guild_id: "guild-1",
      member: { permissions: "8", roles: [], user: { id: "searcher" } },
      data: {
        name: "evidence-vault",
        options: [
          {
            type: 1,
            name: "search",
            options: [
              { name: "user", value: "<@123456789012345678>" },
              { name: "source_text", value: "raid" },
              { name: "field_5", value: "final" },
            ],
          },
        ],
      },
    }),
  );

  assert.deepEqual(captured, {
    subjectInput: "<@123456789012345678>",
    sourceText: "raid",
    fieldInputs: ["", "", "", "", "final"],
  });
  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      flags: 64,
      embeds: [{ title: "Evidence Vault Search", color: 0xfee75c }],
    },
  });
});

test("createRuntimeApp routes Evidence Vault amend commands", async () => {
  let amended = false;
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
    services: {
      evidenceVaultService: {
        amendEvidenceSubjects: async () => {
          amended = true;
          return {
            ok: true,
            message: "Evidence Vault subjects updated: <@123456789012345678>.",
            record: null,
          };
        },
      } as never,
    },
  });

  const response = await app.fetch(
    createInteractionRequest({
      type: 2,
      guild_id: "guild-1",
      member: { permissions: "8", roles: [], user: { id: "amender" } },
      data: {
        name: "evidence-vault",
        options: [
          {
            type: 1,
            name: "amend",
            options: [
              { name: "record_id", value: "record-1" },
              { name: "action", value: "add" },
              { name: "identifier", value: "<@123456789012345678>" },
            ],
          },
        ],
      },
    }),
  );

  assert.equal(amended, true);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("Evidence Vault subjects updated: <@123456789012345678>."),
  );
});

test("createRuntimeApp lets HAF admins add and disable identity patterns", async () => {
  const calls: string[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    hafAdminGuildId: "admin-guild",
    hafAdminRoleId: "haf-admin",
    stores: createRuntimeStoresWithOverrides({
      listIdentityPatterns: async () => [],
      addIdentityPattern: async (input: unknown) => {
        calls.push(`add:${JSON.stringify(input)}`);
        return {
          ...(input as object),
          id: "pattern-1",
          position: 1,
          disabled: false,
          createdAtMs: 1,
        };
      },
      disableIdentityPattern: async (id: string) => {
        calls.push(`disable:${id}`);
        return true;
      },
    } as unknown as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const addResponse = await app.fetch(
    createInteractionRequest({
      type: 2,
      guild_id: "admin-guild",
      member: { permissions: "0", roles: ["haf-admin"], user: { id: "haf" } },
      data: {
        name: "haf-admin",
        options: [
          {
            type: 1,
            name: "identity-patterns",
            options: [
              { name: "action", value: "add" },
              { name: "platform", value: "discord" },
              { name: "pattern", value: "discord.example/(\\d+)" },
            ],
          },
        ],
      },
    }),
  );
  const disableResponse = await app.fetch(
    createInteractionRequest({
      type: 2,
      guild_id: "admin-guild",
      member: { permissions: "0", roles: ["haf-admin"], user: { id: "haf" } },
      data: {
        name: "haf-admin",
        options: [
          {
            type: 1,
            name: "identity-patterns",
            options: [
              { name: "action", value: "disable" },
              { name: "pattern", value: "pattern-1" },
            ],
          },
        ],
      },
    }),
  );

  assert.deepEqual(
    await addResponse.json(),
    buildEphemeralMessage("Added identity pattern pattern-1."),
  );
  assert.deepEqual(
    await disableResponse.json(),
    buildEphemeralMessage("Disabled identity pattern pattern-1."),
  );
  assert.deepEqual(calls, [
    'add:{"platform":"discord","pattern":"discord.example/(\\\\d+)","captureGroup":1}',
    "disable:pattern-1",
  ]);
});

test("createRuntimeApp respects enabled: false for /blocklist list", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readConfig() {
        return {
          guilds: {
            "guild-1": {
              enabled: false,
              emojis: ["🚫", "⛔"],
            },
          },
          botUserId: "bot-user-id",
        };
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": "ignored-for-test",
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({
        type: 2,
        guild_id: "guild-1",
        member: { permissions: "8" },
        data: {
          name: "blocklist",
          options: [{ type: 1, name: "list" }],
        },
      }),
    }),
  );

  assert.deepEqual(await response.json(), {
    type: 4,
    data: { flags: 64, content: "No emojis are blocked in this server." },
  });
});

test("createRuntimeApp allows free-tier slash commands without workspace linkage", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readConfig() {
        return { guilds: {}, botUserId: "bot-user-id" };
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": "ignored-for-test",
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({
        type: 2,
        guild_id: "guild-1",
        member: { permissions: "8" },
        data: {
          name: "blocklist",
          options: [{ type: 1, name: "list" }],
        },
      }),
    }),
  );

  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("No emojis are blocked in this server."),
  );
});

test("createRuntimeApp allows timed role slash commands on free tier", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async listTimedRoles() {
        return [];
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": "ignored-for-test",
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({
        type: 2,
        guild_id: "guild-1",
        member: { permissions: "8" },
        data: {
          name: "timedrole",
          options: [{ type: 1, name: "list" }],
        },
      }),
    }),
  );

  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("No timed roles are active in this server."),
  );
});

test("createRuntimeApp allows timed role slash commands on premium tier", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readGuildEntitlement(guildId: string) {
        return { guildId, tier: "premium", updatedAtMs: 1 };
      },
      async listTimedRoles() {
        return [];
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": "ignored-for-test",
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({
        type: 2,
        guild_id: "guild-1",
        member: { permissions: "8" },
        data: {
          name: "timedrole",
          options: [{ type: 1, name: "list" }],
        },
      }),
    }),
  );

  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("No timed roles are active in this server."),
  );
});

test("createRuntimeApp rejects haf-admin outside the configured admin guild", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    hafAdminGuildId: "admin-guild",
    hafAdminRoleId: "haf-admin-role",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({}),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    createInteractionRequest(
      createHafAdminCommand({
        interactionGuildId: "customer-guild",
        memberRoles: ["haf-admin-role"],
        subcommand: "show-plan",
        guildId: "customer-guild",
      }),
    ),
  );

  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("This command can only be used in the HAF admin server."),
  );
});

test("createRuntimeApp rejects haf-admin when the admin role env var is missing", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    hafAdminGuildId: "admin-guild",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({}),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    createInteractionRequest(
      createHafAdminCommand({
        interactionGuildId: "admin-guild",
        memberRoles: ["haf-admin-role"],
        subcommand: "show-plan",
        guildId: "customer-guild",
      }),
    ),
  );

  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("You do not have access to use this command."),
  );
});

test("createRuntimeApp rejects haf-admin without the configured admin role", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    hafAdminGuildId: "admin-guild",
    hafAdminRoleId: "haf-admin-role",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({}),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    createInteractionRequest(
      createHafAdminCommand({
        interactionGuildId: "admin-guild",
        memberRoles: ["other-role"],
        subcommand: "show-plan",
        guildId: "customer-guild",
      }),
    ),
  );

  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("You do not have access to use this command."),
  );
});

test("createRuntimeApp reads guild entitlements for haf-admin show-plan", async () => {
  const reads: string[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    hafAdminGuildId: "admin-guild",
    hafAdminRoleId: "haf-admin-role",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readGuildEntitlement(guildId: string) {
        reads.push(guildId);
        return { guildId, tier: "premium", updatedAtMs: 123 };
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    createInteractionRequest(
      createHafAdminCommand({
        interactionGuildId: "admin-guild",
        memberRoles: ["haf-admin-role"],
        subcommand: "show-plan",
        guildId: "customer-guild",
      }),
    ),
  );

  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("Guild customer-guild effective plan is premium."),
  );
  assert.deepEqual(reads, ["customer-guild"]);
});

test("createRuntimeApp repairs Member Verification panels through haf-admin", async () => {
  const repairs: string[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    hafAdminGuildId: "admin-guild",
    hafAdminRoleId: "haf-admin-role",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({}),
    services: {
      memberVerificationService: {
        async repairWelcomePanel(guildId: string) {
          repairs.push(guildId);
          return { outcome: "created", panelMessageId: "panel-1" };
        },
      },
    } as any,
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    createInteractionRequest(
      createHafAdminCommand({
        interactionGuildId: "admin-guild",
        memberRoles: ["haf-admin-role"],
        subcommand: "repair-verification-panel",
        guildId: "customer-guild",
      }),
    ),
  );

  assert.deepEqual(repairs, ["customer-guild"]);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage(
      "Published or repaired the Member Verification panel for guild customer-guild (message panel-1).",
    ),
  );
});

test("createRuntimeApp distinguishes ineligible and failed Member Verification panel repairs", async () => {
  const cases = [
    {
      result: { outcome: "not-eligible", reason: "channel-mode-required" },
      expected:
        "Could not repair the Member Verification panel for guild customer-guild because its saved configuration is not eligible for channel panel delivery.",
    },
    {
      result: { outcome: "failed" },
      expected:
        "Could not repair the Member Verification panel for guild customer-guild because Discord publication failed. Check bot permissions and try again.",
    },
  ] as const;

  for (const testCase of cases) {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      hafAdminGuildId: "admin-guild",
      hafAdminRoleId: "haf-admin-role",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({}),
      services: {
        memberVerificationService: {
          async repairWelcomePanel() {
            return testCase.result;
          },
        },
      } as any,
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest(
        createHafAdminCommand({
          interactionGuildId: "admin-guild",
          memberRoles: ["haf-admin-role"],
          subcommand: "repair-verification-panel",
          guildId: "customer-guild",
        }),
      ),
    );

    assert.deepEqual(await response.json(), buildEphemeralMessage(testCase.expected));
  }
});

test("createRuntimeApp manages guild service suspensions through haf-admin", async () => {
  const entries = new Map<string, any>();
  const stores = createRuntimeStoresWithOverrides({});
  stores.guildServiceSuspensions = {
    async readActiveSuspension(guildId) {
      return entries.get(guildId) ?? null;
    },
    async listSuspensions() {
      return [...entries.values()];
    },
    async suspendGuild(input) {
      entries.set(input.guildId, {
        guildId: input.guildId,
        reason: input.reason,
        createdAtMs: input.occurredAtMs,
        createdByUserId: input.actorUserId,
        removedAtMs: null,
        removedByUserId: null,
      });
    },
    async restoreGuild(input) {
      entries.delete(input.guildId);
    },
    async listAuditEvents() {
      return [];
    },
  };
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    hafAdminGuildId: "admin-guild",
    hafAdminRoleId: "haf-admin-role",
    verifyDiscordRequest: async () => true,
    stores,
    gateway: {} as GatewayController,
  });
  const run = (subcommand: "suspend-guild" | "list-suspensions" | "restore-guild") => {
    const common = { interactionGuildId: "admin-guild", memberRoles: ["haf-admin-role"] };
    const command =
      subcommand === "suspend-guild"
        ? createHafAdminCommand({
            ...common,
            subcommand,
            guildId: "customer-guild",
            reason: "Internal evidence",
          })
        : subcommand === "restore-guild"
          ? createHafAdminCommand({ ...common, subcommand, guildId: "customer-guild" })
          : createHafAdminCommand({ ...common, subcommand });
    return app.fetch(createInteractionRequest(command));
  };

  assert.deepEqual(
    await (await run("suspend-guild")).json(),
    buildEphemeralMessage("Suspended all HAF service for guild customer-guild."),
  );
  assert.equal(entries.get("customer-guild")?.createdByUserId, "haf-admin-user");
  assert.match(JSON.stringify(await (await run("list-suspensions")).json()), /Internal evidence/);
  assert.deepEqual(
    await (await run("restore-guild")).json(),
    buildEphemeralMessage("Restored HAF service for guild customer-guild."),
  );
  assert.equal(entries.size, 0);
});

test("createRuntimeApp suspends a guild before removing the bot through haf-admin", async () => {
  const entries = new Map<string, any>();
  const stores = createRuntimeStoresWithOverrides({});
  stores.guildServiceSuspensions = {
    async readActiveSuspension(guildId) {
      return entries.get(guildId) ?? null;
    },
    async listSuspensions() {
      return [...entries.values()];
    },
    async suspendGuild(input) {
      entries.set(input.guildId, {
        guildId: input.guildId,
        reason: input.reason,
        createdAtMs: input.occurredAtMs,
        createdByUserId: input.actorUserId,
        removedAtMs: null,
        removedByUserId: null,
      });
    },
    async restoreGuild(input) {
      entries.delete(input.guildId);
    },
    async listAuditEvents() {
      return [];
    },
  };
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    hafAdminGuildId: "admin-guild",
    hafAdminRoleId: "haf-admin-role",
    verifyDiscordRequest: async () => true,
    stores,
    gateway: {} as GatewayController,
  });
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string; method: string; authorization: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    assert.ok(entries.has("1511970725576310814"), "guild must be suspended before Discord leave");
    calls.push({
      input: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    return new Response(null, { status: 204 });
  };

  try {
    const response = await app.fetch(
      createInteractionRequest(
        createHafAdminCommand({
          interactionGuildId: "admin-guild",
          memberRoles: ["haf-admin-role"],
          subcommand: "leave-guild",
          guildId: "1511970725576310814",
          reason: "Internal evidence",
          confirmedGuildId: "1511970725576310814",
        }),
      ),
    );

    assert.deepEqual(
      await response.json(),
      buildEphemeralMessage(
        "Suspended all HAF service and removed the bot from guild 1511970725576310814.",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(entries.get("1511970725576310814")?.reason, "Internal evidence");
  assert.equal(entries.get("1511970725576310814")?.createdByUserId, "haf-admin-user");
  assert.deepEqual(calls, [
    {
      input: "https://discord.com/api/v10/users/@me/guilds/1511970725576310814",
      method: "DELETE",
      authorization: "Bot bot-token",
    },
  ]);
});

test("guild suspension survives a lost Discord leave response and a new runtime retries safely", async () => {
  const stores = createRuntimeStoresWithOverrides({});
  const suspensionStore = stores.guildServiceSuspensions!;
  const guildId = "1511970725576310814";
  const makeApp = () =>
    createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      hafAdminGuildId: "admin-guild",
      hafAdminRoleId: "haf-admin-role",
      verifyDiscordRequest: async () => true,
      stores,
      gateway: {} as GatewayController,
    });
  const request = (memberRoles = ["haf-admin-role"]) =>
    createInteractionRequest(
      createHafAdminCommand({
        interactionGuildId: "admin-guild",
        memberRoles,
        subcommand: "leave-guild",
        guildId,
        reason: "Internal evidence",
        confirmedGuildId: guildId,
      }),
    );
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let member = true;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), `https://discord.com/api/v10/users/@me/guilds/${guildId}`);
    assert.equal(init?.method, "DELETE");
    assert.ok(await suspensionStore.readActiveSuspension(guildId));
    calls += 1;
    if (member) {
      member = false;
      throw new Error("Discord response lost after removal");
    }
    return Response.json({ message: "Unknown Guild", code: 10004 }, { status: 404 });
  };
  try {
    const first = await makeApp().fetch(request());
    assert.match(JSON.stringify(await first.json()), /suspended, but Discord removal failed/);
    assert.equal(member, false);
    const suspension = await suspensionStore.readActiveSuspension(guildId);
    assert.ok(suspension);
    const audit = await suspensionStore.listAuditEvents(guildId);
    assert.equal(audit.length, 1);

    const recovered = makeApp();
    await recovered.fetch(request([]));
    assert.equal(calls, 1, "retry still requires current staff authorization");
    const retry = await recovered.fetch(request());
    assert.match(JSON.stringify(await retry.json()), /bot was already absent/);
    assert.equal(calls, 2);
    assert.deepEqual(await suspensionStore.readActiveSuspension(guildId), suspension);
    assert.deepEqual(await suspensionStore.listAuditEvents(guildId), audit);

    await suspensionStore.restoreGuild({
      guildId,
      actorUserId: "admin-2",
      occurredAtMs: Date.now(),
    });
    assert.equal(await suspensionStore.readActiveSuspension(guildId), null);
    assert.equal(member, false, "restoring service does not reinstall the bot");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp requires an exact guild removal confirmation", async () => {
  const stores = createRuntimeStoresWithOverrides({});
  let suspensionWrites = 0;
  stores.guildServiceSuspensions = {
    async readActiveSuspension() {
      return null;
    },
    async listSuspensions() {
      return [];
    },
    async suspendGuild() {
      suspensionWrites += 1;
    },
    async restoreGuild() {},
    async listAuditEvents() {
      return [];
    },
  };
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    hafAdminGuildId: "admin-guild",
    hafAdminRoleId: "haf-admin-role",
    verifyDiscordRequest: async () => true,
    stores,
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    createInteractionRequest(
      createHafAdminCommand({
        interactionGuildId: "admin-guild",
        memberRoles: ["haf-admin-role"],
        subcommand: "leave-guild",
        guildId: "guild-1",
        reason: "Internal evidence",
        confirmedGuildId: "guild-2",
      }),
    ),
  );

  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("The confirmation guild ID does not match. No changes were made."),
  );
  assert.equal(suspensionWrites, 0);

  const originalFetch = globalThis.fetch;
  let discordCalls = 0;
  globalThis.fetch = async () => {
    discordCalls += 1;
    return new Response(null, { status: 204 });
  };
  try {
    const adminGuildResponse = await app.fetch(
      createInteractionRequest(
        createHafAdminCommand({
          interactionGuildId: "admin-guild",
          memberRoles: ["haf-admin-role"],
          subcommand: "leave-guild",
          guildId: "admin-guild",
          reason: "mistake",
          confirmedGuildId: "admin-guild",
        }),
      ),
    );
    assert.deepEqual(
      await adminGuildResponse.json(),
      buildEphemeralMessage("The HAF admin guild cannot be suspended or left."),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(suspensionWrites, 0);
  assert.equal(discordCalls, 0);
});

test("createRuntimeApp manages the gateway through haf-admin", async () => {
  const calls: string[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    hafAdminGuildId: "admin-guild",
    hafAdminRoleId: "haf-admin-role",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({}),
    gateway: {
      async status() {
        calls.push("status");
        return { state: "connected" };
      },
      async start() {
        calls.push("start");
        return { started: true };
      },
    } as GatewayController,
  });
  const run = (subcommand: "gateway-status" | "start-gateway") =>
    app.fetch(
      createInteractionRequest(
        createHafAdminCommand({
          interactionGuildId: "admin-guild",
          memberRoles: ["haf-admin-role"],
          subcommand,
        }),
      ),
    );

  assert.match(JSON.stringify(await (await run("gateway-status")).json()), /connected/);
  assert.match(JSON.stringify(await (await run("start-gateway")).json()), /started/);
  assert.deepEqual(calls, ["status", "start"]);
});

test("createRuntimeApp lists bot guilds with effective plans for haf-admin list-guilds", async () => {
  const originalFetch = globalThis.fetch;
  const reads: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/users/@me/guilds")) {
      return Response.json([
        { id: "guild-2", name: "Alpha" },
        { id: "guild-1", name: "Zulu" },
        { id: "guild-3", name: "Bravo" },
      ]);
    }

    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token-list-guilds",
      hafAdminGuildId: "admin-guild",
      hafAdminRoleId: "haf-admin-role",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readGuildEntitlement(guildId: string) {
          reads.push(guildId);
          return { guildId, tier: guildId === "guild-3" ? "premium" : "free", updatedAtMs: 123 };
        },
      }),
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest(
        createHafAdminCommand({
          interactionGuildId: "admin-guild",
          memberRoles: ["haf-admin-role"],
          subcommand: "list-guilds",
        }),
      ),
    );

    assert.deepEqual(
      await response.json(),
      buildEphemeralMessage(
        [
          "Bot guild plans:",
          "- Alpha (`guild-2`): free",
          "- Bravo (`guild-3`): premium",
          "- Zulu (`guild-1`): free",
        ].join("\n"),
      ),
    );
    assert.deepEqual(reads, ["guild-2", "guild-3", "guild-1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp truncates oversized haf-admin list-guilds output clearly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/users/@me/guilds")) {
      return Response.json(
        Array.from({ length: 250 }, (_, index) => ({
          id: `guild-${String(index).padStart(3, "0")}`,
          name: `Guild ${String(index).padStart(3, "0")} ${"X".repeat(12)}`,
        })),
      );
    }

    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token-list-guilds-truncation",
      hafAdminGuildId: "admin-guild",
      hafAdminRoleId: "haf-admin-role",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({}),
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest(
        createHafAdminCommand({
          interactionGuildId: "admin-guild",
          memberRoles: ["haf-admin-role"],
          subcommand: "list-guilds",
        }),
      ),
    );

    const body = (await response.json()) as ReturnType<typeof buildEphemeralMessage>;
    assert.deepEqual(body.type, 4);
    assert.equal(body.data.flags, 64);
    assert.ok(body.data.content.startsWith("Bot guild plans:\n- Guild 000"));
    assert.ok(body.data.content.includes("\n...and "));
    assert.ok(body.data.content.length <= 2000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp applies Guild-scoped blocklist mutations through customer authorization", async () => {
  const calls: string[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readConfig() {
        return {
          guilds: { "guild-1": { enabled: true, emojis: ["✅"] } },
          botUserId: "bot-user-id",
        };
      },
      async applyGuildEmojiMutation(body: {
        guildId: string;
        emoji: string;
        action: "add" | "remove";
      }) {
        calls.push(`blocklist:${body.guildId}:${body.emoji}:${body.action}`);
        return {
          guilds: {
            [body.guildId]: {
              enabled: true,
              emojis: body.action === "add" ? ["✅", body.emoji] : ["✅"],
            },
          },
          botUserId: "bot-user-id",
        };
      },
    }),
    gateway: {
      async status() {
        return {
          status: "idle",
          sessionId: null,
          resumeGatewayUrl: null,
          lastSequence: null,
          backoffAttempt: 0,
          lastError: null,
          heartbeatIntervalMs: null,
        };
      },
      async start() {
        calls.push("gateway:start");
        return {
          status: "connecting",
          sessionId: null,
          resumeGatewayUrl: null,
          lastSequence: null,
          backoffAttempt: 0,
          lastError: null,
          heartbeatIntervalMs: null,
        };
      },
    },
  });

  const blocklistResponse = await app.fetch(
    new Request("https://runtime.example/admin/api/blocklist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1", emoji: "🚫", action: "add" }),
    }),
  );
  assert.equal(blocklistResponse.status, 200);
  assert.deepEqual(calls, ["blocklist:guild-1:🚫:add"]);
});

test("createRuntimeApp exposes Message Template admin APIs", async () => {
  const stores = createRuntimeStoresWithOverrides({});
  stores.messageTemplates = {
    async listByGuild(guildId) {
      return [
        {
          id: "template-1",
          guildId,
          internalName: "Welcome",
          embeds: [{ description: "Welcome to the server.", fields: [] }],
          availableForTicketReplies: true,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ];
    },
    async listTicketReplyTemplates() {
      return [];
    },
    async readById() {
      return null;
    },
    async countByGuild() {
      return 1;
    },
    async upsert() {},
    async delete() {},
  };
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores,
    gateway: {} as GatewayController,
  });
  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/message-templates?guildId=guild-1", {}),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    guildId: "guild-1",
    templates: [
      {
        id: "template-1",
        guildId: "guild-1",
        internalName: "Welcome",
        embeds: [{ description: "Welcome to the server.", fields: [] }],
        availableForTicketReplies: true,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ],
  });
});

test("createRuntimeApp exposes premium-gated reaction limit config and breach counters", async () => {
  let config: ReactionLimitConfig | null = null;
  const resets: string[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readGuildEntitlement(guildId: string) {
        return { guildId, tier: "premium", updatedAtMs: 0 };
      },
      async readReactionLimitConfig() {
        return config;
      },
      async upsertReactionLimitConfig(nextConfig: ReactionLimitConfig) {
        config = nextConfig;
      },
      async readBreachCounters(guildId: string) {
        return [{ guildId, userId: "user-1", breachCount: 2 }];
      },
      async resetBreachCounter(guildId: string, userId: string) {
        resets.push(`${guildId}:${userId}`);
      },
    }),
    gateway: {} as GatewayController,
  });

  const saveResponse = await app.fetch(
    new Request("https://runtime.example/admin/api/reaction-limits/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        limitsEnabled: true,
        maxReactionsPerMessage: 10,
        maxReactionsPerUserPerMessage: 3,
        breachThreshold: 2,
        breachRoleId: "role-1",
        breachRoleDurationMs: null,
        breachDmText: "Slow down.",
        channelMode: "exclude",
        channelIds: ["channel-9"],
      }),
    }),
  );
  assert.equal(saveResponse.status, 200);
  assert.notEqual(config, null);
  const savedConfig = config as unknown as ReactionLimitConfig;
  assert.deepEqual(savedConfig.channelMode, "exclude");
  assert.deepEqual(savedConfig.channelIds, ["channel-9"]);

  const getResponse = await app.fetch(
    new Request("https://runtime.example/admin/api/reaction-limits?guildId=guild-1", {}),
  );
  assert.equal(getResponse.status, 200);
  assert.deepEqual(await getResponse.json(), {
    guildId: "guild-1",
    config,
    counters: [{ guildId: "guild-1", userId: "user-1", breachCount: 2 }],
  });

  const clearResponse = await app.fetch(
    new Request("https://runtime.example/admin/api/reaction-limits/counter/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1", userId: "user-1" }),
    }),
  );

  assert.equal(clearResponse.status, 200);
  assert.deepEqual(resets, ["guild-1:user-1"]);
});

test("createRuntimeApp exposes reaction limits for free guilds", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({}),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/reaction-limits?guildId=guild-1", {}),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    guildId: "guild-1",
    config: null,
    counters: [],
  });
});

test("createRuntimeApp exposes Member Verification configuration for Free Guilds", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({}),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/member-verification?guildId=guild-1", {}),
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { guildId: string; config: unknown };
  assert.equal(body.guildId, "guild-1");
  assert.equal(body.config, null);
});

test("createRuntimeApp keeps enhanced Member Verification methods paid", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({}),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/member-verification/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        enabled: true,
        verifiedRoleId: "verified-role",
        verificationMethod: "turnstile",
      }),
    }),
  );

  assert.equal(response.status, 402);
  assert.equal(
    ((await response.json()) as { error: string }).error,
    "Enhanced verification methods require a paid plan.",
  );
});

test("createRuntimeApp starts configured Turnstile Member Verification from a Verify interaction", async () => {
  const originalFetch = globalThis.fetch;
  const attempts: unknown[] = [];
  const componentIdSigner = createComponentIdSigner({
    currentSecret: "member-verification-panel-current-format-test-secret",
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ roles: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        readGuildEntitlement: async (guildId: string) => ({
          guildId,
          tier: "premium" as const,
          updatedAtMs: 0,
        }),
        memberVerification: {
          readConfig: async () => ({
            guildId: "guild-1",
            enabled: true,
            verifiedRoleId: "verified-role",
            title: "Welcome",
            description: "Verify to continue.",
            color: 0x5865f2,
            imageUrl: null,
            thumbnailUrl: null,
            rulesUrl: null,
            verifyButtonEmoji: null,
            deliveryMode: "channel" as const,
            verificationMethod: "turnstile" as const,
            welcomeChannelId: "welcome-channel",
            panelMessageId: "panel-message",
            updatedAtMs: 0,
          }),
          upsertConfig: async () => {},
          readVerificationState: async () => null,
          upsertVerificationState: async () => {},
          createVerificationAttempt: async (attempt: unknown) => {
            attempts.push(attempt);
          },
          readVerificationAttempt: async () => null,
          updateVerificationAttempt: async () => {},
          deleteVerificationAttempt: async () => {},
          listActiveVerificationAttempts: async () => [],
          tryClaimVerificationAttempt: async () => false,
        },
      }),
      gateway: {} as GatewayController,
      publicUrl: "https://hafbot.xyz",
      turnstileSiteKey: "site-key",
      turnstileSecretKey: "secret-key",
      componentIdSigner,
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 3,
        user: { id: "user-1" },
        data: {
          custom_id: await signSensitiveComponentId(
            "member_verification_verify:guild-1",
            componentIdSigner,
            { guildId: "guild-1" },
          ),
        },
        message: { id: "panel-message", channel_id: "welcome-channel" },
      }),
    );
    const body = (await response.json()) as { data: { content: string; flags: number } };

    assert.equal(response.status, 200);
    assert.equal(body.data.flags, 64);
    assert.match(
      body.data.content,
      /^Please complete verification to receive your role: https:\/\/hafbot\.xyz\/verify\//,
    );
    assert.equal(attempts.length, 1);

    const unrelatedLegacyResponse = await app.fetch(
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: { custom_id: buildTicketCloseCustomId("ticket-channel-1") },
      }),
    );
    assert.deepEqual(await unrelatedLegacyResponse.json(), {
      type: 4,
      data: { flags: 64, content: "This action is no longer available." },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp does not resend retained enhanced verification DMs on Free", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    readCustomerAdminSession: async () => ({
      user: { id: "session-1", discordUserId: "admin-1", name: "Admin" },
    }),
    stores: createRuntimeStoresWithOverrides({
      memberVerification: {
        readConfig: async () => ({
          guildId: "guild-1",
          enabled: true,
          verifiedRoleId: "verified-role",
          title: "Welcome",
          description: "Verify to continue.",
          color: 0x5865f2,
          imageUrl: null,
          thumbnailUrl: null,
          rulesUrl: null,
          verifyButtonEmoji: null,
          deliveryMode: "dm" as const,
          verificationMethod: "steam-link" as const,
          welcomeChannelId: null,
          panelMessageId: null,
          updatedAtMs: 0,
        }),
        upsertConfig: async () => {},
        readVerificationState: async () => null,
        upsertVerificationState: async () => {},
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/member-verification/send-welcome-dm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1", userId: "user-1" }),
    }),
  );

  assert.equal(response.status, 402);
  assert.equal(
    ((await response.json()) as { error: string }).error,
    "Enhanced verification methods require a paid plan.",
  );
});

test("createRuntimeApp exposes dashboard overview data for discoverability in the admin UI", async () => {
  const timedRoles: TimedRoleAssignment[] = [
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      durationInput: "1h",
      expiresAtMs: 3_600_000,
    },
    {
      guildId: "guild-2",
      userId: "user-2",
      roleId: "role-2",
      durationInput: "2h",
      expiresAtMs: 7_200_000,
    },
  ];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "overview-bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readConfig() {
        return {
          guilds: {
            "guild-1": { enabled: true, emojis: ["✅", "🍎"] },
            "guild-3": { enabled: true, emojis: ["🚫"] },
          },
          botUserId: "bot-user-id",
        };
      },
      async listTimedRoles() {
        return timedRoles;
      },
    }),
    gateway: {
      async status() {
        return {
          status: "ready",
          sessionId: "session-123",
          resumeGatewayUrl: "wss://resume.discord.gg/?v=10&encoding=json",
          lastSequence: 99,
          backoffAttempt: 0,
          lastError: null,
          heartbeatIntervalMs: 45_000,
        };
      },
    } as GatewayController,
  });
  const response = await app.fetch(new Request("https://runtime.example/admin/api/overview", {}));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    gateway: {
      status: "ready",
      sessionId: "session-123",
      resumeGatewayUrl: "wss://resume.discord.gg/?v=10&encoding=json",
      lastSequence: 99,
      backoffAttempt: 0,
      lastError: null,
      heartbeatIntervalMs: 45_000,
    },
    guilds: [
      {
        guildId: "guild-1",
        emojis: ["✅", "🍎"],
        timedRoles: [
          {
            guildId: "guild-1",
            userId: "user-1",
            roleId: "role-1",
            durationInput: "1h",
            expiresAtMs: 3_600_000,
          },
        ],
        roleNamesById: {},
      },
      {
        guildId: "guild-2",
        emojis: [],
        timedRoles: [
          {
            guildId: "guild-2",
            userId: "user-2",
            roleId: "role-2",
            durationInput: "2h",
            expiresAtMs: 7_200_000,
          },
        ],
        roleNamesById: {},
      },
      {
        guildId: "guild-3",
        emojis: ["🚫"],
        timedRoles: [],
        roleNamesById: {},
      },
    ],
  });
});

test("createRuntimeApp exposes the bot guild directory for the admin UI", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/users/@me/guilds")) {
      return Response.json([
        { id: "guild-2", name: "Alpha" },
        { id: "guild-3", name: "Alpha" },
        { id: "guild-1", name: "Bravo" },
      ]);
    }

    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "directory-bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
      gateway: {} as GatewayController,
    });
    const response = await app.fetch(new Request("https://runtime.example/admin/api/guilds", {}));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      guilds: [
        { guildId: "guild-2", name: "Alpha", label: "Alpha (guild-2)", icon: null },
        { guildId: "guild-3", name: "Alpha", label: "Alpha (guild-3)", icon: null },
        { guildId: "guild-1", name: "Bravo", label: "Bravo", icon: null },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp returns a JSON error when Discord rate limits the guild directory", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/users/@me/guilds")) {
      return Response.json(
        { message: "You are being rate limited.", retry_after: 0.52, global: false },
        { status: 429 },
      );
    }

    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "rate-limited-bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
      gateway: {} as GatewayController,
    });
    const response = await app.fetch(new Request("https://runtime.example/admin/api/guilds", {}));

    assert.equal(response.status, 429);
    const body = (await response.json()) as { code: string; retryAfterSeconds: number };
    assert.equal(body.code, "discord_rate_limited");
    assert.equal(body.retryAfterSeconds, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp filters customer overview and guild directory to linked workspace guilds", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/users/@me/guilds")) {
      return Response.json([
        { id: "guild-1", name: "Allowed" },
        { id: "guild-2", name: "Blocked" },
      ]);
    }

    return Response.json([]);
  }) as typeof fetch;

  try {
    const app = createTestRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      customerAuth: createCustomerAuthMock({
        organizations: [{ id: "workspace-1", name: "Workspace", slug: "workspace", role: "owner" }],
      }),
      workspaceStore: createWorkspaceStoreMock(["guild-1"]),
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readConfig() {
          return {
            guilds: {
              "guild-1": { enabled: true, emojis: ["✅"] },
              "guild-2": { enabled: true, emojis: ["🚫"] },
            },
            botUserId: "bot-user-id",
          };
        },
        async listTimedRoles() {
          return [
            {
              guildId: "guild-2",
              userId: "user-2",
              roleId: "role-2",
              durationInput: "1h",
              expiresAtMs: 1,
            },
          ];
        },
      }),
      gateway: {
        async status() {
          return {
            status: "ready",
            sessionId: null,
            resumeGatewayUrl: null,
            lastSequence: null,
            backoffAttempt: 0,
            lastError: null,
            heartbeatIntervalMs: null,
          };
        },
      } as GatewayController,
    });

    const overviewResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/overview?workspaceId=workspace-1"),
    );
    assert.equal(overviewResponse.status, 200);
    assert.deepEqual(
      ((await overviewResponse.json()) as { guilds: Array<{ guildId: string }> }).guilds.map(
        (guild) => guild.guildId,
      ),
      ["guild-1"],
    );

    const guildsResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/guilds?workspaceId=workspace-1&refresh=1"),
    );
    assert.equal(guildsResponse.status, 200);
    assert.deepEqual(await guildsResponse.json(), {
      guilds: [{ guildId: "guild-1", name: "Allowed", label: "Allowed", icon: null }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp allows workspace-linked guild reads on the blocklist route", async () => {
  const app = createTestRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    customerAuth: createCustomerAuthMock({
      organizations: [{ id: "workspace-1", name: "Workspace", slug: "workspace", role: "owner" }],
    }),
    workspaceStore: createWorkspaceStoreMock(["guild-1"]),
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readConfig() {
        return {
          guilds: {
            "guild-1": { enabled: true, emojis: ["✅"] },
          },
          botUserId: "bot-user-id",
        };
      },
    }),
    gateway: {
      async status() {
        return { status: "ready" };
      },
    } as GatewayController,
  });

  const response = await app.fetch(
    new Request(
      "https://runtime.example/admin/api/blocklist?workspaceId=workspace-1&guildId=guild-1",
    ),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    guildId: "guild-1",
    enabled: true,
    emojis: ["✅"],
    channelMode: "include",
    channelIds: [],
    notificationChannelId: null,
  });
});

test("createRuntimeApp allows workspace-linked guild writes on the blocklist route", async () => {
  const writes: string[] = [];
  const app = createTestRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    customerAuth: createCustomerAuthMock({
      organizations: [{ id: "workspace-1", name: "Workspace", slug: "workspace", role: "owner" }],
    }),
    workspaceStore: createWorkspaceStoreMock(["guild-1"]),
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readConfig() {
        return {
          guilds: {
            "guild-1": { enabled: true, emojis: ["✅"] },
          },
          botUserId: "bot-user-id",
        };
      },
      applyGuildEmojiMutation: async (mutation: { guildId: string }) => {
        writes.push(mutation.guildId);
        return {
          guilds: {
            "guild-1": { enabled: true, emojis: ["✅", "🛑"] },
          },
          botUserId: "bot-user-id",
        };
      },
    }),
    gateway: {
      async status() {
        return { status: "ready" };
      },
    } as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/blocklist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        guildId: "guild-1",
        emoji: "🛑",
        action: "add",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(writes, ["guild-1"]);
});

test("createRuntimeApp processes LFG expiry and reminder lifecycle during scheduled refresh", async () => {
  const lifecycleCalls: string[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async listExpiredTimedRoles() {
        return [];
      },
      async listPlayerCountServers() {
        return [];
      },
      async listAllPlayerCountServers() {
        return [];
      },
    }),
    gateway: {} as GatewayController,
    features: { ...ALL_FEATURES_ENABLED, playerCount: false },
    services: {
      lfgService: {
        async processDueExpiries() {
          lifecycleCalls.push("expire");
        },
        async sendDueRenewalReminders() {
          lifecycleCalls.push("remind");
        },
      } as never,
    },
  });

  await app.refreshPlayerCount();

  assert.deepEqual(lifecycleCalls, ["expire", "remind"]);
});

test("createRuntimeApp processes due Scheduled Publishes during scheduled refresh", async () => {
  const lifecycleCalls: string[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async listExpiredTimedRoles() {
        return [];
      },
      async listPlayerCountServers() {
        return [];
      },
      async listAllPlayerCountServers() {
        return [];
      },
    }),
    gateway: {} as GatewayController,
    features: { ...ALL_FEATURES_ENABLED, playerCount: false },
    services: {
      managedMessageService: {
        async processScheduledDrafts() {
          lifecycleCalls.push("managed-message-publish");
          return { published: 1, failed: 0, retrying: 0 };
        },
      } as never,
    },
  });

  await app.refreshPlayerCount();

  assert.deepEqual(lifecycleCalls, ["managed-message-publish"]);
});

test("createRuntimeApp isolates Billing reconciliation failures from scheduled maintenance", async () => {
  const lifecycleCalls: string[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async listExpiredTimedRoles() {
        lifecycleCalls.push("timed-roles");
        return [];
      },
      async listPlayerCountServers() {
        return [];
      },
      async listAllPlayerCountServers() {
        return [];
      },
    }),
    gateway: {} as GatewayController,
    features: { ...ALL_FEATURES_ENABLED, playerCount: false },
    reconcileBillingOwners: async () => {
      throw new Error("Stripe unavailable");
    },
    services: {
      lfgService: {
        async processDueExpiries() {
          lifecycleCalls.push("lfg-expire");
        },
        async sendDueRenewalReminders() {
          lifecycleCalls.push("lfg-remind");
        },
      } as never,
    },
  });

  await app.refreshPlayerCount();

  assert.deepEqual(lifecycleCalls, ["timed-roles", "lfg-expire", "lfg-remind"]);
});

test("scheduled task reporting is isolated and later independent work still runs", async () => {
  const reports: Array<{ code: string; message: string }> = [];
  const lifecycleCalls: string[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    reportOperationalEvent: (event: OperationalEvent) => {
      reports.push({ code: event.code, message: event.message });
      throw new Error("telemetry unavailable");
    },
    stores: createRuntimeStoresWithOverrides({
      async listExpiredTimedRoles() {
        lifecycleCalls.push("timed-roles");
        return [];
      },
      async listPlayerCountServers() {
        return [];
      },
      async listAllPlayerCountServers() {
        return [];
      },
    }),
    gateway: {} as GatewayController,
    features: { ...ALL_FEATURES_ENABLED, playerCount: false },
    reconcileBillingOwners: async () => {
      throw new Error("Stripe unavailable");
    },
    services: {
      lfgService: {
        async processDueExpiries() {
          lifecycleCalls.push("lfg-expire");
          throw new Error("LFG unavailable");
        },
        async sendDueRenewalReminders() {
          lifecycleCalls.push("lfg-remind");
        },
      } as never,
    },
  });

  await app.refreshPlayerCount();

  assert.deepEqual(lifecycleCalls, ["timed-roles", "lfg-expire", "lfg-remind"]);
  assert.deepEqual(reports, [
    { code: "scheduled.task_failed", message: "Billing owner reconciliation failed" },
    { code: "scheduled.task_failed", message: "LFG expiry processing failed" },
  ]);
});

test("scheduled Player Count child failures use the runtime reporter once and still rename channels", async () => {
  const fixture = createProductionRuntimeStores();
  const reports: OperationalEvent[] = [];
  const originalFetch = globalThis.fetch;
  const channelRenames: unknown[] = [];
  globalThis.fetch = async (input, options) => {
    assert.match(String(input), /\/channels\/voice-failed$/);
    assert.equal(options?.method, "PATCH");
    channelRenames.push(JSON.parse(String(options.body)));
    return Response.json({ id: "voice-failed" });
  };
  try {
    await fixture.stores.playerCount.upsertPlayerCountServer({
      id: "failed-server",
      guildId: "guild-1",
      name: "Fixture",
      provider: "steam-web",
      providerServerId: "440",
      channelId: "voice-failed",
      alertChannelId: null,
      refreshIntervalMinutes: 10,
      displayFormat: "Players {count}/{max}",
      offlineFormat: "Offline",
      failureThreshold: 3,
      renameOffsetMinutes: 0,
      lastRenamedAtMs: null,
      lastPlayerCount: null,
      lastMaxSlots: null,
      lastQueueSize: null,
      lastFetchedAtMs: null,
      consecutiveFailureCount: 0,
      lastErrorMessage: null,
      lastErrorAtMs: null,
      steamHost: null,
      steamPort: null,
      createdAtMs: 0,
      updatedAtMs: 0,
    });
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      reportOperationalEvent: (event) => reports.push(event),
      stores: {
        ...fixture.stores,
        guildEntitlements: {
          async readGuildEntitlement(guildId) {
            return { guildId, tier: "premium", updatedAtMs: 0 };
          },
        },
        playerCount: withStoreOverrides(fixture.stores.playerCount, {
          async incrementPlayerCountFailure() {
            throw new Error("Snapshot persistence unavailable");
          },
        }),
      },
      gateway: {} as GatewayController,
      features: { ...ALL_FEATURES_ENABLED, lfg: false, events: false, playerCount: true },
    });

    await app.refreshPlayerCount();

    assert.deepEqual(
      reports.map(({ code, guildId, operation, context }) => ({
        code,
        guildId,
        operation,
        context,
      })),
      [
        {
          code: "player_count.server_refresh_failed",
          guildId: "guild-1",
          operation: "refresh_player_count",
          context: { serverId: "failed-server" },
        },
      ],
    );
    assert.deepEqual(channelRenames, [{ name: "Offline" }]);
    assert.ok(
      (await fixture.stores.playerCount.readPlayerCountServer("failed-server"))?.lastRenamedAtMs,
    );
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

test("player-count scheduled failure reports once and does not escape", async () => {
  const reports: OperationalEvent[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    reportOperationalEvent: (event) => reports.push(event),
    stores: createRuntimeStoresWithOverrides({
      async listExpiredTimedRoles() {
        return [];
      },
      async listPlayerCountServers() {
        return [];
      },
      async listAllPlayerCountServers() {
        return [];
      },
    }),
    gateway: {} as GatewayController,
    features: { ...ALL_FEATURES_ENABLED, lfg: false, events: false, playerCount: true },
    services: {
      playerCountService: {
        async refreshAllServers() {
          throw new Error("player count unavailable");
        },
        async renameDueChannels() {},
      } as never,
    },
  });

  await app.refreshPlayerCount();
  assert.deepEqual(
    reports.map(({ code, operation }) => ({ code, operation })),
    [{ code: "scheduled.player_count_refresh_failed", operation: "refresh_player_count" }],
  );
});

test("createRuntimeApp skips LFG lifecycle processing when the LFG feature is disabled", async () => {
  const lifecycleCalls: string[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async listExpiredTimedRoles() {
        return [];
      },
      async listPlayerCountServers() {
        return [];
      },
      async listAllPlayerCountServers() {
        return [];
      },
    }),
    gateway: {} as GatewayController,
    features: { ...ALL_FEATURES_ENABLED, lfg: false, playerCount: false },
    services: {
      lfgService: {
        async processDueExpiries() {
          lifecycleCalls.push("expire");
        },
        async sendDueRenewalReminders() {
          lifecycleCalls.push("remind");
        },
      } as never,
    },
  });

  await app.refreshPlayerCount();

  assert.deepEqual(lifecycleCalls, []);
});

test("createRuntimeApp authorizes guild admin users for guild-scoped admin APIs", async () => {
  const originalFetch = globalThis.fetch;
  const discordCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    discordCalls.push(url);

    if (url.endsWith("/users/@me/guilds")) {
      return Response.json([
        { id: "guild-1", name: "Allowed" },
        { id: "guild-2", name: "Blocked" },
        { id: "guild-3", name: "Unconfigured" },
      ]);
    }
    if (url.endsWith("/guilds/guild-1/members/discord-user-1")) {
      return Response.json({ user: { id: "discord-user-1" }, roles: ["guild-admin-role"] });
    }
    if (url.endsWith("/guilds/guild-2/members/discord-user-1")) {
      return Response.json({ user: { id: "discord-user-1" }, roles: ["not-admin-role"] });
    }
    if (url.endsWith("/channels")) {
      return Response.json([]);
    }
    if (url.endsWith("/roles")) {
      return Response.json([]);
    }
    if (url.endsWith("/members/bot-user-id")) {
      return Response.json({ user: { id: "bot-user-id" }, roles: [] });
    }

    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const writes: string[] = [];
    const guildAdminRoleWrites: Array<{ guildId: string; roleId: string | null }> = [];
    const app = createTestRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "guild-admin-bot-token",
      customerAuth: createCustomerAuthMock({ organizations: [] }),
      guildResources: createPermissiveGuildResourceValidator(),
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        readGuildAdminRoleId: async (guildId: string) =>
          guildId === "guild-1" ? "guild-admin-role" : "other-admin-role",
        listGuildAdminRoleAssignments: async () => [
          { guildId: "guild-1", roleId: "guild-admin-role" },
          { guildId: "guild-2", roleId: "other-admin-role" },
        ],
        upsertGuildAdminRoleId: async (guildId: string, roleId: string | null) => {
          guildAdminRoleWrites.push({ guildId, roleId });
        },
        async readConfig() {
          return {
            guilds: {
              "guild-1": { enabled: true, emojis: ["✅"] },
              "guild-2": { enabled: true, emojis: ["🚫"] },
            },
            botUserId: "bot-user-id",
          };
        },
        applyGuildEmojiMutation: async (mutation: { guildId: string }) => {
          writes.push(mutation.guildId);
          return { guilds: {}, botUserId: "bot-user-id" };
        },
      }),
      gateway: {
        async status() {
          return { status: "ready" };
        },
      } as unknown as GatewayController,
    });

    const guildsResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/guilds?refresh=1"),
    );
    assert.equal(guildsResponse.status, 200);
    assert.deepEqual(await guildsResponse.json(), {
      guilds: [{ guildId: "guild-1", name: "Allowed", label: "Allowed", icon: null }],
    });
    assert.equal(
      discordCalls.some((url) => url.includes("/guilds/guild-3/members/")),
      false,
    );

    const overviewResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/overview?refresh=1"),
    );
    assert.equal(overviewResponse.status, 200);
    assert.deepEqual(
      ((await overviewResponse.json()) as { guilds: Array<{ guildId: string }> }).guilds.map(
        (guild) => guild.guildId,
      ),
      ["guild-1"],
    );

    const readResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/blocklist?guildId=guild-1"),
    );
    assert.equal(readResponse.status, 200);

    const writeResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/blocklist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1", emoji: "🛑", action: "add" }),
      }),
    );
    assert.equal(writeResponse.status, 200);
    assert.deepEqual(writes, ["guild-1"]);

    const guildAdminRoleResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/guild-rbac/admin-role", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1", adminRoleId: "222222222222222222" }),
      }),
    );
    assert.equal(guildAdminRoleResponse.status, 403);
    assert.deepEqual(guildAdminRoleWrites, []);

    const blockedGuildResponse = await app.fetch(
      new Request(
        "https://runtime.example/admin/api/blocklist?workspaceId=workspace-1&guildId=guild-2",
      ),
    );
    assert.equal(blockedGuildResponse.status, 403);
    assert.equal(((await blockedGuildResponse.json()) as { error: string }).error, "Forbidden");
    assert.ok(discordCalls.some((url) => url.endsWith("/guilds/guild-1/members/discord-user-1")));
    assert.equal(
      discordCalls.some((url) => url.endsWith("/guilds/guild-2/members/discord-user-1")),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp exposes bot guilds where social users have Discord manager permissions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const authorization = new Headers(init?.headers).get("Authorization");

    if (url.endsWith("/users/@me/guilds") && authorization === "Bot manager-bot-token") {
      return Response.json([
        { id: "guild-1", name: "Managed" },
        { id: "guild-2", name: "Member Only" },
      ]);
    }
    if (url.endsWith("/users/@me/guilds") && authorization === "Bearer manager-user-token") {
      return Response.json([
        { id: "guild-1", name: "Managed", owner: false, permissions: String(1n << 5n) },
        { id: "guild-2", name: "Member Only", owner: false, permissions: "0" },
      ]);
    }
    if (url.endsWith("/guilds/guild-1/members/discord-user-1")) {
      return Response.json({ user: { id: "discord-user-1" }, roles: ["manager-role"] });
    }
    if (url.endsWith("/guilds/guild-2/members/discord-user-1")) {
      return Response.json({ user: { id: "discord-user-1" }, roles: ["member-role"] });
    }
    if (url.endsWith("/guilds/guild-1/roles")) {
      return Response.json([
        { id: "guild-1", name: "@everyone", permissions: "0", position: 0 },
        { id: "manager-role", name: "Manager", permissions: "32", position: 1 },
      ]);
    }
    if (url.endsWith("/guilds/guild-2/roles")) {
      return Response.json([
        { id: "guild-2", name: "@everyone", permissions: "0", position: 0 },
        { id: "member-role", name: "Member", permissions: "0", position: 1 },
      ]);
    }
    if (url.endsWith("/channels")) {
      return Response.json([]);
    }
    if (url.endsWith("/members/bot-user-id")) {
      return Response.json({ user: { id: "bot-user-id" }, roles: [] });
    }

    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createTestRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "manager-bot-token",
      customerAuth: createCustomerAuthMock({ organizations: [] }),
      discordAccounts: {
        readDiscordAccessToken: async () => "manager-user-token",
      },
      workspaceStore: createWorkspaceStoreMock([]),
      guildResources: createPermissiveGuildResourceValidator(),
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        readGuildAdminRoleId: async () => null,
        async readConfig() {
          return {
            guilds: {
              "guild-1": { enabled: true, emojis: ["✅"] },
              "guild-2": { enabled: true, emojis: ["🚫"] },
            },
            botUserId: "bot-user-id",
          };
        },
      }),
      gateway: {
        async status() {
          return { status: "ready" };
        },
      } as unknown as GatewayController,
    });

    const guildsResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/guilds?refresh=1"),
    );
    assert.equal(guildsResponse.status, 200);
    assert.deepEqual(await guildsResponse.json(), {
      guilds: [{ guildId: "guild-1", name: "Managed", label: "Managed", icon: null }],
    });

    const overviewResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/overview?refresh=1"),
    );
    assert.equal(overviewResponse.status, 200);
    assert.deepEqual(
      ((await overviewResponse.json()) as { guilds: Array<{ guildId: string }> }).guilds.map(
        (guild) => guild.guildId,
      ),
      ["guild-1"],
    );

    const allowedResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/blocklist?guildId=guild-1"),
    );
    assert.equal(allowedResponse.status, 200);

    const guildAdminRoleResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/guild-rbac/admin-role", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1", adminRoleId: "222222222222222222" }),
      }),
    );
    assert.equal(guildAdminRoleResponse.status, 403);

    const blockedResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/blocklist?guildId=guild-2"),
    );
    assert.equal(blockedResponse.status, 403);
    assert.equal(((await blockedResponse.json()) as { error: string }).error, "Forbidden");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp caches guild-admin directory lookups until refresh is requested", async () => {
  const originalFetch = globalThis.fetch;
  let botGuildListCallCount = 0;
  let userGuildListCallCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const authorization = new Headers(init?.headers).get("Authorization");

    if (url.endsWith("/users/@me/guilds") && authorization === "Bot refresh-directory-bot-token") {
      botGuildListCallCount += 1;
      return Response.json(
        botGuildListCallCount === 1
          ? [{ id: "guild-1", name: "First Guild" }]
          : [
              { id: "guild-1", name: "First Guild" },
              { id: "guild-2", name: "Second Guild" },
            ],
      );
    }
    if (url.endsWith("/users/@me/guilds") && authorization === "Bearer refresh-user-token") {
      userGuildListCallCount += 1;
      return Response.json(
        userGuildListCallCount === 1
          ? [{ id: "guild-1", name: "First Guild", owner: false, permissions: String(1n << 5n) }]
          : [
              { id: "guild-1", name: "First Guild", owner: false, permissions: String(1n << 5n) },
              { id: "guild-2", name: "Second Guild", owner: false, permissions: String(1n << 5n) },
            ],
      );
    }
    if (url.endsWith("/guilds/guild-1/members/discord-user-1")) {
      return Response.json({ user: { id: "discord-user-1" }, roles: ["manager-role-1"] });
    }
    if (url.endsWith("/guilds/guild-2/members/discord-user-1")) {
      return Response.json({ user: { id: "discord-user-1" }, roles: ["manager-role-2"] });
    }
    if (url.endsWith("/guilds/guild-1/roles")) {
      return Response.json([
        { id: "guild-1", name: "@everyone", permissions: "0", position: 0 },
        { id: "manager-role-1", name: "Manager 1", permissions: "32", position: 1 },
      ]);
    }
    if (url.endsWith("/guilds/guild-2/roles")) {
      return Response.json([
        { id: "guild-2", name: "@everyone", permissions: "0", position: 0 },
        { id: "manager-role-2", name: "Manager 2", permissions: "32", position: 1 },
      ]);
    }
    if (url.endsWith("/channels")) {
      return Response.json([]);
    }
    if (url.endsWith("/members/bot-user-id")) {
      return Response.json({ user: { id: "bot-user-id" }, roles: [] });
    }

    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createTestRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "refresh-directory-bot-token",
      customerAuth: createCustomerAuthMock({ organizations: [] }),
      discordAccounts: {
        readDiscordAccessToken: async () => "refresh-user-token",
      },
      workspaceStore: createWorkspaceStoreMock([]),
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        readGuildAdminRoleId: async () => null,
        async readConfig() {
          return {
            guilds: {
              "guild-1": { enabled: true, emojis: ["✅"] },
              "guild-2": { enabled: true, emojis: ["🚫"] },
            },
            botUserId: "bot-user-id",
          };
        },
      }),
      gateway: {
        async status() {
          return { status: "ready" };
        },
      } as unknown as GatewayController,
    });

    const firstResponse = await app.fetch(new Request("https://runtime.example/admin/api/guilds"));
    assert.equal(firstResponse.status, 200);
    assert.deepEqual(await firstResponse.json(), {
      guilds: [{ guildId: "guild-1", name: "First Guild", label: "First Guild", icon: null }],
    });

    const secondResponse = await app.fetch(new Request("https://runtime.example/admin/api/guilds"));
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(await secondResponse.json(), {
      guilds: [{ guildId: "guild-1", name: "First Guild", label: "First Guild", icon: null }],
    });

    const refreshResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/guilds?refresh=1"),
    );
    assert.equal(refreshResponse.status, 200);
    assert.deepEqual(await refreshResponse.json(), {
      guilds: [
        { guildId: "guild-1", name: "First Guild", label: "First Guild", icon: null },
        { guildId: "guild-2", name: "Second Guild", label: "Second Guild", icon: null },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp reads current user guilds from KV on a fresh guild-admin directory cache miss", async () => {
  const originalFetch = globalThis.fetch;
  const discordRequests: Array<{ url: string; authorization: string | null }> = [];
  const kvGets: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const authorization = new Headers(init?.headers).get("Authorization");
    discordRequests.push({ url, authorization });
    return Response.json([{ id: "guild-discord", name: "Discord Guild" }]);
  }) as typeof fetch;

  try {
    const app = createTestRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "kv-user-directory-bot-token",
      customerAuth: createCustomerAuthMock({ organizations: [] }),
      discordAccounts: {
        readDiscordAccessToken: async () => "kv-user-directory-oauth-token",
      },
      workspaceStore: createWorkspaceStoreMock([]),
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        readGuildAdminRoleId: async () => null,
        async readConfig() {
          return {
            guilds: { "guild-kv": { enabled: true, emojis: ["✅"] } },
            botUserId: "bot-user-id",
          };
        },
      }),
      gateway: {} as GatewayController,
      discordCache: {
        async get(key: string) {
          kvGets.push(key);
          if (key === "bot-guilds") {
            return JSON.stringify([{ guildId: "guild-kv", name: "KV Guild" }]);
          }
          if (key === "current-user-guilds:user-1") {
            return JSON.stringify([
              { guildId: "guild-kv", name: "KV Guild", owner: true, permissions: "0" },
            ]);
          }
          return null;
        },
      } as unknown as Cache<string>,
    });

    const response = await app.fetch(new Request("https://runtime.example/admin/api/guilds"));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      guilds: [{ guildId: "guild-kv", name: "KV Guild", label: "KV Guild", icon: null }],
    });
    assert.deepEqual(kvGets, ["bot-guilds", "current-user-guilds:user-1"]);
    assert.deepEqual(discordRequests, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp refresh bypasses KV current user guilds and updates the cache", async () => {
  const originalFetch = globalThis.fetch;
  const kvGets: string[] = [];
  const kvPuts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];
  const discordRequests: Array<{ url: string; authorization: string | null }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const authorization = new Headers(init?.headers).get("Authorization");
    discordRequests.push({ url, authorization });
    if (authorization === "Bot refresh-kv-bot-token") {
      return Response.json([{ id: "guild-refreshed", name: "Refreshed Guild" }]);
    }
    if (authorization === "Bearer refresh-kv-oauth-token") {
      return Response.json([
        { id: "guild-refreshed", name: "Refreshed Guild", owner: true, permissions: "0" },
      ]);
    }
    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createTestRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "refresh-kv-bot-token",
      customerAuth: createCustomerAuthMock({ organizations: [] }),
      discordAccounts: {
        readDiscordAccessToken: async () => "refresh-kv-oauth-token",
      },
      workspaceStore: createWorkspaceStoreMock([]),
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        readGuildAdminRoleId: async () => null,
        async readConfig() {
          return {
            guilds: { "guild-refreshed": { enabled: true, emojis: ["✅"] } },
            botUserId: "bot-user-id",
          };
        },
      }),
      gateway: {} as GatewayController,
      discordCache: {
        async get(key: string) {
          kvGets.push(key);
          return JSON.stringify([{ guildId: "guild-stale", name: "Stale Guild" }]);
        },
        async put(key: string, value: string, options?: { expirationTtl?: number }) {
          kvPuts.push({ key, value, options });
        },
      } as unknown as Cache<string>,
    });

    const response = await app.fetch(
      new Request("https://runtime.example/admin/api/guilds?refresh=1"),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      guilds: [
        {
          guildId: "guild-refreshed",
          name: "Refreshed Guild",
          label: "Refreshed Guild",
          icon: null,
        },
      ],
    });
    assert.deepEqual(kvGets, []);
    assert.deepEqual(
      discordRequests.filter(
        ({ authorization }) => authorization === "Bearer refresh-kv-oauth-token",
      ),
      [
        {
          url: "https://discord.com/api/v10/users/@me/guilds",
          authorization: "Bearer refresh-kv-oauth-token",
        },
      ],
    );
    assert.equal(
      discordRequests.filter(({ authorization }) => authorization === "Bot refresh-kv-bot-token")
        .length,
      1,
    );
    assert.deepEqual(
      kvPuts.filter(({ key }) => key === "current-user-guilds:user-1"),
      [
        {
          key: "current-user-guilds:user-1",
          value: JSON.stringify([
            {
              guildId: "guild-refreshed",
              name: "Refreshed Guild",
              owner: true,
              permissions: "0",
              icon: null,
            },
          ]),
          options: { ttlSeconds: 300 },
        },
      ],
    );
    assert.equal(
      [...kvGets, ...kvPuts.map(({ key }) => key)].some((key) =>
        key.includes("refresh-kv-oauth-token"),
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp exposes bot guilds where the social user is the Discord guild owner", async () => {
  const originalFetch = globalThis.fetch;
  const discordCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const authorization = new Headers(init?.headers).get("Authorization");
    discordCalls.push(url);

    if (url.endsWith("/users/@me/guilds") && authorization === "Bot owner-bot-token") {
      return Response.json([
        { id: "guild-1", name: "Owned Guild" },
        { id: "guild-2", name: "Other Guild" },
      ]);
    }
    if (url.endsWith("/users/@me/guilds") && authorization === "Bearer owner-user-token") {
      return Response.json([
        { id: "guild-1", name: "Owned Guild", owner: true, permissions: "0" },
        { id: "guild-2", name: "Other Guild", owner: false, permissions: "0" },
      ]);
    }
    if (url.endsWith("/guilds/guild-1")) {
      return Response.json({ id: "guild-1", name: "Owned Guild", owner_id: "discord-user-1" });
    }
    if (url.endsWith("/guilds/guild-2")) {
      return Response.json({ id: "guild-2", name: "Other Guild", owner_id: "someone-else" });
    }
    if (url.endsWith("/guilds/guild-1/members/discord-user-1")) {
      return Response.json({ user: { id: "discord-user-1" }, roles: [] });
    }
    if (url.endsWith("/guilds/guild-2/members/discord-user-1")) {
      return Response.json({ user: { id: "discord-user-1" }, roles: [] });
    }
    if (url.endsWith("/guilds/guild-1/roles")) {
      return Response.json([{ id: "guild-1", name: "@everyone", permissions: "0", position: 0 }]);
    }
    if (url.endsWith("/guilds/guild-2/roles")) {
      return Response.json([{ id: "guild-2", name: "@everyone", permissions: "0", position: 0 }]);
    }
    if (url.endsWith("/channels")) {
      return Response.json([]);
    }
    if (url.endsWith("/members/bot-user-id")) {
      return Response.json({ user: { id: "bot-user-id" }, roles: [] });
    }

    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createTestRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "owner-bot-token",
      customerAuth: createCustomerAuthMock({ organizations: [] }),
      discordAccounts: {
        readDiscordAccessToken: async () => "owner-user-token",
      },
      workspaceStore: createWorkspaceStoreMock([]),
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        readGuildAdminRoleId: async () => null,
        async readConfig() {
          return {
            guilds: {
              "guild-1": { enabled: true, emojis: ["✅"] },
              "guild-2": { enabled: true, emojis: ["🚫"] },
            },
            botUserId: "bot-user-id",
          };
        },
      }),
      gateway: {
        async status() {
          return { status: "ready" };
        },
      } as unknown as GatewayController,
    });

    const guildsResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/guilds?refresh=1"),
    );
    assert.equal(guildsResponse.status, 200);
    assert.deepEqual(await guildsResponse.json(), {
      guilds: [{ guildId: "guild-1", name: "Owned Guild", label: "Owned Guild", icon: null }],
    });
    assert.equal(
      discordCalls.some((url) => url.includes("/members/discord-user-1")),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp does not allow guild admin access to workspace APIs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/guilds/guild-1/members/discord-user-1")) {
      return Response.json({ user: { id: "discord-user-1" }, roles: ["guild-admin-role"] });
    }
    return Response.json([]);
  }) as typeof fetch;

  try {
    const app = createTestRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "guild-admin-isolation-bot-token",
      customerAuth: createCustomerAuthMock({ organizations: [], activeRole: "none" as never }),
      workspaceStore: createWorkspaceStoreMock([]),
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        readGuildAdminRoleId: async () => "guild-admin-role",
      }),
      gateway: {
        async status() {
          return { status: "ready" };
        },
      } as unknown as GatewayController,
    });

    const workspacesResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/workspaces"),
    );
    assert.equal(workspacesResponse.status, 200);
    assert.deepEqual(await workspacesResponse.json(), { workspaces: [] });

    const workspaceGuildsResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/workspace-guilds?workspaceId=workspace-1"),
    );
    assert.equal(workspaceGuildsResponse.status, 403);

    const linkResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/workspace-guilds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1", guildId: "guild-1" }),
      }),
    );
    assert.equal(linkResponse.status, 403);

    const configResponse = await app.fetch(new Request("https://runtime.example/admin/api/config"));
    assert.equal(configResponse.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp freshly validates Discord Guild control before linking a workspace Guild", async () => {
  const workspaceStore = createMemoryWorkspaceStore();
  const discoveryCalls: Array<[string, string, boolean | undefined]> = [];
  const beforeLink = Date.now();
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    workspaceStore,
    guildDiscoveryService: {
      async discoverGuildsForUser(authUserId, discordUserId, refresh) {
        discoveryCalls.push([authUserId, discordUserId, refresh]);
        return [
          {
            guildId: "guild-1",
            name: "Managed Guild",
            icon: null,
            isOwner: false,
            canManage: true,
          },
        ];
      },
    },
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {
      async status() {
        return { status: "ready" };
      },
    } as unknown as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/workspace-guilds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace-1", guildId: "guild-1" }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(discoveryCalls, [["user-1", "discord-user-1", true]]);
  assert.equal(await workspaceStore.isGuildLinkedToWorkspace("workspace-1", "guild-1"), true);
  const [auditEvent] = await workspaceStore.listWorkspaceGuildAuditEvents("workspace-1");
  assert.equal(auditEvent.action, "linked");
  assert.equal(auditEvent.actorUserId, "user-1");
  assert.equal(auditEvent.guildId, "guild-1");
  assert.equal(auditEvent.previousWorkspaceId, null);
  assert.ok(auditEvent.occurredAtMs >= beforeLink);
});

test("createRuntimeApp fails closed when fresh bot Guild membership is rate limited", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceStore = createMemoryWorkspaceStore();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const authorization = new Headers(init?.headers).get("Authorization");
    if (!url.endsWith("/users/@me/guilds")) {
      throw new Error(`Unexpected Discord call: ${url}`);
    }
    if (authorization === "Bot strict-link-bot-token") {
      return Response.json({ retry_after: 0.01, global: false }, { status: 429 });
    }
    if (authorization === "Bearer strict-link-user-token") {
      return Response.json([
        {
          id: "guild-1",
          name: "Managed Guild",
          owner: true,
          permissions: "0",
        },
      ]);
    }
    throw new Error(`Unexpected Discord authorization: ${authorization}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "strict-link-bot-token",
      discordAccounts: {
        readDiscordAccessToken: async () => "strict-link-user-token",
      },
      discordCache: {
        async get(key: string) {
          return key === "bot-guilds"
            ? JSON.stringify([{ guildId: "guild-1", name: "Stale Guild", icon: null }])
            : null;
        },
        async put() {},
      } as unknown as Cache<string>,
      workspaceStore,
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
      gateway: {
        async status() {
          return { status: "ready" };
        },
      } as unknown as GatewayController,
    });

    const response = await app.fetch(
      new Request("https://runtime.example/admin/api/workspace-guilds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1", guildId: "guild-1" }),
      }),
    );

    assert.equal(response.status, 403);
    assert.equal(await workspaceStore.isGuildLinkedToWorkspace("workspace-1", "guild-1"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp gives the same generic denial for unavailable and linked Guilds", async () => {
  const denialBodies: unknown[] = [];

  for (const scenario of ["ineligible", "oauth-failure", "linked-elsewhere"] as const) {
    const workspaceStore = createMemoryWorkspaceStore();
    if (scenario === "linked-elsewhere") {
      await workspaceStore.linkGuildToWorkspace({
        workspaceId: "workspace-2",
        guildId: "guild-1",
        linkedByUserId: "other-user",
        linkedAtMs: 1,
      });
    }

    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      workspaceStore,
      guildDiscoveryService: {
        async discoverGuildsForUser() {
          if (scenario === "oauth-failure") {
            throw new Error("Discord OAuth failed");
          }
          if (scenario === "ineligible") {
            return [];
          }
          return [
            {
              guildId: "guild-1",
              name: "Managed Guild",
              icon: null,
              isOwner: true,
              canManage: true,
            },
          ];
        },
      },
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
      gateway: {
        async status() {
          return { status: "ready" };
        },
      } as unknown as GatewayController,
    });

    const response = await app.fetch(
      new Request("https://runtime.example/admin/api/workspace-guilds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1", guildId: "guild-1" }),
      }),
    );

    assert.equal(response.status, 403, scenario);
    const denialBody = (await response.json()) as {
      error?: unknown;
      code?: unknown;
      retryable?: unknown;
      correlationId?: unknown;
    };
    assert.equal(typeof denialBody.correlationId, "string", scenario);
    denialBodies.push({
      error: denialBody.error,
      code: denialBody.code,
      retryable: denialBody.retryable,
    });
    assert.equal(
      await workspaceStore.isGuildLinkedToWorkspace("workspace-1", "guild-1"),
      false,
      scenario,
    );
  }

  assert.deepEqual(denialBodies, [
    {
      error: "Forbidden",
      code: "permission_denied",
      retryable: false,
    },
    {
      error: "Forbidden",
      code: "permission_denied",
      retryable: false,
    },
    {
      error: "Forbidden",
      code: "permission_denied",
      retryable: false,
    },
  ]);
});

test("createRuntimeApp rejects legacy global admin sessions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/users/@me/guilds")) {
      return Response.json([
        { id: "guild-1", name: "Allowed" },
        { id: "guild-2", name: "Global" },
      ]);
    }

    return Response.json([]);
  }) as typeof fetch;

  try {
    const app = createTestRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      customerAuth: createCustomerAuthMock({
        organizations: [{ id: "workspace-1", name: "Workspace", slug: "workspace", role: "owner" }],
      }),
      workspaceStore: createWorkspaceStoreMock(["guild-1"]),
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
      gateway: {
        async status() {
          return {
            status: "ready",
            sessionId: null,
            resumeGatewayUrl: null,
            lastSequence: null,
            backoffAttempt: 0,
            lastError: null,
            heartbeatIntervalMs: null,
          };
        },
      } as unknown as GatewayController,
    });

    const cookie = await createAdminSessionCookie("session-secret");
    const guildDirectoryResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/guilds?refresh=1", {
        headers: { cookie },
      }),
    );
    assert.equal(guildDirectoryResponse.status, 200);
    const guildIds = (
      (await guildDirectoryResponse.json()) as { guilds: Array<{ guildId: string }> }
    ).guilds.map((guild) => guild.guildId);
    assert.deepEqual(guildIds, ["guild-1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp exposes live blocklist permission diagnostics through session auth", async () => {
  const originalFetch = globalThis.fetch;
  const VIEW_CHANNEL = 1n << 10n;
  const SEND_MESSAGES = 1n << 11n;
  const MANAGE_MESSAGES = 1n << 13n;
  const BOT_ROLE_PERMISSIONS = (VIEW_CHANNEL | SEND_MESSAGES | MANAGE_MESSAGES).toString();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/guilds/guild-1/channels")) {
      return Response.json([
        {
          id: "channel-1",
          name: "general",
          type: 0,
          parent_id: null,
          position: 0,
          permission_overwrites: [],
        },
        {
          id: "channel-2",
          name: "staff",
          type: 0,
          parent_id: null,
          position: 1,
          permission_overwrites: [
            {
              id: "guild-1",
              type: 0,
              allow: "0",
              deny: MANAGE_MESSAGES.toString(),
            },
          ],
        },
      ]);
    }

    if (url.endsWith("/guilds/guild-1/roles")) {
      return Response.json([
        { id: "guild-1", name: "@everyone", permissions: VIEW_CHANNEL.toString(), position: 0 },
        { id: "role-bot", name: "Bot", permissions: BOT_ROLE_PERMISSIONS, position: 5 },
      ]);
    }

    if (url.endsWith("/guilds/guild-1/members/bot-user-id")) {
      return Response.json({
        user: { id: "bot-user-id" },
        roles: ["role-bot"],
      });
    }

    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readConfig() {
          return {
            guilds: { "guild-1": { enabled: true, emojis: ["🚫"] } },
            botUserId: "bot-user-id",
          };
        },
      }),
      gateway: {} as GatewayController,
    });
    const response = await app.fetch(
      new Request(
        "https://runtime.example/admin/api/permissions?guildId=guild-1&feature=blocklist",
        {},
      ),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      guildId: "guild-1",
      feature: "blocklist",
      checks: [
        {
          id: "blocklist-visible-text-channels",
          label: "Visible text channels",
          status: "ok",
          detail: "The bot can view 2 of 2 text channels in this server.",
        },
        {
          id: "blocklist-manage-messages",
          label: "Manage Messages in text channels",
          status: "warning",
          detail:
            "Manage Messages is missing in 1 of 2 visible text channels, so reaction cleanup can fail there.",
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp exposes timed-role admin APIs through session auth", async () => {
  const calls: string[] = [];
  const notificationBodies: CreateChannelMessageInput[] = [];
  const assignments: TimedRoleAssignment[] = [
    {
      guildId: "guild-1",
      userId: "user-1",
      roleId: "role-1",
      durationInput: "1h",
      expiresAtMs: 3_600_000,
    },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(`${init?.method ?? "GET"}:${url}`);
    if (url.includes("/channels/log-channel-1/messages") && init?.body) {
      notificationBodies.push(JSON.parse(String(init.body)));
      return Response.json({ id: "message-1", channel_id: "log-channel-1", content: "ok" });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readConfig() {
          return { guilds: {}, botUserId: "bot-user-id" };
        },
        async readGuildNotificationChannel(guildId: string, feature: string) {
          return guildId === "guild-1" && feature === "timed-role" ? "log-channel-1" : null;
        },
        async listTimedRolesByGuild(guildId: string) {
          return assignments.filter((assignment) => assignment.guildId === guildId);
        },
        async upsertTimedRole(body: TimedRoleAssignment) {
          assignments.push(body);
        },
        async deleteTimedRole(body: { guildId: string; userId: string; roleId: string }) {
          const index = assignments.findIndex(
            (assignment) =>
              assignment.guildId === body.guildId &&
              assignment.userId === body.userId &&
              assignment.roleId === body.roleId,
          );
          if (index >= 0) {
            assignments.splice(index, 1);
          }
        },
      }),
      gateway: {} as GatewayController,
    });

    const listResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/timed-roles?guildId=guild-1", {}),
    );
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), {
      guildId: "guild-1",
      assignments,
      notificationChannelId: "log-channel-1",
      newMemberRoleConfig: {
        guildId: "guild-1",
        roles: [],
      },
      manualAssignmentRoleConfig: {
        guildId: "guild-1",
        roles: [],
      },
    });

    const addResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/timed-roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "add",
          guildId: "guild-1",
          userId: "user-2",
          roleId: "role-2",
          duration: "2h",
        }),
      }),
    );
    assert.equal(addResponse.status, 200);

    const removeResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/timed-roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "remove",
          guildId: "guild-1",
          userId: "user-1",
          roleId: "role-1",
        }),
      }),
    );
    assert.equal(removeResponse.status, 200);
    assert.deepEqual(calls, [
      "PUT:https://discord.com/api/v10/guilds/guild-1/members/user-2/roles/role-2",
      "POST:https://discord.com/api/v10/channels/log-channel-1/messages",
      "DELETE:https://discord.com/api/v10/guilds/guild-1/members/user-1/roles/role-1",
      "POST:https://discord.com/api/v10/channels/log-channel-1/messages",
    ]);
    const removeNotification = notificationBodies[1];
    assert.deepEqual(removeNotification?.embeds?.[0]?.fields, [
      { name: "Actor", value: "Admin dashboard", inline: false },
      { name: "Target Member", value: "<@user-1>\nID: user-1", inline: false },
      { name: "Role", value: "<@&role-1>", inline: false },
      { name: "Duration", value: "1h", inline: false },
      { name: "Expires", value: "<t:3600:R>", inline: false },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp exposes new member timed-role config through session auth", async () => {
  let config = {
    guildId: "guild-1",
    roles: [] as TimedRoleAutomationRule[],
  };

  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readTimedRoleConfigRules(
        guildId: string,
        configType: "new-member" | "manual-assignment",
      ) {
        return guildId === config.guildId && configType === "new-member" ? config.roles : [];
      },
      async upsertTimedRoleConfigRules(
        guildId: string,
        configType: "new-member" | "manual-assignment",
        roles: TimedRoleAutomationRule[],
      ) {
        if (configType === "new-member") config = { guildId, roles };
      },
    }),
    gateway: {} as GatewayController,
  });
  const saveResponse = await app.fetch(
    new Request("https://runtime.example/admin/api/timed-roles/new-member-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        roles: [
          {
            roleId: "role-newbie",
            durationInput: "2h",
            dmMessage: "Hi {username}, you received {rolename} in {guild}.",
          },
        ],
      }),
    }),
  );

  assert.equal(saveResponse.status, 200);
  assert.deepEqual(await saveResponse.json(), {
    newMemberRoleConfig: {
      guildId: "guild-1",
      roles: [
        {
          roleId: "role-newbie",
          durationInput: "2h",
          dmMessage: "Hi {username}, you received {rolename} in {guild}.",
        },
      ],
    },
  });

  const invalidDmResponse = await app.fetch(
    new Request("https://runtime.example/admin/api/timed-roles/new-member-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        roles: [{ roleId: "role-newbie", durationInput: "2h", dmMessage: "Hi {useer}" }],
      }),
    }),
  );

  assert.equal(invalidDmResponse.status, 400);
  assert.equal(
    ((await invalidDmResponse.json()) as { error: string }).error,
    "Unknown placeholder: {useer}",
  );

  const invalidResponse = await app.fetch(
    new Request("https://runtime.example/admin/api/timed-roles/new-member-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        roles: [{ roleId: "role-newbie", durationInput: "eventually" }],
      }),
    }),
  );

  assert.equal(invalidResponse.status, 400);
});

test("createRuntimeApp exposes manual-assignment timed-role config through session auth", async () => {
  let config = {
    guildId: "guild-1",
    roles: [] as TimedRoleAutomationRule[],
  };

  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readTimedRoleConfigRules(
        guildId: string,
        configType: "new-member" | "manual-assignment",
      ) {
        return guildId === config.guildId && configType === "manual-assignment" ? config.roles : [];
      },
      async upsertTimedRoleConfigRules(
        guildId: string,
        configType: "new-member" | "manual-assignment",
        roles: TimedRoleAutomationRule[],
      ) {
        if (configType === "manual-assignment") config = { guildId, roles };
      },
    }),
    gateway: {} as GatewayController,
  });
  const saveResponse = await app.fetch(
    new Request("https://runtime.example/admin/api/timed-roles/manual-assignment-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        roles: [{ roleId: "role-timeout", durationInput: "2h" }],
      }),
    }),
  );

  assert.equal(saveResponse.status, 200);
  assert.deepEqual(await saveResponse.json(), {
    manualAssignmentRoleConfig: {
      guildId: "guild-1",
      roles: [{ roleId: "role-timeout", durationInput: "2h" }],
    },
  });

  const listResponse = await app.fetch(
    new Request("https://runtime.example/admin/api/timed-roles?guildId=guild-1", {}),
  );

  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()) as { manualAssignmentRoleConfig?: unknown };
  assert.deepEqual(listed.manualAssignmentRoleConfig, {
    guildId: "guild-1",
    roles: [{ roleId: "role-timeout", durationInput: "2h" }],
  });
});

test("createRuntimeApp rejects malformed POST /admin/api/timed-roles bodies with 400 JSON", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls.push("discord");
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async upsertTimedRole() {
          calls.push("store:add");
        },
        async deleteTimedRole() {
          calls.push("store:remove");
        },
      }),
      gateway: {} as GatewayController,
    });
    const response = await app.fetch(
      new Request("https://runtime.example/admin/api/timed-roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "add",
          guildId: "guild-1",
          userId: "user-1",
          roleId: "role-1",
        }),
      }),
    );

    assert.equal(response.status, 400);
    const body = (await response.json()) as {
      error: string;
      fieldIssues?: Array<{ path: string }>;
    };
    assert.equal(body.error, "Invalid request body");
    assert.ok(body.fieldIssues?.some((issue) => issue.path === "duration"));
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp returns 502 JSON when timed-role add fails at Discord", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls.push("discord:fail");
    return new Response(JSON.stringify({ message: "Missing Permissions", code: 50013 }), {
      status: 403,
    });
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async upsertTimedRole() {
          calls.push("store:add");
        },
        async deleteTimedRole() {
          calls.push("store:rollback");
        },
        async listTimedRolesByGuild() {
          return [];
        },
      }),
      gateway: {} as GatewayController,
    });
    const response = await app.fetch(
      new Request("https://runtime.example/admin/api/timed-roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "add",
          guildId: "guild-1",
          userId: "user-1",
          roleId: "role-1",
          duration: "1h",
        }),
      }),
    );

    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: string };
    assert.ok(body.error, "Response should have error field");
    assert.equal(body.error, "Something went wrong.");
    assert.deepEqual(calls, ["store:add", "discord:fail", "store:rollback"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp returns 502 JSON when timed-role remove fails at Discord", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls.push("discord:fail");
    return new Response(JSON.stringify({ message: "Unknown Member", code: 10007 }), {
      status: 404,
    });
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async deleteTimedRole() {
          calls.push("store:remove");
        },
        async listTimedRolesByGuild() {
          return [];
        },
      }),
      gateway: {} as GatewayController,
    });
    const response = await app.fetch(
      new Request("https://runtime.example/admin/api/timed-roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "remove",
          guildId: "guild-1",
          userId: "user-1",
          roleId: "role-1",
        }),
      }),
    );

    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: string };
    assert.ok(body.error, "Response should have error field");
    assert.equal(body.error, "Something went wrong.");
    assert.deepEqual(calls, ["discord:fail"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp does not expose app config mutation routes", async () => {
  const calls: string[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async upsertAppConfig() {
        calls.push("config");
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "bot_user_id" }),
    }),
  );

  assert.equal(response.status, 404);
  assert.deepEqual(calls, []);
});

test("createRuntimeApp rejects malformed POST /admin/api/blocklist bodies with 400 JSON", async () => {
  const calls: string[] = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async applyGuildEmojiMutation() {
        calls.push("blocklist");
        return { guilds: {}, botUserId: "bot-user-id" };
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/blocklist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1", emoji: "🚫", action: "block" }),
    }),
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string; fieldIssues?: Array<{ path: string }> };
  assert.equal(body.error, "Invalid request body");
  assert.ok(body.fieldIssues?.some((issue) => issue.path === "action"));
  assert.deepEqual(calls, []);
});

test("createRuntimeApp rejects null body on POST /admin/api/blocklist with 400 JSON", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as unknown as RuntimeStore),
    gateway: {} as GatewayController,
  });
  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/blocklist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    }),
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /Invalid|Missing/);
});

test("createRuntimeApp rejects non-string emoji on POST /admin/api/blocklist with 400 JSON", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as unknown as RuntimeStore),
    gateway: {} as GatewayController,
  });
  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/blocklist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1", emoji: {}, action: "add" }),
    }),
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /Invalid|Missing/);
});

test("createRuntimeApp rejects null body on POST /admin/api/timed-roles with 400 JSON", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as unknown as RuntimeStore),
    gateway: {} as GatewayController,
  });
  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/timed-roles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    }),
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /Invalid|Missing/);
});

test("createRuntimeApp rejects non-string duration on POST /admin/api/timed-roles with 400 JSON", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as unknown as RuntimeStore),
    gateway: {} as GatewayController,
  });
  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/timed-roles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "add",
        guildId: "guild-1",
        userId: "user-1",
        roleId: "role-1",
        duration: {},
      }),
    }),
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /Invalid|Missing/);
});

test("createRuntimeApp rejects unauthenticated /admin/api/* requests with 401 JSON", async () => {
  const app = createUnauthenticatedRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/blocklist?guildId=guild-1"),
  );
  assert.equal(response.status, 401);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "Unauthorized");
});

test("createRuntimeApp rejects a legacy API session when customer auth is not configured", async () => {
  const app = createUnauthenticatedRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    workspaceStore: createWorkspaceStoreMock([]),
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {
      async start() {
        return { ok: true };
      },
      async status() {
        return { status: "idle" };
      },
    } as unknown as GatewayController,
  });
  const cookie = await createAdminSessionCookie("session-secret");
  const response = await app.fetch(
    new Request("https://runtime.example/admin/api/blocklist?guildId=guild-1", {
      headers: { cookie },
    }),
  );

  assert.equal(response.status, 401);
});

test("createRuntimeApp serves admin shell with data-authenticated for authenticated /admin GET", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(new Request("https://runtime.example/admin"));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /data-authenticated="true"/);
});

test("createRuntimeApp passes customer Discord profile data into the admin shell", async () => {
  const customerAuth = {
    handler: async () => new Response(null, { status: 404 }),
    api: {
      getSession: async () => ({
        user: {
          id: "user-1",
          discordUserId: "discord-user-1",
          name: "Jane Discord",
          image: "https://cdn.discordapp.com/avatars/discord-user-1/avatar.png",
        },
      }),
    },
  } as never;
  const app = createTestRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    customerAuth,
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request("https://runtime.example/admin/guild-1/tickets", {
      headers: { cookie: "customer_session=1" },
    }),
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-authenticated="true"/);
  assert.match(html, /data-user-name="Jane Discord"/);
  assert.match(
    html,
    /data-user-image="https:\/\/cdn\.discordapp\.com\/avatars\/discord-user-1\/avatar\.png"/,
  );
});

test("createRuntimeApp does not expose the retired global app config route", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readConfig() {
        return {
          guilds: { "guild-1": { enabled: true, emojis: ["✅"] } },
          botUserId: "bot-user-id",
        };
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(new Request("https://runtime.example/admin/api/config"));
  assert.equal(response.status, 404);
});

test("createRuntimeApp authorizes customer workspace admin API requests", async () => {
  let activeMember: { userId: string; organizationId: string; role: string } | null = {
    userId: "user-1",
    organizationId: "workspace-1",
    role: "member",
  };
  const organizationAuthCalls: string[] = [];
  const guildLinkChecks: Array<{ workspaceId: string; guildId: string }> = [];
  const marketplaceWrites: string[] = [];
  const customerAuth = {
    handler: async () => new Response(null, { status: 404 }),
    api: {
      getSession: async () => ({
        session: { activeOrganizationId: null },
        user: {
          id: "user-1",
          discordUserId: "discord-user-1",
          name: "Customer User",
        },
      }),
      setActiveOrganization: async ({ body }: { body: { organizationId: string } }) => {
        organizationAuthCalls.push(`set:${body.organizationId}`);
      },
      getActiveMember: async () => {
        organizationAuthCalls.push("get-active-member");
        return activeMember;
      },
    },
  } as never;
  const workspaceStore = {
    linkGuildToWorkspace: async () => {},
    unlinkGuildFromWorkspace: async () => {},
    listGuildsForWorkspace: async () => [],
    isGuildLinkedToWorkspace: async (workspaceId: string, guildId: string) => {
      guildLinkChecks.push({ workspaceId, guildId });
      return workspaceId === "workspace-1" && guildId === "guild-1";
    },
    readEntitlement: async (workspaceId: string) => ({
      workspaceId,
      plan: "free",
      status: "manual",
      enabledFlags: [],
      updatedAtMs: 0,
    }),
    upsertEntitlement: async () => {},
  } as never;
  const app = createTestRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    customerAuth,
    workspaceStore,
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      readMarketplaceConfig: async () => null,
      listMarketplacePosts: async () => [],
      listMarketplaceLogs: async () => [],
      upsertMarketplaceConfig: async (config: { guildId: string }) => {
        marketplaceWrites.push(config.guildId);
      },
    }),
    gateway: {} as GatewayController,
  });
  const customerCookie = "customer_session=1";

  const readResponse = await app.fetch(
    new Request(
      "https://runtime.example/admin/api/marketplace?workspaceId=workspace-1&guildId=guild-1",
      { headers: { cookie: customerCookie } },
    ),
  );
  assert.equal(readResponse.status, 200);
  assert.equal(((await readResponse.json()) as { guildId: string }).guildId, "guild-1");

  const writeResponse = await app.fetch(
    new Request("https://runtime.example/admin/api/marketplace/config", {
      method: "POST",
      headers: { cookie: customerCookie, "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        guildId: "guild-1",
        noticeChannelId: null,
        noticeMessageId: null,
        logChannelId: null,
        serverOptions: [{ id: "server-1", label: "Server One", emoji: null }],
      }),
    }),
  );
  assert.equal(writeResponse.status, 403);
  assert.equal(((await writeResponse.json()) as { error: string }).error, "Forbidden");
  assert.deepEqual(marketplaceWrites, []);

  activeMember = { userId: "user-1", organizationId: "workspace-2", role: "owner" };
  const foreignWorkspaceMemberResponse = await app.fetch(
    new Request(
      "https://runtime.example/admin/api/marketplace?workspaceId=workspace-1&guildId=guild-1",
      { headers: { cookie: customerCookie } },
    ),
  );
  assert.equal(foreignWorkspaceMemberResponse.status, 403);

  activeMember = { userId: "other-user", organizationId: "workspace-1", role: "admin" };
  const mismatchedMemberResponse = await app.fetch(
    new Request(
      "https://runtime.example/admin/api/marketplace?workspaceId=workspace-1&guildId=guild-1",
      { headers: { cookie: customerCookie } },
    ),
  );
  assert.equal(mismatchedMemberResponse.status, 403);
  assert.equal(
    ((await mismatchedMemberResponse.json()) as { error: string }).error,
    "Workspace access is required.",
  );
  assert.deepEqual(organizationAuthCalls, [
    "set:workspace-1",
    "get-active-member",
    "set:workspace-1",
    "get-active-member",
    "set:workspace-1",
    "get-active-member",
    "set:workspace-1",
    "get-active-member",
  ]);
  assert.deepEqual(guildLinkChecks, [{ workspaceId: "workspace-1", guildId: "guild-1" }]);
});

test("Commerce seller connect initializes an old session's active organization before authorization", async () => {
  const guildId = "1483606177261551777";
  const organizationCalls: string[] = [];
  const onboardingCalls: string[] = [];
  const customerAuth = {
    handler: async () => new Response(null, { status: 404 }),
    api: {
      getSession: async () => ({
        session: { activeOrganizationId: null },
        user: {
          id: "user-1",
          discordUserId: "discord-user-1",
          name: "Customer User",
        },
      }),
      setActiveOrganization: async ({ body }: { body: { organizationId: string } }) => {
        organizationCalls.push(`set:${body.organizationId}`);
      },
      getActiveMember: async () => {
        organizationCalls.push("get-active-member");
        return { userId: "user-1", organizationId: "workspace-1", role: "owner" };
      },
    },
  } as never;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith(`/guilds/${guildId}`)) {
      return Response.json({ id: guildId, name: "Commerce Guild", owner_id: "discord-user-1" });
    }
    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createTestRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "commerce-active-organization-token",
      customerAuth,
      workspaceStore: createWorkspaceStoreMock([guildId]),
      commerceAdmin: {
        currentTermsVersion: "terms-1",
        sellerLifecycle: {
          async beginOnboarding(input: { guildId: string }) {
            onboardingCalls.push(input.guildId);
            return {
              account: { id: "account-1" },
              onboardingUrl: "https://connect.stripe.test/onboarding",
            };
          },
        },
      } as never,
      publicUrl: "https://runtime.example",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({} as RuntimeStore),
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      new Request("https://runtime.example/admin/api/commerce/seller/connect", {
        method: "POST",
        headers: { cookie: "customer_session=1", "content-type": "application/json" },
        body: JSON.stringify({
          guildId,
          workspaceId: "workspace-1",
          supportContact: "seller@example.test",
          adultAttested: true,
          twoFactorEvidence: "seller_attested",
          termsAccepted: true,
          sellerAcknowledged: true,
          feesAcknowledged: true,
        }),
      }),
    );

    assert.equal(response.status, 201);
    assert.deepEqual(organizationCalls, ["set:workspace-1", "get-active-member"]);
    assert.deepEqual(onboardingCalls, [guildId]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp exposes ticket admin APIs through session auth and publishes the panel message", async () => {
  const fetchCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  let storedPanel: TicketPanelConfig | null = null;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    fetchCalls.push({ method, url, body });

    if (url.endsWith("/guilds/guild-1/channels")) {
      return Response.json([
        { id: "category-1", name: "Tickets", type: 4, parent_id: null, position: 1 },
        { id: "panel-channel", name: "ticket-panel", type: 0, parent_id: null, position: 2 },
        {
          id: "transcript-channel",
          name: "ticket-transcripts",
          type: 0,
          parent_id: null,
          position: 3,
        },
        { id: "text-1", name: "general", type: 0, parent_id: null, position: 4 },
        { id: "voice-1", name: "voice", type: 2, parent_id: null, position: 5 },
      ]);
    }

    if (url.endsWith("/guilds/guild-1/roles")) {
      return Response.json([
        { id: "role-1", name: "Support", permissions: "0", position: 1 },
        { id: "role-2", name: "Helpers", permissions: "0", position: 2 },
      ]);
    }

    if (url.endsWith("/channels/panel-channel/messages") && method === "POST") {
      return Response.json({ id: "panel-message-1", channel_id: "panel-channel", content: "" });
    }

    if (url.endsWith("/channels/panel-channel/messages/panel-message-1") && method === "PATCH") {
      return Response.json({ id: "panel-message-1", channel_id: "panel-channel", content: "" });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return storedPanel?.guildId === guildId ? storedPanel : null;
        },
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium", updatedAtMs: 0 };
        },
        async upsertTicketPanelConfig(panel: TicketPanelConfig) {
          storedPanel = panel;
        },
      }),
      gateway: {} as GatewayController,
    });
    const invalidPanelResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1" }),
      }),
    );
    assert.equal(invalidPanelResponse.status, 400);
    assertTicketPanelValidationIssue(await invalidPanelResponse.json(), "panelChannelId");

    const invalidPublishResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    assert.equal(invalidPublishResponse.status, 400);
    assertTicketPanelValidationIssue(await invalidPublishResponse.json(), "guildId");

    const panel: TicketPanelConfig = createTicketPanelConfig();
    const oversizedQuestionLabelResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [
            {
              ...panel.ticketTypes[0],
              questions: [
                {
                  ...panel.ticketTypes[0]!.questions[0],
                  label: "L".repeat(46),
                },
              ],
            },
          ],
        }),
      }),
    );
    assert.equal(oversizedQuestionLabelResponse.status, 400);
    assertTicketPanelValidationIssue(
      await oversizedQuestionLabelResponse.json(),
      "ticketTypes.0.questions.0.label",
    );

    const oversizedQuestionIdResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [
            {
              ...panel.ticketTypes[0],
              questions: [
                {
                  ...panel.ticketTypes[0]!.questions[0],
                  id: "q".repeat(101),
                },
              ],
            },
          ],
        }),
      }),
    );
    assert.equal(oversizedQuestionIdResponse.status, 400);
    assertTicketPanelValidationIssue(
      await oversizedQuestionIdResponse.json(),
      "ticketTypes.0.questions.0.id",
    );

    const oversizedQuestionPlaceholderResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [
            {
              ...panel.ticketTypes[0],
              questions: [
                {
                  ...panel.ticketTypes[0]!.questions[0],
                  placeholder: "P".repeat(101),
                },
              ],
            },
          ],
        }),
      }),
    );
    assert.equal(oversizedQuestionPlaceholderResponse.status, 400);
    assertTicketPanelValidationIssue(
      await oversizedQuestionPlaceholderResponse.json(),
      "ticketTypes.0.questions.0.placeholder",
    );

    const oversizedTicketTypeLabelResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [{ ...panel.ticketTypes[0], label: "L".repeat(46) }],
        }),
      }),
    );
    assert.equal(oversizedTicketTypeLabelResponse.status, 400);
    assertTicketPanelValidationIssue(
      await oversizedTicketTypeLabelResponse.json(),
      "ticketTypes.0.label",
    );

    const oversizedTicketTypeOpenCustomIdResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [{ ...panel.ticketTypes[0], id: "t".repeat(84) }],
        }),
      }),
    );
    assert.equal(oversizedTicketTypeOpenCustomIdResponse.status, 400);
    assertTicketPanelValidationIssue(
      await oversizedTicketTypeOpenCustomIdResponse.json(),
      "ticketTypes.0.id",
    );

    const oversizedTicketTypeLabelPublishResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [{ ...panel.ticketTypes[0], label: "L".repeat(46) }],
        }),
      }),
    );
    assert.equal(oversizedTicketTypeLabelPublishResponse.status, 400);
    assertTicketPanelValidationIssue(
      await oversizedTicketTypeLabelPublishResponse.json(),
      "ticketTypes.0.label",
    );

    const oversizedTicketTypeOpenCustomIdPublishResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [{ ...panel.ticketTypes[0], id: "t".repeat(84) }],
        }),
      }),
    );
    assert.equal(oversizedTicketTypeOpenCustomIdPublishResponse.status, 400);
    assertTicketPanelValidationIssue(
      await oversizedTicketTypeOpenCustomIdPublishResponse.json(),
      "ticketTypes.0.id",
    );

    const oversizedQuestionPublishResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [
            {
              ...panel.ticketTypes[0],
              questions: [
                {
                  ...panel.ticketTypes[0]!.questions[0],
                  label: "L".repeat(46),
                },
              ],
            },
          ],
        }),
      }),
    );
    assert.equal(oversizedQuestionPublishResponse.status, 400);
    assertTicketPanelValidationIssue(
      await oversizedQuestionPublishResponse.json(),
      "ticketTypes.0.questions.0.label",
    );

    const invalidSupportRoleResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [
            {
              ...panel.ticketTypes[0],
              supportRoleId: null,
            },
          ],
        }),
      }),
    );
    assert.equal(invalidSupportRoleResponse.status, 400);
    assertTicketPanelValidationIssue(
      await invalidSupportRoleResponse.json(),
      "ticketTypes.0.supportRoleId",
    );
    const duplicateTicketTypeResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [panel.ticketTypes[0], { ...panel.ticketTypes[0], label: "Appeal Copy" }],
        }),
      }),
    );
    assert.equal(duplicateTicketTypeResponse.status, 400);
    assertTicketPanelValidationIssue(await duplicateTicketTypeResponse.json(), "ticketTypes.1.id");
    const tooManyQuestionsResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [
            {
              ...panel.ticketTypes[0],
              questions: Array.from({ length: 6 }, (_, index) => ({
                id: `question-${index + 1}`,
                label: `Question ${index + 1}`,
                style: "short",
                placeholder: null,
                required: true,
              })),
            },
          ],
        }),
      }),
    );
    assert.equal(tooManyQuestionsResponse.status, 400);
    assertTicketPanelValidationIssue(
      await tooManyQuestionsResponse.json(),
      "ticketTypes.0.questions",
    );

    const tooManyResponseRulesResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [
            {
              ...panel.ticketTypes[0],
              responseRules: Array.from({ length: 11 }, (_, index) => ({
                id: `rule-${index + 1}`,
                conditions: [],
                message: `Rule ${index + 1}`,
              })),
            },
          ],
        }),
      }),
    );
    assert.equal(tooManyResponseRulesResponse.status, 400);
    assertTicketPanelValidationIssue(
      await tooManyResponseRulesResponse.json(),
      "ticketTypes.0.responseRules",
    );

    const tooManyResponseRuleConditionsResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [
            {
              ...panel.ticketTypes[0],
              responseRules: [
                {
                  id: "rule-1",
                  conditions: Array.from({ length: 6 }, (_, index) => ({
                    kind: "has-role",
                    roleId: `role-${index + 1}`,
                  })),
                  message: "Please complete onboarding.",
                },
              ],
            },
          ],
        }),
      }),
    );
    assert.equal(tooManyResponseRuleConditionsResponse.status, 400);
    assertTicketPanelValidationIssue(
      await tooManyResponseRuleConditionsResponse.json(),
      "ticketTypes.0.responseRules.0.conditions",
    );

    const emptyResponseRuleMessageResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [
            {
              ...panel.ticketTypes[0],
              responseRules: [
                {
                  id: "rule-1",
                  conditions: [],
                  message: "   ",
                },
              ],
            },
          ],
        }),
      }),
    );
    assert.equal(emptyResponseRuleMessageResponse.status, 400);
    assertTicketPanelValidationIssue(
      await emptyResponseRuleMessageResponse.json(),
      "ticketTypes.0.responseRules.0.message",
    );

    const oversizedResponseRuleMessageResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [
            {
              ...panel.ticketTypes[0],
              responseRules: [
                {
                  id: "rule-1",
                  conditions: [],
                  message: "x".repeat(2001),
                },
              ],
            },
          ],
        }),
      }),
    );
    assert.equal(oversizedResponseRuleMessageResponse.status, 400);
    assertTicketPanelValidationIssue(
      await oversizedResponseRuleMessageResponse.json(),
      "ticketTypes.0.responseRules.0.message",
    );

    const malformedConditionPanel = {
      ...panel,
      ticketTypes: [
        {
          ...panel.ticketTypes[0],
          responseRules: [
            {
              id: "rule-1",
              conditions: [{ kind: "unsupported", roleId: "role-1" }],
              message: "Please complete onboarding.",
            },
          ],
        },
      ],
    } as unknown;
    const malformedConditionResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(malformedConditionPanel),
      }),
    );
    assert.equal(malformedConditionResponse.status, 400);
    assertTicketPanelValidationIssue(
      await malformedConditionResponse.json(),
      "ticketTypes.0.responseRules.0.conditions.0.kind",
    );

    const invalidQuestionValidationResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...panel,
          ticketTypes: [
            {
              ...panel.ticketTypes[0],
              questions: [
                {
                  ...panel.ticketTypes[0]!.questions[0],
                  validation: "steamProfile",
                },
              ],
            },
          ],
        }),
      }),
    );
    assert.equal(invalidQuestionValidationResponse.status, 400);
    assertTicketPanelValidationIssue(
      await invalidQuestionValidationResponse.json(),
      "ticketTypes.0.questions.0.validation",
    );

    const invalidTicketCreationLimitResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...panel, ticketCreationLimit: 51 }),
      }),
    );
    assert.equal(invalidTicketCreationLimitResponse.status, 400);
    assertTicketPanelValidationIssue(
      await invalidTicketCreationLimitResponse.json(),
      "ticketCreationLimit",
    );

    const steamPanel: TicketPanelConfig = {
      ...panel,
      panelColor: 0x123456,
      ticketCreationLimit: 5,
      ticketLimitRejectionMessage: "Please close an existing ticket first.",
      enableTicketClaiming: true,
      ticketTypes: [
        {
          ...panel.ticketTypes[0]!,
          allowedCreatorRoleIds: ["role-2"],
          limitExclusion: true,
          responseRules: [
            {
              id: "rule-no-link",
              conditions: [{ kind: "lacks-role", roleId: "role-2" }],
              message: "Please run /steamlink first.",
            },
            {
              id: "rule-default",
              conditions: [],
              message: "Thanks {{who}}, we will review this ticket soon.",
            },
          ],
          questions: [
            {
              ...panel.ticketTypes[0]!.questions[0]!,
              id: "steam-id",
              label: "Steam ID",
              style: "short",
              validation: "steamId",
            },
          ],
        },
      ],
    };
    const saveResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(steamPanel),
      }),
    );
    assert.equal(saveResponse.status, 200);
    assert.deepEqual(await saveResponse.json(), { ok: true, panel: steamPanel });
    assert.deepEqual(
      (storedPanel as TicketPanelConfig | null)?.ticketTypes[0]?.responseRules,
      steamPanel.ticketTypes[0].responseRules,
    );

    const readResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel?guildId=guild-1", {}),
    );
    assert.equal(readResponse.status, 200);
    assert.deepEqual(await readResponse.json(), { panel: steamPanel, panels: [steamPanel] });

    const resourcesResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/resources?guildId=guild-1", {}),
    );
    assert.equal(resourcesResponse.status, 200);
    assert.deepEqual(await resourcesResponse.json(), {
      guildId: "guild-1",
      roles: [
        { id: "role-1", name: "Support" },
        { id: "role-2", name: "Helpers" },
      ],
      categories: [{ id: "category-1", name: "Tickets" }],
      textChannels: [
        { id: "panel-channel", name: "ticket-panel" },
        { id: "transcript-channel", name: "ticket-transcripts" },
        { id: "text-1", name: "general" },
      ],
      stageChannels: [],
      voiceChannels: [{ id: "voice-1", name: "voice" }],
      forumChannels: [],
      emojis: [],
      configuredTicketLinkPlatforms: [],
    });

    const publishResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(steamPanel),
      }),
    );
    assert.equal(publishResponse.status, 200);
    assert.deepEqual(await publishResponse.json(), { ok: true, panelMessageId: "panel-message-1" });
    const publishCall = fetchCalls.find(
      (call) => call.method === "POST" && call.url.endsWith("/channels/panel-channel/messages"),
    );
    assert.equal(
      (publishCall?.body as { embeds?: Array<{ color?: number }> } | null)?.embeds?.[0]?.color,
      0x123456,
    );
    const savedPanel: TicketPanelConfig = (storedPanel as TicketPanelConfig | null) ?? panel;
    assert.equal(savedPanel.panelMessageId, "panel-message-1");

    const refreshResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(savedPanel),
      }),
    );
    assert.equal(refreshResponse.status, 200);

    const publishCreate = fetchCalls.find(
      (call) => call.method === "POST" && call.url.endsWith("/channels/panel-channel/messages"),
    );
    assert.deepEqual(publishCreate?.body, {
      content: "",
      embeds: [
        {
          color: 0x123456,
          title: "🎫 Support tickets",
          description: "Use the button below to open a ticket.",
          footer: {
            text: "TicketTool.xyz - Ticketing without clutter",
          },
        },
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              custom_id: buildTicketOpenCustomId("appeals", "main"),
              label: "Appeal",
              style: 1,
              emoji: { name: "🧾" },
            },
          ],
        },
      ],
    });
    assert.ok(
      fetchCalls.some(
        (call) =>
          call.method === "PATCH" &&
          call.url.endsWith("/channels/panel-channel/messages/panel-message-1"),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp durably queues panel recovery after the immediate retry fails", async () => {
  const originalFetch = globalThis.fetch;
  const panel = { ...createTicketPanelConfig(), panelId: "main", panelName: "Main panel" };
  const queued: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/guilds/guild-1/channels")) {
      return Response.json([
        { id: "category-1", name: "Tickets", type: 4, parent_id: null, position: 1 },
        { id: "panel-channel", name: "panel", type: 0, parent_id: null, position: 2 },
        {
          id: "transcript-channel",
          name: "transcripts",
          type: 0,
          parent_id: null,
          position: 3,
        },
      ]);
    }
    if (url.endsWith("/guilds/guild-1/roles")) {
      return Response.json([{ id: "role-1", name: "Support", permissions: "0", position: 1 }]);
    }
    if (url.endsWith("/channels/panel-channel/messages") && method === "POST") {
      return Response.json({ id: "orphan-message", channel_id: "panel-channel" });
    }
    if (url.endsWith("/channels/panel-channel/messages/orphan-message") && method === "DELETE") {
      return Response.json({ message: "Discord unavailable" }, { status: 503 });
    }
    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const stores = createRuntimeStoresWithOverrides({
      async readTicketPanelConfig(guildId: string) {
        return guildId === panel.guildId ? panel : null;
      },
      async readTicketPanelConfigById(guildId: string, panelId: string) {
        return guildId === panel.guildId && panelId === panel.panelId ? panel : null;
      },
      async readGuildEntitlement(guildId: string) {
        return { guildId, tier: "premium", updatedAtMs: 0 };
      },
      async upsertTicketPanelConfig() {
        throw new Error("D1 unavailable");
      },
    });
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores,
      gateway: {} as GatewayController,
      ticketRecoveryQueue: {
        async send(body) {
          queued.push(body);
        },
      } as QueueProducer<never>,
    });

    const response = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(panel),
      }),
    );

    assert.equal(response.status, 400);
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0], {
      kind: "panel-recovery",
      recovery: {
        operation: "publish",
        guildId: "guild-1",
        channelId: "panel-channel",
        messageId: "orphan-message",
        panel: { ...panel, panelMessageId: "orphan-message" },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp publishes unsaved ticket panel edits from the request body", async () => {
  const originalFetch = globalThis.fetch;
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  let storedPanel: TicketPanelConfig | null = {
    ...createTicketPanelConfig(),
    ticketTypes: [
      {
        ...createTicketPanelConfig().ticketTypes[0]!,
        responseRules: [{ id: "welcome", conditions: [], message: "Old saved reply" }],
      },
    ],
  };
  const editedPanel: TicketPanelConfig = {
    ...createTicketPanelConfig(),
    panelTitle: "Updated support tickets",
    ticketTypes: [
      {
        ...createTicketPanelConfig().ticketTypes[0]!,
        responseRules: [{ id: "welcome", conditions: [], message: "New local reply" }],
      },
    ],
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    discordCalls.push({ method, url, body });

    if (url.endsWith("/guilds/guild-1/channels") && method === "GET") {
      return Response.json([
        { id: "category-1", name: "Tickets", type: 4, parent_id: null, position: 1 },
        { id: "panel-channel", name: "ticket-panel", type: 0, parent_id: null, position: 2 },
        {
          id: "transcript-channel",
          name: "ticket-transcripts",
          type: 0,
          parent_id: null,
          position: 3,
        },
      ]);
    }

    if (url.endsWith("/guilds/guild-1/roles") && method === "GET") {
      return Response.json([{ id: "role-1", name: "Support", permissions: "0", position: 1 }]);
    }

    if (url.endsWith("/channels/panel-channel/messages") && method === "POST") {
      return Response.json({ id: "panel-message-2", channel_id: "panel-channel", content: "" });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return storedPanel?.guildId === guildId ? storedPanel : null;
        },
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium", updatedAtMs: 0 };
        },
        async upsertTicketPanelConfig(panel: TicketPanelConfig) {
          storedPanel = panel;
        },
      }),
      gateway: {} as GatewayController,
    });
    const publishResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editedPanel),
      }),
    );

    assert.equal(publishResponse.status, 200);
    assert.deepEqual(await publishResponse.json(), { ok: true, panelMessageId: "panel-message-2" });
    assert.equal(
      (storedPanel as TicketPanelConfig | null)?.ticketTypes[0]?.responseRules[0]?.message,
      "New local reply",
    );
    assert.equal((storedPanel as TicketPanelConfig | null)?.panelMessageId, "panel-message-2");
    assert.deepEqual(
      discordCalls.find(
        (call) => call.method === "POST" && call.url.endsWith("/channels/panel-channel/messages"),
      )?.body,
      {
        content: "",
        embeds: [
          {
            color: 5763719,
            title: "🎫 Updated support tickets",
            description: "Use the button below to open a ticket.",
            footer: {
              text: "TicketTool.xyz - Ticketing without clutter",
            },
          },
        ],
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                custom_id: buildTicketOpenCustomId("appeals", "main"),
                label: "Appeal",
                style: 1,
                emoji: { name: "🧾" },
              },
            ],
          },
        ],
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp returns guild-manager ticket setup checks", async () => {
  const originalFetch = globalThis.fetch;
  const VIEW_CHANNEL = 1n << 10n;
  const SEND_MESSAGES = 1n << 11n;
  const ATTACH_FILES = 1n << 15n;
  const MANAGE_CHANNELS = 1n << 4n;
  const panel: TicketPanelConfig = {
    ...createTicketPanelConfig(),
    aiTranscriptSummariesEnabled: true,
  };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/guilds/guild-1/channels")) {
      return Response.json([
        {
          id: "category-1",
          name: "Tickets",
          type: 4,
          parent_id: null,
          position: 1,
          permission_overwrites: [],
        },
        {
          id: "panel-channel",
          name: "ticket-panel",
          type: 0,
          parent_id: null,
          position: 2,
          permission_overwrites: [],
        },
        {
          id: "transcript-channel",
          name: "ticket-transcripts",
          type: 0,
          parent_id: null,
          position: 3,
          permission_overwrites: [],
        },
      ]);
    }

    if (url.endsWith("/guilds/guild-1/roles")) {
      return Response.json([
        { id: "guild-1", name: "@everyone", permissions: "0", position: 0 },
        {
          id: "role-bot",
          name: "HAF Bot",
          permissions: String(VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | MANAGE_CHANNELS),
          position: 10,
        },
        { id: "role-1", name: "Support", permissions: "0", position: 1 },
      ]);
    }

    if (url.endsWith("/guilds/guild-1/members/bot-user-id")) {
      return Response.json({ user: { id: "bot-user-id" }, roles: ["role-bot"] });
    }

    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium", updatedAtMs: 0 };
        },
      }),
      gateway: {} as GatewayController,
      aiTranscriptSummarizerEnv: {
        apiBaseUrl: "https://ai.example.com",
        apiKey: "secret",
        model: "gpt-test",
        timeoutMs: 1000,
      },
    });
    const response = await app.fetch(
      new Request(
        "https://runtime.example/admin/api/tickets/setup-check?guildId=guild-1&refresh=1",
      ),
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      overallStatus: string;
      checks: Array<{ id: string; status: string; detail: string }>;
      testActions: Array<{ action: string; enabled: boolean }>;
    };
    assert.equal(body.overallStatus, "ok");
    assert.equal(body.checks.find((check) => check.id === "panel-channel")?.status, "ok");
    assert.equal(body.checks.find((check) => check.id === "ticket-category")?.status, "ok");
    assert.equal(body.checks.find((check) => check.id === "transcript-channel")?.status, "ok");
    assert.equal(body.checks.find((check) => check.id === "ai-summaries")?.status, "ok");
    assert.equal(body.testActions.find((action) => action.action === "ai-summary")?.enabled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp runs safe ticket setup test actions", async () => {
  const originalFetch = globalThis.fetch;
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const panel = createTicketPanelConfig();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    discordCalls.push({ method, url, body: init?.body ?? null });

    if (url.endsWith("/channels/panel-channel/messages") && method === "POST") {
      return Response.json({ id: "panel-test-1", channel_id: "panel-channel", content: "" });
    }

    if (url.endsWith("/channels/transcript-channel/messages") && method === "POST") {
      return Response.json({
        id: "transcript-test-1",
        channel_id: "transcript-channel",
        content: "",
      });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium", updatedAtMs: 0 };
        },
      }),
      gateway: {} as GatewayController,
    });
    for (const action of ["panel-post", "transcript-upload"]) {
      const response = await app.fetch(
        new Request("https://runtime.example/admin/api/tickets/test-action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            guildId: "guild-1",
            panelId: "main",
            action,
          }),
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { ok: boolean }).ok, true);
    }

    assert.ok(
      discordCalls.some(
        (call) => call.method === "POST" && call.url.endsWith("/channels/panel-channel/messages"),
      ),
    );
    const transcriptCall = discordCalls.find(
      (call) =>
        call.method === "POST" && call.url.endsWith("/channels/transcript-channel/messages"),
    );
    assert.ok(transcriptCall?.body instanceof FormData);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp maps persisted foreign ticket test targets to HTTP 400", async () => {
  const panel = {
    ...createTicketPanelConfig(),
    panelChannelId: "foreign-panel",
    transcriptChannelId: "foreign-transcript",
  };
  let discordCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    discordCalls += 1;
    throw new Error("Unexpected Discord call");
  };

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      guildResources: createStaticGuildResourceValidator({
        guilds: {
          "guild-1": { channels: [], roles: [] },
          "guild-2": {
            channels: [
              testChannel("foreign-panel", 0, "guild-2"),
              testChannel("foreign-transcript", 0, "guild-2"),
            ],
            roles: [],
          },
        },
      }),
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
      }),
      gateway: {} as GatewayController,
    });

    for (const action of ["panel-post", "transcript-upload"]) {
      const response = await app.fetch(
        new Request("https://runtime.example/admin/api/tickets/test-action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ guildId: "guild-1", panelId: "main", action }),
        }),
      );
      assert.equal(response.status, 400);
      assert.equal(
        ((await response.json()) as { error: string }).error,
        "Invalid Discord resource.",
      );
    }
    assert.equal(discordCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp manages multiple ticket panels through admin APIs", async () => {
  const originalFetch = globalThis.fetch;
  const discordCalls: Array<{ method: string; url: string }> = [];
  const mainPanel: TicketPanelConfig = {
    ...createTicketPanelConfig(),
    panelId: "main",
    panelName: "Main panel",
    panelMessageId: "panel-message-1",
  };
  let panels: TicketPanelConfig[] = [mainPanel];
  const closedTicketQueries: Array<{ guildId: string; panelId?: string | null }> = [];
  let deleteShouldFail = true;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    discordCalls.push({ method, url });
    if (url.endsWith("/channels/panel-channel/messages/panel-message-1") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium", updatedAtMs: 0 };
        },
        async readTicketPanelConfig(guildId: string) {
          return panels.find((panel) => panel.guildId === guildId) ?? null;
        },
        async readTicketPanelConfigById(guildId: string, panelId: string) {
          return (
            panels.find((panel) => panel.guildId === guildId && panel.panelId === panelId) ?? null
          );
        },
        async listTicketPanelConfigs(guildId: string) {
          return panels.filter((panel) => panel.guildId === guildId);
        },
        async upsertTicketPanelConfig(panel: TicketPanelConfig) {
          panels = panels.filter((entry) => entry.panelId !== panel.panelId).concat(panel);
        },
        async deleteTicketPanelConfig(_guildId: string, panelId: string) {
          if (deleteShouldFail)
            throw new Error("Cannot delete a ticket panel while it has open tickets.");
          panels = panels.filter((panel) => panel.panelId !== panelId);
        },
        async listClosedTicketInstances(body: {
          guildId: string;
          panelId?: string | null;
          limit: number;
          beforeOpenedAtMs: number | null;
        }) {
          closedTicketQueries.push({ guildId: body.guildId, panelId: body.panelId });
          return { tickets: [], total: 0, nextCursor: null };
        },
      }),
      gateway: {} as GatewayController,
    });

    const cloneResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1", mode: "clone", sourcePanelId: "main" }),
      }),
    );
    assert.equal(cloneResponse.status, 200);
    const cloneBody = (await cloneResponse.json()) as { panel: TicketPanelConfig };
    assert.equal(cloneBody.panel.panelName, "Main panel copy");
    assert.equal(cloneBody.panel.panelChannelId, "");
    assert.equal(cloneBody.panel.panelMessageId, null);
    assert.equal(cloneBody.panel.ticketTypes[0]?.id, "appeals");

    const blankResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1", mode: "blank" }),
      }),
    );
    assert.equal(blankResponse.status, 200);
    const blankBody = (await blankResponse.json()) as { panel: TicketPanelConfig };
    assert.equal(blankBody.panel.panelName, "New panel");
    assert.deepEqual(blankBody.panel.ticketTypes, []);

    const unpublishResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel/unpublish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1", panelId: "main" }),
      }),
    );
    assert.equal(unpublishResponse.status, 200);
    assert.equal(panels.find((panel) => panel.panelId === "main")?.panelMessageId, null);
    assert.ok(
      discordCalls.some(
        (call) =>
          call.method === "DELETE" &&
          call.url.endsWith("/channels/panel-channel/messages/panel-message-1"),
      ),
    );

    const blockedDeleteResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1", panelId: "main" }),
      }),
    );
    assert.equal(blockedDeleteResponse.status, 409);

    deleteShouldFail = false;
    const deleteResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guildId: "guild-1", panelId: "main" }),
      }),
    );
    assert.equal(deleteResponse.status, 200);
    assert.equal(
      panels.some((panel) => panel.panelId === "main"),
      false,
    );

    const closedResponse = await app.fetch(
      new Request(
        "https://runtime.example/admin/api/tickets/closed?guildId=guild-1&panelId=staff",
        {},
      ),
    );
    assert.equal(closedResponse.status, 200);
    assert.deepEqual(closedTicketQueries.at(-1), { guildId: "guild-1", panelId: "staff" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp lists closed tickets through read-only ticket admin API pagination", async () => {
  const listCalls: Array<{
    guildId: string;
    panelId?: string | null;
    limit: number;
    beforeOpenedAtMs: number | null;
  }> = [];
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async listClosedTicketInstances(body: {
        guildId: string;
        panelId?: string | null;
        limit: number;
        beforeOpenedAtMs: number | null;
      }) {
        listCalls.push(body);
        return {
          total: 3,
          nextCursor: 1_700_000_000_000,
          tickets: [
            {
              guildId: body.guildId,
              channelId: "closed-channel-1",
              ticketTypeId: "appeals",
              ticketTypeLabel: "Appeal",
              openerUserId: "user-1",
              supportRoleId: "role-1",
              status: "closed" as const,
              answers: [],
              openedAtMs: 1_700_000_100_000,
              closedAtMs: 1_700_000_200_000,
              closedByUserId: "staff-1",
              transcriptMessageId: "transcript-1",
              staffThreadId: null,
            },
          ],
        };
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    new Request(
      "https://runtime.example/admin/api/tickets/closed?guildId=guild-1&limit=2&beforeOpenedAtMs=1700000100000",
    ),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    tickets: [
      {
        guildId: "guild-1",
        channelId: "closed-channel-1",
        ticketTypeId: "appeals",
        ticketTypeLabel: "Appeal",
        openerUserId: "user-1",
        supportRoleId: "role-1",
        status: "closed",
        answers: [],
        openedAtMs: 1_700_000_100_000,
        closedAtMs: 1_700_000_200_000,
        closedByUserId: "staff-1",
        transcriptMessageId: "transcript-1",
        staffThreadId: null,
      },
    ],
    total: 3,
    nextCursor: 1_700_000_000_000,
  });
  assert.deepEqual(listCalls, [
    { guildId: "guild-1", panelId: null, limit: 2, beforeOpenedAtMs: 1_700_000_100_000 },
  ]);
});

test("createRuntimeApp offers one basic Ticket Panel and Type on Free while gating paid controls", async () => {
  const panel = createTicketPanelConfig();
  const panelWithTwoTypes: TicketPanelConfig = {
    ...panel,
    ticketTypes: [
      panel.ticketTypes[0]!,
      {
        ...panel.ticketTypes[0]!,
        id: "support",
        label: "Support",
      },
    ],
  };
  let freeStoredPanel: TicketPanelConfig | null = null;
  const freeApp = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readTicketPanelConfig() {
        return freeStoredPanel;
      },
      async listTicketPanelConfigs() {
        return freeStoredPanel ? [freeStoredPanel] : [];
      },
      async upsertTicketPanelConfig(savedPanel: TicketPanelConfig) {
        freeStoredPanel = savedPanel;
      },
    }),
    gateway: {} as GatewayController,
  });

  const freeResponse = await freeApp.fetch(
    new Request("https://runtime.example/admin/api/tickets/panel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(panel),
    }),
  );
  assert.equal(freeResponse.status, 200);
  const freeBody = (await freeResponse.json()) as { ok: boolean; panel: TicketPanelConfig };
  assert.equal(freeBody.ok, true);
  assert.equal(freeBody.panel.ticketCreationLimit, 1);
  assert.equal(freeBody.panel.ticketTypes.length, 1);
  assert.deepEqual(freeBody.panel.ticketTypes[0]?.responseRules, []);

  const freeTypeLimitResponse = await freeApp.fetch(
    new Request("https://runtime.example/admin/api/tickets/panel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...freeBody.panel, ticketTypes: panelWithTwoTypes.ticketTypes }),
    }),
  );
  assert.equal(freeTypeLimitResponse.status, 402);
  assert.match(JSON.stringify(await freeTypeLimitResponse.json()), /1 Ticket Type per panel/);

  const paidControlPanels: Array<[string, TicketPanelConfig]> = [
    ["Custom Ticket Creation Limit", { ...freeBody.panel, ticketCreationLimit: 5 }],
    [
      "Custom limit rejection messages",
      { ...freeBody.panel, ticketLimitRejectionMessage: "Try later." },
    ],
    ["AI Transcript Summary", { ...freeBody.panel, aiTranscriptSummariesEnabled: true }],
    [
      "Creator role restrictions",
      {
        ...freeBody.panel,
        ticketTypes: [
          { ...freeBody.panel.ticketTypes[0]!, allowedCreatorRoleIds: ["role-member"] },
        ],
      },
    ],
    [
      "Ticket Response Rules",
      {
        ...freeBody.panel,
        ticketTypes: [
          {
            ...freeBody.panel.ticketTypes[0]!,
            responseRules: [{ id: "rule-1", conditions: [], message: "Automatic reply" }],
          },
        ],
      },
    ],
    [
      "Anonymous Support",
      {
        ...freeBody.panel,
        ticketTypes: [{ ...freeBody.panel.ticketTypes[0]!, anonymousSupportEnabled: true }],
      },
    ],
    [
      "Ticket Type Limit Exclusion",
      {
        ...freeBody.panel,
        ticketTypes: [{ ...freeBody.panel.ticketTypes[0]!, limitExclusion: true }],
      },
    ],
  ];
  for (const [capability, requestedPanel] of paidControlPanels) {
    const response = await freeApp.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestedPanel),
      }),
    );
    assert.equal(response.status, 402, capability);
    assert.match(JSON.stringify(await response.json()), new RegExp(capability));
  }

  const retainedPaidPanel: TicketPanelConfig = {
    ...freeBody.panel,
    panelTitle: "Retained paid setup",
    ticketCreationLimit: 5,
    ticketLimitRejectionMessage: "Custom paid rejection",
    aiTranscriptSummariesEnabled: true,
    ticketTypes: [
      {
        ...freeBody.panel.ticketTypes[0]!,
        allowedCreatorRoleIds: ["role-member"],
        responseRules: [{ id: "rule-1", conditions: [], message: "Retained rule" }],
        anonymousSupportEnabled: true,
        limitExclusion: true,
      },
      {
        ...freeBody.panel.ticketTypes[0]!,
        id: "retained-second-type",
        label: "Retained second type",
      },
    ],
  };
  freeStoredPanel = retainedPaidPanel;
  const retainedEditResponse = await freeApp.fetch(
    new Request("https://runtime.example/admin/api/tickets/panel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...retainedPaidPanel,
        panelTitle: "Basic field edited on Free",
        ticketTypes: [
          { ...retainedPaidPanel.ticketTypes[0]!, id: "renamed-on-free" },
          retainedPaidPanel.ticketTypes[1]!,
        ],
      }),
    }),
  );
  assert.equal(retainedEditResponse.status, 200);
  assert.equal(freeStoredPanel?.panelTitle, "Basic field edited on Free");
  assert.equal(freeStoredPanel?.ticketCreationLimit, 5);
  assert.equal(freeStoredPanel?.ticketTypes.length, 2);
  assert.equal(freeStoredPanel?.ticketTypes[0]?.id, "renamed-on-free");
  assert.equal(freeStoredPanel?.ticketTypes[0]?.responseRules[0]?.message, "Retained rule");

  const freeAiTestResponse = await freeApp.fetch(
    new Request("https://runtime.example/admin/api/tickets/test-action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1", panelId: "main", action: "ai-summary" }),
    }),
  );
  assert.equal(freeAiTestResponse.status, 402);
  assert.match(JSON.stringify(await freeAiTestResponse.json()), /upgraded plan/);

  const freeSecondPanelResponse = await freeApp.fetch(
    new Request("https://runtime.example/admin/api/tickets/panel/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1", mode: "blank" }),
    }),
  );
  assert.equal(freeSecondPanelResponse.status, 402);
  assert.match(JSON.stringify(await freeSecondPanelResponse.json()), /1 Ticket Panel/);

  const storedPanels: TicketPanelConfig[] = [];
  const premiumApp = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readGuildEntitlement(guildId: string) {
        return { guildId, tier: "premium", updatedAtMs: 0 };
      },
      async upsertTicketPanelConfig(savedPanel: TicketPanelConfig) {
        storedPanels.push(savedPanel);
      },
    }),
    gateway: {} as GatewayController,
  });

  const premiumResponse = await premiumApp.fetch(
    new Request("https://runtime.example/admin/api/tickets/panel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(panelWithTwoTypes),
    }),
  );
  assert.equal(premiumResponse.status, 200);
  assert.deepEqual(await premiumResponse.json(), { ok: true, panel: panelWithTwoTypes });
  assert.equal(storedPanels[0]?.ticketTypes.length, 2);
});

test("createRuntimeApp rejects ticket modal submits with invalid Steam IDs", async () => {
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const createdInstances: TicketInstance[] = [];
  const panel: TicketPanelConfig = {
    ...createTicketPanelConfig(true),
    ticketTypes: [
      {
        ...createTicketPanelConfig(true).ticketTypes[0]!,
        questions: [
          {
            id: "steam-id",
            label: "Steam ID",
            style: "short",
            placeholder: "76561198000000000 or Steam profile URL",
            required: true,
            validation: "steamId",
          },
        ],
      },
    ],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    discordCalls.push({ method: init?.method ?? "GET", url, body: init?.body ?? null });
    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async createTicketInstance(instance: TicketInstance) {
          createdInstances.push(instance);
        },
      }),
      gateway: {} as GatewayController,
    });

    const submitResponse = await app.fetch(
      createInteractionRequest({
        type: 5,
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: {
          custom_id: buildTicketOpenCustomId("appeals"),
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: "steam-id", value: "not-a-steam-id" }],
            },
          ],
        },
      }),
    );

    assert.equal(submitResponse.status, 200);
    assert.deepEqual(await submitResponse.json(), {
      type: 4,
      data: {
        flags: 64,
        content: "Please submit the ticket again with a valid SteamID64 or Steam profile URL.",
      },
    });
    assert.deepEqual(createdInstances, []);
    assert.deepEqual(discordCalls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp denies restricted ticket type opens for members without an allowed creator role", async () => {
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const createdInstances: TicketInstance[] = [];
  const panel: TicketPanelConfig = {
    ...createTicketPanelConfig(true),
    ticketTypes: [
      {
        ...createTicketPanelConfig(true).ticketTypes[0]!,
        allowedCreatorRoleIds: ["role-supporter"],
      },
    ],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    discordCalls.push({ method: init?.method ?? "GET", url, body: init?.body ?? null });
    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium", updatedAtMs: 0 };
        },
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async createTicketInstance(instance: TicketInstance) {
          createdInstances.push(instance);
        },
      }),
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: ["role-member"] },
        data: { custom_id: buildTicketOpenCustomId("appeals") },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: { flags: 64, content: "You do not have access to this ticket type." },
    });
    assert.deepEqual(createdInstances, []);
    assert.deepEqual(discordCalls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp denies restricted ticket modal submits for members without an allowed creator role", async () => {
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const createdInstances: TicketInstance[] = [];
  const panel: TicketPanelConfig = {
    ...createTicketPanelConfig(true),
    ticketTypes: [
      {
        ...createTicketPanelConfig(true).ticketTypes[0]!,
        allowedCreatorRoleIds: ["role-supporter"],
      },
    ],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    discordCalls.push({ method: init?.method ?? "GET", url, body: init?.body ?? null });
    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium", updatedAtMs: 0 };
        },
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async createTicketInstance(instance: TicketInstance) {
          createdInstances.push(instance);
        },
      }),
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 5,
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: ["role-member"] },
        data: {
          custom_id: buildTicketOpenCustomId("appeals"),
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: "reason", value: "Need help" }],
            },
          ],
        },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: { flags: 64, content: "You do not have access to this ticket type." },
    });
    assert.deepEqual(createdInstances, []);
    assert.deepEqual(discordCalls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp rejects ticket panel publish when referenced Discord targets are stale", async () => {
  const originalFetch = globalThis.fetch;
  let storedPanel: TicketPanelConfig | null = {
    ...createTicketPanelConfig(),
    panelChannelId: "missing-panel-channel",
    transcriptChannelId: "missing-transcript-channel",
    ticketTypes: [
      {
        ...createTicketPanelConfig().ticketTypes[0]!,
        supportRoleId: "missing-role",
        allowedCreatorRoleIds: ["role-1", "missing-creator-role"],
      },
    ],
  };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/guilds/guild-1/channels")) {
      return Response.json([
        { id: "category-1", name: "Tickets", type: 4, parent_id: null, position: 1 },
        { id: "panel-channel", name: "ticket-panel", type: 0, parent_id: null, position: 2 },
      ]);
    }

    if (url.endsWith("/guilds/guild-1/roles")) {
      return Response.json([{ id: "role-1", name: "Support", permissions: "0", position: 1 }]);
    }

    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      guildResources: createDiscordGuildResourceValidator("bot-token"),
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return storedPanel?.guildId === guildId ? storedPanel : null;
        },
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium", updatedAtMs: 0 };
        },
        async upsertTicketPanelConfig(panel: TicketPanelConfig) {
          storedPanel = panel;
        },
      }),
      gateway: {} as GatewayController,
    });
    const publishResponse = await app.fetch(
      new Request("https://runtime.example/admin/api/tickets/panel/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(storedPanel),
      }),
    );
    assert.equal(publishResponse.status, 400);
    assert.equal(
      ((await publishResponse.json()) as { error: string }).error,
      "Invalid Discord resource.",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp handles ticket open modal submit and close interactions", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const transcriptHtmlByKey = new Map<string, string>();
  const transcriptMediaByKey = new Map<string, { body: ArrayBuffer; contentType: string | null }>();
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const panel = createTicketPanelConfig(true);
  const componentIdSigner = createComponentIdSigner({
    currentSecret: "component-id-signing-secret-for-modal-ticket-test",
  });
  const signedCloseRequestCustomId = await componentIdSigner.issue({
    purpose: "ticket-close-request",
    customId: buildTicketCloseRequestCustomId("ticket-channel-1"),
    guildId: "guild-1",
  });
  const signedCloseCustomId = await componentIdSigner.issue({
    purpose: "ticket-close",
    customId: buildTicketCloseCustomId("ticket-channel-1"),
    guildId: "guild-1",
  });

  Date.now = () => 1_700_000_000_000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    let body: unknown = null;

    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    } else if (init?.body instanceof FormData) {
      body = {
        payload_json: init.body.get("payload_json"),
        transcript: init.body.get("files[0]"),
      };
    }

    discordCalls.push({ method, url, body });

    if (url.endsWith("/users/@me/guilds") && method === "GET") {
      return Response.json([{ id: "guild-1", name: "COLD AS FK" }]);
    }

    if (url.endsWith("/guilds/guild-1/channels") && method === "GET") {
      return Response.json([
        { id: "ticket-channel-1", name: "ticket-0011", type: 0, parent_id: null, position: 1 },
        {
          id: "transcript-channel",
          name: "ticket-transcripts",
          type: 0,
          parent_id: null,
          position: 2,
        },
      ]);
    }

    if (url.endsWith("/guilds/guild-1/roles") && method === "GET") {
      return Response.json([]);
    }

    if (url.endsWith("/guilds/guild-1/channels") && method === "POST") {
      return Response.json({ id: "ticket-channel-1" });
    }

    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      return Response.json({
        id: "opening-message-1",
        channel_id: "ticket-channel-1",
        content: "",
      });
    }

    if (url.endsWith("/channels/ticket-channel-1/messages?limit=100") && method === "GET") {
      return Response.json([
        {
          id: "message-2",
          channel_id: "ticket-channel-1",
          content: "Support reply",
          timestamp: "2024-01-01T00:00:01.000Z",
          author: {
            id: "staff-1",
            username: "mod",
            discriminator: "0002",
            global_name: "Support",
          },
          member: {
            nick: "CAF Assist",
          },
        },
        {
          id: "message-1",
          channel_id: "ticket-channel-1",
          content: "Need help",
          timestamp: "2024-01-01T00:00:00.000Z",
          author: {
            id: "user-1",
            username: "alice",
            discriminator: "0001",
            global_name: "Alice",
          },
          attachments: [
            {
              id: "attachment-image-1",
              filename: "proof.png",
              content_type: "image/png",
              size: 1536,
              url: "https://cdn.discordapp.com/attachments/ticket-channel-1/proof.png",
              proxy_url: "https://media.discordapp.net/attachments/ticket-channel-1/proof.png",
              width: 640,
              height: 480,
            },
            {
              id: "attachment-video-1",
              filename: "clip.mp4",
              content_type: "video/mp4",
              size: 1_048_576,
              url: "https://cdn.discordapp.com/attachments/ticket-channel-1/clip.mp4",
              proxy_url: "https://media.discordapp.net/attachments/ticket-channel-1/clip.mp4",
              width: 1280,
              height: 720,
            },
          ],
        },
      ]);
    }

    if (
      url === "https://cdn.discordapp.com/attachments/ticket-channel-1/proof.png" &&
      method === "GET"
    ) {
      return new Response("image-bytes", { headers: { "content-type": "image/png" } });
    }

    if (
      url === "https://cdn.discordapp.com/attachments/ticket-channel-1/clip.mp4" &&
      method === "GET"
    ) {
      return new Response("video-bytes", { headers: { "content-type": "video/mp4" } });
    }

    if (url.endsWith("/channels/transcript-channel/messages") && method === "POST") {
      return Response.json({
        id: "transcript-message-1",
        channel_id: "transcript-channel",
        content: "",
      });
    }

    if (url.endsWith("/channels/ticket-channel-1") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const fixture = createProductionRuntimeStores({ botUserId: "bot-user-id" });
    runtimeStoreFixtures.add(fixture);
    await fixture.stores.tickets.upsertTicketPanelConfig(panel);

    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      ticketTranscriptCapabilities: createSqliteTicketTranscriptCapabilityStore(
        fixture.database.d1,
      ),
      ticketTranscriptBlobs: {
        async putHtml(key: string, html: string) {
          transcriptHtmlByKey.set(key, html);
        },
        async getHtml(key: string) {
          return transcriptHtmlByKey.get(key) ?? null;
        },
        async putAttachment(
          key: string,
          body: ReadableStream<Uint8Array> | ArrayBuffer | string,
          options: { contentType: string | null },
        ) {
          transcriptMediaByKey.set(key, {
            body: await new Response(body).arrayBuffer(),
            contentType: options.contentType,
          });
        },
        async getAttachment(key: string) {
          return transcriptMediaByKey.get(key) ?? null;
        },
      },
      stores: fixture.stores,
      gateway: {} as GatewayController,
      componentIdSigner,
    });

    const openResponse = await app.fetch(
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: { custom_id: buildTicketOpenCustomId("appeals") },
      }),
    );
    assert.equal(openResponse.status, 200);
    assert.deepEqual(
      await openResponse.json(),
      buildTicketModalResponse(panel.ticketTypes[0]!, "main"),
    );

    const submitResponse = await app.fetch(
      createInteractionRequest({
        type: 5,
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: {
          custom_id: buildTicketOpenCustomId("appeals"),
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: "reason", value: "Need help" }],
            },
          ],
        },
      }),
    );
    assert.equal(submitResponse.status, 200);
    assert.deepEqual(await submitResponse.json(), {
      type: 4,
      data: { flags: 64, content: "Created your ticket: <#ticket-channel-1>" },
    });
    const storedOpenTicket = await fixture.stores.tickets.readOpenTicketByChannel(
      "guild-1",
      "ticket-channel-1",
    );
    assert.deepEqual(storedOpenTicket, {
      guildId: "guild-1",
      channelId: "ticket-channel-1",
      panelId: "main",
      ticketTypeId: "appeals",
      ticketTypeLabel: "Appeal",
      openerUserId: "user-1",
      supportRoleId: "role-1",
      status: "open",
      answers: [
        {
          questionId: "reason",
          label: "Why are you opening this ticket?",
          value: "Need help",
        },
      ],
      openedAtMs: 1_700_000_000_000,
      closedAtMs: null,
      closedByUserId: null,
      transcriptMessageId: null,
      staffThreadId: null,
      claimedByUserId: null,
      claimedAtMs: null,
      openingMessageId: "opening-message-1",
    });

    const channelCreateCall = discordCalls.find(
      (call) => call.method === "POST" && call.url.endsWith("/guilds/guild-1/channels"),
    );
    assert.deepEqual(channelCreateCall?.body, {
      name: "appeal-001",
      type: 0,
      parent_id: "category-1",
      permission_overwrites: [
        { id: "guild-1", type: 0, deny: "1024", allow: "0" },
        { id: "bot-user-id", type: 1, allow: "68608", deny: "0" },
        { id: "user-1", type: 1, allow: "68608", deny: "0" },
        { id: "role-1", type: 0, allow: "68608", deny: "0" },
      ],
    });

    const openMessageCall = discordCalls.find(
      (call) => call.method === "POST" && call.url.endsWith("/channels/ticket-channel-1/messages"),
    );
    assert.deepEqual(openMessageCall?.body, {
      content: "<@user-1>",
      allowed_mentions: { parse: [], users: ["user-1"] },
      embeds: [
        {
          title: "Appeal Ticket #001",
          color: 3066993,
          fields: [
            { name: "User", value: "<@user-1>" },
            { name: "Why are you opening this ticket?", value: "Need help" },
          ],
          footer: { text: "Ticket type: appeals" },
          timestamp: "2023-11-14T22:13:20.000Z",
        },
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              custom_id: signedCloseRequestCustomId,
              label: "Request Close",
              style: 2,
            },
            {
              type: 2,
              custom_id: signedCloseCustomId,
              label: "Close Ticket",
              style: 4,
            },
          ],
        },
      ],
    });

    const closeResponse = await app.fetch(
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: { custom_id: signedCloseCustomId },
      }),
    );
    assert.equal(closeResponse.status, 200);
    assert.deepEqual(await closeResponse.json(), {
      type: 4,
      data: { flags: 64, content: "Closed ticket and uploaded the transcript." },
    });
    assert.equal(
      await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "ticket-channel-1"),
      null,
    );
    const closedTickets = await fixture.stores.tickets.listClosedTicketInstances({
      guildId: "guild-1",
      limit: 10,
      beforeOpenedAtMs: null,
    });
    assert.deepEqual(
      closedTickets.tickets.map((ticket) => ({
        channelId: ticket.channelId,
        closedByUserId: ticket.closedByUserId,
        closedAtMs: ticket.closedAtMs,
        transcriptMessageId: ticket.transcriptMessageId,
      })),
      [
        {
          channelId: "ticket-channel-1",
          closedByUserId: "user-1",
          closedAtMs: 1_700_000_000_000,
          transcriptMessageId: "transcript-message-1",
        },
      ],
    );
    assert.ok(
      discordCalls.some(
        (call) => call.method === "DELETE" && call.url.endsWith("/channels/ticket-channel-1"),
      ),
    );

    const transcriptCall = discordCalls.find(
      (call) =>
        call.method === "POST" && call.url.endsWith("/channels/transcript-channel/messages"),
    );
    const transcriptPayload = JSON.parse(
      String(
        transcriptCall?.body && isRecord(transcriptCall.body)
          ? (transcriptCall.body as { payload_json: FormDataEntryValue | null }).payload_json
          : null,
      ),
    ) as {
      content?: string;
      embeds?: Array<{ title?: string; fields?: Array<{ name: string; value: string }> }>;
      attachments: Array<{ id: number; filename: string }>;
    };
    const transcriptUrlMatch =
      /HTML transcript: (https:\/\/runtime\.example\/transcripts\/[^\s]+)/.exec(
        transcriptPayload.content ?? "",
      );
    assert.ok(transcriptUrlMatch, "Expected HTML transcript URL in message content");
    const transcriptUrl = new URL(transcriptUrlMatch[1]!);
    const transcriptPath = transcriptUrl.pathname;
    const transcriptAccessToken = transcriptPath.split("/").pop();
    assert.ok(transcriptAccessToken, "Expected access token in transcript URL");
    assert.deepEqual(transcriptPayload.attachments, [
      { id: 0, filename: "ticket-ticket-channel-1.txt" },
    ]);
    assert.equal(transcriptPayload.embeds?.[0]?.title, "Ticket Transcript");
    assert.equal(
      transcriptPayload.embeds?.[0]?.fields?.find((field) => field.name === "Ticket Owner")?.value,
      "<@user-1>\nID: user-1",
    );
    assert.equal(
      transcriptPayload.embeds?.[0]?.fields?.find((field) => field.name === "Users in transcript")
        ?.value,
      "1 - Alice\n1 - CAF Assist",
    );
    assert.equal(
      transcriptPayload.embeds?.[0]?.fields?.find((field) => field.name === "Attachments")?.value,
      "2",
    );
    const archivedImageUrl = `https://runtime.example${buildTicketTranscriptAttachmentPath("guild-1", "ticket-channel-1", transcriptAccessToken, "attachment-image-1", "proof.png")}`;
    const archivedVideoUrl = `https://runtime.example${buildTicketTranscriptAttachmentPath("guild-1", "ticket-channel-1", transcriptAccessToken, "attachment-video-1", "clip.mp4")}`;
    const transcriptFile =
      transcriptCall?.body && isRecord(transcriptCall.body)
        ? ((transcriptCall.body as { transcript: FormDataEntryValue | null })
            .transcript as File | null)
        : null;
    assert.ok(transcriptFile instanceof File);
    assert.equal(
      await transcriptFile?.text(),
      `# Ticket Transcript
Guild: guild-1
Ticket Type: Appeal (appeals)
Channel: ticket-channel-1
Opened by: user-1
Support Role: role-1
Status: closed
Opened at: 2023-11-14T22:13:20.000Z
Closed at: 2023-11-14T22:13:20.000Z
Closed by: user-1

## Answers
- Why are you opening this ticket?: Need help

## Messages
[2024-01-01T00:00:00.000Z] Alice: Need help
  Image: proof.png (image/png, 1.5 KB) - ${archivedImageUrl}
  Video: clip.mp4 (video/mp4, 1 MB) - ${archivedVideoUrl}
[2024-01-01T00:00:01.000Z] CAF Assist: Support reply
`,
    );

    const transcriptResponse = await app.fetch(new Request(transcriptUrl.toString()));
    assert.equal(transcriptResponse.status, 200);
    assert.match(transcriptResponse.headers.get("content-type") ?? "", /text\/html/);
    const transcriptHtmlResponse = await transcriptResponse.text();
    assert.match(transcriptHtmlResponse, /<h1>Ticket Transcript<\/h1>/);
    assert.match(transcriptHtmlResponse, /Opened by<\/dt><dd>Alice \(user-1\)<\/dd>/);
    assert.match(transcriptHtmlResponse, /Closed by<\/dt><dd>user-1<\/dd>/);
    assert.ok(
      transcriptHtmlResponse.includes(
        `<img src="${archivedImageUrl}" alt="proof.png" loading="lazy" />`,
      ),
    );
    assert.ok(
      transcriptHtmlResponse.includes(
        `<video controls preload="metadata"><source src="${archivedVideoUrl}" type="video/mp4" /></video>`,
      ),
    );

    const mediaResponse = await app.fetch(new Request(archivedImageUrl));
    assert.equal(mediaResponse.status, 200);
    assert.equal(mediaResponse.headers.get("content-type"), "image/png");
    assert.equal(await mediaResponse.text(), "image-bytes");

    const missingTokenResponse = await app.fetch(
      new Request(
        `https://runtime.example${buildTicketTranscriptPath("guild-1", "ticket-channel-1", "wrong-token")}`,
      ),
    );
    assert.equal(missingTokenResponse.status, 404);
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp creates a ticket immediately when the ticket type has no modal questions", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const createdInstances: TicketInstance[] = [];
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const panel = {
    ...createTicketPanelConfig(true),
    ticketTypes: [
      {
        ...createTicketPanelConfig(true).ticketTypes[0]!,
        questions: [],
      },
    ],
  };

  Date.now = () => 1_700_000_000_000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    discordCalls.push({ method, url, body });

    if (url.endsWith("/guilds/guild-1/channels") && method === "POST") {
      return Response.json({ id: "ticket-channel-1", guild_id: "guild-1", name: "appeal-user-1" });
    }

    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      return Response.json({ id: "message-1" });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readConfig() {
          return { guilds: {}, botUserId: "bot-user-id" };
        },
        async reserveNextTicketNumber() {
          return 1;
        },
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async createTicketInstance(instance: TicketInstance) {
          createdInstances.push(instance);
        },
      }),
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: { custom_id: buildTicketOpenCustomId("appeals") },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: { flags: 64, content: "Created your ticket: <#ticket-channel-1>" },
    });
    const channelCreateCall = discordCalls.find(
      (call) => call.method === "POST" && call.url.endsWith("/guilds/guild-1/channels"),
    );
    assert.deepEqual(channelCreateCall?.body, {
      name: "appeal-001",
      type: 0,
      parent_id: "category-1",
      permission_overwrites: [
        { id: "guild-1", type: 0, deny: "1024", allow: "0" },
        { id: "bot-user-id", type: 1, allow: "68608", deny: "0" },
        { id: "user-1", type: 1, allow: "68608", deny: "0" },
        { id: "role-1", type: 0, allow: "68608", deny: "0" },
      ],
    });
    assert.deepEqual(createdInstances, [
      {
        guildId: "guild-1",
        channelId: "ticket-channel-1",
        panelId: "main",
        ticketTypeId: "appeals",
        ticketTypeLabel: "Appeal",
        openerUserId: "user-1",
        supportRoleId: "role-1",
        status: "open",
        answers: [],
        openedAtMs: 1_700_000_000_000,
        closedAtMs: null,
        closedByUserId: null,
        transcriptMessageId: null,
        staffThreadId: null,
        claimedByUserId: null,
        claimedAtMs: null,
        openingMessageId: "message-1",
      },
    ]);

    const openMessageCall = discordCalls.find(
      (call) => call.method === "POST" && call.url.endsWith("/channels/ticket-channel-1/messages"),
    );
    assert.deepEqual(openMessageCall?.body, {
      content: "<@user-1>",
      allowed_mentions: { parse: [], users: ["user-1"] },
      embeds: [
        {
          title: "Appeal Ticket #001",
          color: 3066993,
          fields: [{ name: "User", value: "<@user-1>" }],
          footer: { text: "Ticket type: appeals" },
          timestamp: "2023-11-14T22:13:20.000Z",
        },
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              custom_id: buildTicketCloseRequestCustomId("ticket-channel-1"),
              label: "Request Close",
              style: 2,
            },
            {
              type: 2,
              custom_id: buildTicketCloseCustomId("ticket-channel-1"),
              label: "Close Ticket",
              style: 4,
            },
          ],
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
  }
});

test("createRuntimeApp keeps retained paid Ticket controls dormant on Free", async () => {
  const originalFetch = globalThis.fetch;
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const createdInstances: TicketInstance[] = [];
  let openTicketCount = 1;
  const panel: TicketPanelConfig = {
    ...createTicketPanelConfig(true),
    ticketCreationLimit: 5,
    ticketLimitRejectionMessage: "Retained custom rejection",
    ticketTypes: [
      {
        ...createTicketPanelConfig(true).ticketTypes[0]!,
        questions: [],
        allowedCreatorRoleIds: ["paid-role"],
        responseRules: [{ id: "retained-rule", conditions: [], message: "Retained rule reply" }],
        anonymousSupportEnabled: true,
        staffDiscussionThreadEnabled: true,
        limitExclusion: true,
      },
    ],
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    discordCalls.push({ method, url, body });
    if (url.endsWith("/guilds/guild-1/channels") && method === "POST") {
      return Response.json({ id: "ticket-channel-1", guild_id: "guild-1", name: "appeal-001" });
    }
    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      return Response.json({ id: "message-1" });
    }
    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readConfig() {
          return { guilds: {}, botUserId: "bot-user-id" };
        },
        async readTicketPanelConfig() {
          return panel;
        },
        async countOpenTicketsByUser() {
          return openTicketCount;
        },
        async reserveNextTicketNumber() {
          return 1;
        },
        async createTicketInstance(instance: TicketInstance) {
          createdInstances.push(instance);
        },
      }),
      gateway: {} as GatewayController,
    });
    const request = () =>
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: { custom_id: buildTicketOpenCustomId("appeals") },
      });

    const limitedResponse = await app.fetch(request());
    assert.equal(limitedResponse.status, 200);
    assert.deepEqual(await limitedResponse.json(), {
      type: 4,
      data: {
        flags: 64,
        content:
          "You already have the maximum number of open tickets. Please close an existing ticket before opening another.",
      },
    });
    assert.equal(discordCalls.length, 0);

    openTicketCount = 0;
    const openedResponse = await app.fetch(request());
    assert.equal(openedResponse.status, 200);
    assert.deepEqual(await openedResponse.json(), {
      type: 4,
      data: { flags: 64, content: "Created your ticket: <#ticket-channel-1>" },
    });
    assert.equal(
      discordCalls.filter(
        (call) =>
          call.method === "POST" && call.url.endsWith("/channels/ticket-channel-1/messages"),
      ).length,
      1,
    );
    assert.equal(
      discordCalls.some((call) => call.url.includes("/threads")),
      false,
    );
    const channelCreateCall = discordCalls.find((call) =>
      call.url.endsWith("/guilds/guild-1/channels"),
    );
    assert.deepEqual(channelCreateCall?.body, {
      name: "appeal-001",
      type: 0,
      parent_id: "category-1",
      permission_overwrites: [
        { id: "guild-1", type: 0, deny: "1024", allow: "0" },
        { id: "bot-user-id", type: 1, allow: "68608", deny: "0" },
        { id: "user-1", type: 1, allow: "68608", deny: "0" },
        { id: "role-1", type: 0, allow: "68608", deny: "0" },
      ],
    });
    assert.equal(createdInstances[0]?.staffThreadId, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp defers ticket open without modal questions and finishes creation in waitUntil", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const waitUntilPromises: Promise<unknown>[] = [];
  const createdInstances: TicketInstance[] = [];
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  let resolveChannelCreate!: (response: Response) => void;
  let signalChannelCreateStarted!: () => void;
  const channelCreateStarted = new Promise<void>((resolve) => {
    signalChannelCreateStarted = resolve;
  });
  const panel: TicketPanelConfig = {
    ...createTicketPanelConfig(true),
    ticketTypes: [
      {
        ...createTicketPanelConfig(true).ticketTypes[0]!,
        questions: [],
      },
    ],
  };

  Date.now = () => 1_700_000_000_000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    discordCalls.push({ method, url, body });

    if (url.endsWith("/guilds/guild-1/channels") && method === "POST") {
      return new Promise<Response>((resolve) => {
        resolveChannelCreate = resolve;
        signalChannelCreateStarted();
      });
    }

    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      return Response.json({ id: `message-${discordCalls.length}` });
    }

    if (url.endsWith("/webhooks/application-1/token-1/messages/@original") && method === "PATCH") {
      return Response.json({ id: "original-message-1", channel_id: "interaction", content: "" });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readConfig() {
          return { guilds: {}, botUserId: "bot-user-id" };
        },
        async reserveNextTicketNumber() {
          return 1;
        },
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async createTicketInstance(instance: TicketInstance) {
          createdInstances.push(instance);
        },
      }),
      gateway: {} as GatewayController,
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    });

    const responsePromise = app.fetch(
      createInteractionRequest({
        type: 3,
        application_id: "application-1",
        token: "token-1",
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: { custom_id: buildTicketOpenCustomId("appeals") },
      }),
    );

    const responseOrPending = await Promise.race([
      responsePromise,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);
    assert.notEqual(responseOrPending, "pending");
    const response = responseOrPending as Response;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
    assert.equal(waitUntilPromises.length, 1);
    const createdBeforeChannelCreate = createdInstances.length;
    assert.equal(createdBeforeChannelCreate, 0);

    await channelCreateStarted;
    resolveChannelCreate(
      Response.json({ id: "ticket-channel-1", guild_id: "guild-1", name: "appeal-user-1" }),
    );
    await Promise.all(waitUntilPromises);

    assert.equal(createdInstances.length, 1);
    const messageCalls = discordCalls.filter(
      (call) => call.method === "POST" && call.url.endsWith("/channels/ticket-channel-1/messages"),
    );
    assert.equal(messageCalls.length, 1);
    const editCall = discordCalls.find(
      (call) =>
        call.method === "PATCH" &&
        call.url.endsWith("/webhooks/application-1/token-1/messages/@original"),
    );
    assert.deepEqual(editCall?.body, {
      flags: 64,
      content: "Created your ticket: <#ticket-channel-1>",
    });
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp posts a separate rendered auto-reply after opening a ticket", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const panel: TicketPanelConfig = {
    ...createTicketPanelConfig(true),
    ticketTypes: [
      {
        ...createTicketPanelConfig(true).ticketTypes[0]!,
        responseRules: [
          {
            id: "welcome",
            conditions: [],
            message: "Thanks {{answer.reason}}. An agent will be with you shortly.",
          },
        ],
      },
    ],
  };

  Date.now = () => 1_700_000_000_000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    discordCalls.push({ method, url, body });

    if (url.endsWith("/guilds/guild-1/channels") && method === "POST") {
      return Response.json({ id: "ticket-channel-1" });
    }

    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      return Response.json({ id: `message-${discordCalls.length}` });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium", updatedAtMs: 0 };
        },
        async readConfig() {
          return { guilds: {}, botUserId: "bot-user-id" };
        },
        async reserveNextTicketNumber() {
          return 1;
        },
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async createTicketInstance() {},
      }),
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 5,
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: {
          custom_id: buildTicketOpenCustomId("appeals"),
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: "reason", value: "Need help" }],
            },
          ],
        },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: { flags: 64, content: "Created your ticket: <#ticket-channel-1>" },
    });

    const autoReplyCalls = discordCalls.filter(
      (call) =>
        call.method === "POST" &&
        call.url.endsWith("/channels/ticket-channel-1/messages") &&
        isRecord(call.body) &&
        call.body.content === "Thanks Need help. An agent will be with you shortly.",
    );
    assert.deepEqual(
      autoReplyCalls.map((call) => call.body),
      [
        {
          content: "Thanks Need help. An agent will be with you shortly.",
          allowed_mentions: { parse: [] },
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
  }
});

test("createRuntimeApp defers ticket modal submit and finishes creation in waitUntil", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const waitUntilPromises: Promise<unknown>[] = [];
  const createdInstances: TicketInstance[] = [];
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  let resolveChannelCreate!: (response: Response) => void;
  let signalChannelCreateStarted!: () => void;
  const channelCreateStarted = new Promise<void>((resolve) => {
    signalChannelCreateStarted = resolve;
  });
  const panel: TicketPanelConfig = {
    ...createTicketPanelConfig(true),
    ticketTypes: [
      {
        ...createTicketPanelConfig(true).ticketTypes[0]!,
        responseRules: [
          {
            id: "welcome",
            conditions: [],
            message: "Thanks {{answer.reason}}. An agent will be with you shortly.",
          },
        ],
      },
    ],
  };

  Date.now = () => 1_700_000_000_000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    discordCalls.push({ method, url, body });

    if (url.endsWith("/guilds/guild-1/channels") && method === "POST") {
      return new Promise<Response>((resolve) => {
        resolveChannelCreate = resolve;
        signalChannelCreateStarted();
      });
    }

    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      return Response.json({ id: `message-${discordCalls.length}` });
    }

    if (url.endsWith("/webhooks/application-1/token-1/messages/@original") && method === "PATCH") {
      return Response.json({ id: "original-message-1", channel_id: "interaction", content: "" });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium", updatedAtMs: 0 };
        },
        async readConfig() {
          return { guilds: {}, botUserId: "bot-user-id" };
        },
        async reserveNextTicketNumber() {
          return 1;
        },
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async createTicketInstance(instance: TicketInstance) {
          createdInstances.push(instance);
        },
      }),
      gateway: {} as GatewayController,
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    });

    const responsePromise = app.fetch(
      createInteractionRequest({
        type: 5,
        application_id: "application-1",
        token: "token-1",
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: {
          custom_id: buildTicketOpenCustomId("appeals"),
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: "reason", value: "Need help" }],
            },
          ],
        },
      }),
    );

    const responseOrPending = await Promise.race([
      responsePromise,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);
    assert.notEqual(responseOrPending, "pending");
    const response = responseOrPending as Response;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
    assert.equal(waitUntilPromises.length, 1);
    const createdBeforeChannelCreate = createdInstances.length;
    assert.equal(createdBeforeChannelCreate, 0);

    await channelCreateStarted;
    resolveChannelCreate(Response.json({ id: "ticket-channel-1" }));
    await Promise.all(waitUntilPromises);

    assert.deepEqual(
      createdInstances.map((instance) => instance.answers),
      [[{ questionId: "reason", label: "Why are you opening this ticket?", value: "Need help" }]],
    );
    const messageCalls = discordCalls.filter(
      (call) => call.method === "POST" && call.url.endsWith("/channels/ticket-channel-1/messages"),
    );
    assert.equal(messageCalls.length, 2);
    assert.deepEqual(messageCalls[1]?.body, {
      content: "Thanks Need help. An agent will be with you shortly.",
      allowed_mentions: { parse: [] },
    });
    const editCall = discordCalls.find(
      (call) =>
        call.method === "PATCH" &&
        call.url.endsWith("/webhooks/application-1/token-1/messages/@original"),
    );
    assert.deepEqual(editCall?.body, {
      flags: 64,
      content: "Created your ticket: <#ticket-channel-1>",
    });
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp rolls back ticket creation when the opening message fails", async () => {
  const originalFetch = globalThis.fetch;
  const createdInstances: TicketInstance[] = [];
  const deletedInstances: Array<{ guildId: string; channelId: string }> = [];
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const panel = createTicketPanelConfig(true);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    discordCalls.push({ method, url, body });

    if (url.endsWith("/guilds/guild-1/channels") && method === "POST") {
      return Response.json({ id: "ticket-channel-1" });
    }

    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      return new Response("boom", { status: 500 });
    }

    if (url.endsWith("/channels/ticket-channel-1") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readConfig() {
          return { guilds: {}, botUserId: "bot-user-id" };
        },
        async reserveNextTicketNumber() {
          return 1;
        },
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async createTicketInstance(instance: TicketInstance) {
          createdInstances.push(instance);
        },
        async deleteTicketInstance(body: { guildId: string; channelId: string }) {
          deletedInstances.push(body);
        },
      }),
      gateway: {} as GatewayController,
    });

    const submitResponse = await app.fetch(
      createInteractionRequest({
        type: 5,
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: {
          custom_id: buildTicketOpenCustomId("appeals"),
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: "reason", value: "Need help" }],
            },
          ],
        },
      }),
    );
    assert.equal(submitResponse.status, 200);
    assert.deepEqual(await submitResponse.json(), {
      type: 4,
      data: { flags: 64, content: "Failed to create your ticket." },
    });
    assert.equal(createdInstances.length, 1);
    assert.deepEqual(deletedInstances, [{ guildId: "guild-1", channelId: "ticket-channel-1" }]);
    assert.ok(
      discordCalls.some(
        (call) => call.method === "DELETE" && call.url.endsWith("/channels/ticket-channel-1"),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp edits the deferred ticket response when background creation rolls back", async () => {
  const originalFetch = globalThis.fetch;
  const waitUntilPromises: Promise<unknown>[] = [];
  const createdInstances: TicketInstance[] = [];
  const deletedInstances: Array<{ guildId: string; channelId: string }> = [];
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const panel = createTicketPanelConfig(true);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    discordCalls.push({ method, url, body });

    if (url.endsWith("/guilds/guild-1/channels") && method === "POST") {
      return Response.json({ id: "ticket-channel-1" });
    }

    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      return new Response("boom", { status: 500 });
    }

    if (url.endsWith("/channels/ticket-channel-1") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    if (url.endsWith("/webhooks/application-1/token-1/messages/@original") && method === "PATCH") {
      return Response.json({ id: "original-message-1", channel_id: "interaction", content: "" });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readConfig() {
          return { guilds: {}, botUserId: "bot-user-id" };
        },
        async reserveNextTicketNumber() {
          return 1;
        },
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async createTicketInstance(instance: TicketInstance) {
          createdInstances.push(instance);
        },
        async deleteTicketInstance(body: { guildId: string; channelId: string }) {
          deletedInstances.push(body);
        },
      }),
      gateway: {} as GatewayController,
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    });

    const submitResponse = await app.fetch(
      createInteractionRequest({
        type: 5,
        application_id: "application-1",
        token: "token-1",
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: {
          custom_id: buildTicketOpenCustomId("appeals"),
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: "reason", value: "Need help" }],
            },
          ],
        },
      }),
    );

    assert.equal(submitResponse.status, 200);
    assert.deepEqual(await submitResponse.json(), { type: 5, data: { flags: 64 } });
    assert.equal(waitUntilPromises.length, 1);

    await Promise.all(waitUntilPromises);

    assert.equal(createdInstances.length, 1);
    assert.deepEqual(deletedInstances, [{ guildId: "guild-1", channelId: "ticket-channel-1" }]);
    assert.ok(
      discordCalls.some(
        (call) => call.method === "DELETE" && call.url.endsWith("/channels/ticket-channel-1"),
      ),
    );
    const editCall = discordCalls.find(
      (call) =>
        call.method === "PATCH" &&
        call.url.endsWith("/webhooks/application-1/token-1/messages/@original"),
    );
    assert.deepEqual(editCall?.body, {
      flags: 64,
      content: "Failed to create your ticket.",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp still opens the ticket when the auto-reply message fails", async () => {
  const originalFetch = globalThis.fetch;
  const createdInstances: TicketInstance[] = [];
  const deletedInstances: Array<{ guildId: string; channelId: string }> = [];
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const panel = {
    ...createTicketPanelConfig(true),
    ticketTypes: [
      {
        ...createTicketPanelConfig(true).ticketTypes[0],
        responseRules: [
          {
            id: "welcome",
            conditions: [],
            message: "Thanks {{answer.reason}}. An agent will be with you shortly.",
          },
        ],
      },
    ],
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    discordCalls.push({ method, url, body });

    if (url.endsWith("/guilds/guild-1/channels") && method === "POST") {
      return Response.json({ id: "ticket-channel-1" });
    }

    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      if (
        isRecord(body) &&
        "content" in body &&
        (body as { content?: string }).content ===
          "Thanks Need help. An agent will be with you shortly."
      ) {
        return new Response("boom", { status: 500 });
      }

      return Response.json({ id: `message-${discordCalls.length}` });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium", updatedAtMs: 0 };
        },
        async readConfig() {
          return { guilds: {}, botUserId: "bot-user-id" };
        },
        async reserveNextTicketNumber() {
          return 1;
        },
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async createTicketInstance(instance: TicketInstance) {
          createdInstances.push(instance);
        },
        async deleteTicketInstance(body: { guildId: string; channelId: string }) {
          deletedInstances.push(body);
        },
      }),
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 5,
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: {
          custom_id: buildTicketOpenCustomId("appeals"),
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: "reason", value: "Need help" }],
            },
          ],
        },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: { flags: 64, content: "Created your ticket: <#ticket-channel-1>" },
    });
    assert.equal(createdInstances.length, 1);
    assert.deepEqual(deletedInstances, []);
    assert.equal(
      discordCalls.filter(
        (call) =>
          call.method === "POST" && call.url.endsWith("/channels/ticket-channel-1/messages"),
      ).length,
      2,
    );
    assert.ok(
      !discordCalls.some(
        (call) => call.method === "DELETE" && call.url.endsWith("/channels/ticket-channel-1"),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp skips ticket auto-reply when disabled for the ticket type", async () => {
  const originalFetch = globalThis.fetch;
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const panel: TicketPanelConfig = {
    ...createTicketPanelConfig(true),
    ticketTypes: [{ ...createTicketPanelConfig(true).ticketTypes[0]!, responseRules: [] }],
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    discordCalls.push({ method, url, body });

    if (url.endsWith("/guilds/guild-1/channels") && method === "POST") {
      return Response.json({ id: "ticket-channel-1" });
    }

    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      return Response.json({ id: `message-${discordCalls.length}` });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readConfig() {
          return { guilds: {}, botUserId: "bot-user-id" };
        },
        async reserveNextTicketNumber() {
          return 1;
        },
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async createTicketInstance() {},
      }),
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 5,
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: {
          custom_id: buildTicketOpenCustomId("appeals"),
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: "reason", value: "Need help" }],
            },
          ],
        },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: { flags: 64, content: "Created your ticket: <#ticket-channel-1>" },
    });

    const messageCalls = discordCalls.filter(
      (call) => call.method === "POST" && call.url.endsWith("/channels/ticket-channel-1/messages"),
    );
    assert.equal(messageCalls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp lets support request ticket close approval from the opener", async () => {
  const originalFetch = globalThis.fetch;
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const openTicket: TicketInstance = {
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1_700_000_000_000,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
  };
  const panel = createTicketPanelConfig();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    discordCalls.push({ method, url, body });

    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      return Response.json({ id: "message-1", channel_id: "ticket-channel-1", content: "ok" });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async readOpenTicketByChannel(guildId: string, channelId: string) {
          return guildId === "guild-1" && channelId === "ticket-channel-1" ? openTicket : null;
        },
      }),
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { user: { id: "support-1" }, roles: ["role-1"] },
        data: { custom_id: buildTicketCloseRequestCustomId("ticket-channel-1") },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: { flags: 64, content: "Requested confirmation from the ticket opener." },
    });

    const requestMessageCall = discordCalls.find(
      (call) => call.method === "POST" && call.url.endsWith("/channels/ticket-channel-1/messages"),
    );
    assert.deepEqual(requestMessageCall?.body, {
      content:
        "<@user-1> <@support-1> requested to close this ticket. Do you want to close it now?",
      allowed_mentions: { parse: [], users: ["user-1"] },
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              custom_id: buildTicketCloseConfirmCustomId("ticket-channel-1"),
              label: "Yes, close ticket",
              style: 4,
            },
            {
              type: 2,
              custom_id: buildTicketCloseDeclineCustomId("ticket-channel-1"),
              label: "No, keep open",
              style: 2,
            },
          ],
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp lets support claim a ticket when claiming is enabled", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const claimUpdates: Array<{ claimedByUserId: string | null; claimedAtMs: number | null }> = [];
  const openTicket: TicketInstance = {
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1_700_000_000_000,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
    claimedByUserId: null,
    claimedAtMs: null,
  };
  const panel: TicketPanelConfig = { ...createTicketPanelConfig(), enableTicketClaiming: true };
  const openingMessage = {
    id: "opening-message-1",
    ...buildTicketOpeningMessage(openTicket, 1, { enableTicketClaiming: true }),
  };

  Date.now = () => 123;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    discordCalls.push({ method, url, body });

    if (url.endsWith("/channels/ticket-channel-1/messages/opening-message-1")) {
      if (method === "GET") return Response.json(openingMessage);
      if (method === "PATCH") return Response.json({ id: "opening-message-1" });
    }

    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      return Response.json({ id: "message-1", channel_id: "ticket-channel-1", content: "ok" });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const stores = createRuntimeStoresWithOverrides({});
    await stores.tickets.upsertTicketPanelConfig(panel);
    await stores.tickets.createTicketInstance(openTicket);
    const updateTicketClaim = stores.tickets.updateTicketClaim.bind(stores.tickets);
    stores.tickets.updateTicketClaim = async (body) => {
      await updateTicketClaim(body);
      claimUpdates.push({
        claimedByUserId: body.claimedByUserId,
        claimedAtMs: body.claimedAtMs,
      });
    };
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores,
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { user: { id: "support-1" }, roles: ["role-1"] },
        data: { custom_id: buildTicketClaimCustomId("ticket-channel-1") },
        message: openingMessage,
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: { flags: 64, content: "Claimed this ticket." },
    });
    assert.deepEqual(claimUpdates, [{ claimedByUserId: "support-1", claimedAtMs: 123 }]);
    const persisted = await stores.tickets.readOpenTicketByChannel("guild-1", "ticket-channel-1");
    assert.equal(persisted?.claimedByUserId, "support-1");
    assert.equal(persisted?.claimedAtMs, 123);
    assert.equal(persisted?.openingMessageId, "opening-message-1");
    const announcement = discordCalls.find(
      (call) => call.method === "POST" && call.url.endsWith("/channels/ticket-channel-1/messages"),
    );
    assert.ok(announcement);
    const { nonce, enforce_nonce, ...body } = announcement.body as Record<string, unknown>;
    assert.deepEqual(body, {
      content: "Ticket claimed by <@support-1>.",
      allowed_mentions: { parse: [], users: ["support-1"] },
    });
    assert.equal(enforce_nonce, true);
    assert.equal(typeof nonce, "string");
    const updatedOpening = discordCalls.find((call) => call.method === "PATCH")?.body as {
      embeds: Array<{ fields: Array<{ name: string; value: string }> }>;
    };
    assert.ok(
      updatedOpening.embeds[0]?.fields.some(
        (field) => field.name === "Claimed by" && field.value === "<@support-1>",
      ),
    );
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp returns ephemeral Ticket History for support staff", async () => {
  const currentTicket: TicketInstance = {
    guildId: "guild-1",
    channelId: "ticket-current",
    panelId: "main",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 300,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
  };
  const historicalTicket: TicketInstance = {
    ...currentTicket,
    channelId: "ticket-closed",
    status: "closed",
    openedAtMs: 100,
    closedAtMs: 200,
    closedByUserId: "staff-1",
    transcriptMessageId: "transcript-message-1",
  };
  const panel = createTicketPanelConfig();
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readOpenTicketByChannel(guildId: string, channelId: string) {
        return guildId === "guild-1" && channelId === "ticket-current" ? currentTicket : null;
      },
      async listTicketPanelConfigs() {
        return [panel];
      },
      async listMemberTicketHistory() {
        return { tickets: [historicalTicket], total: 1, nextCursor: null };
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    createInteractionRequest({
      type: 2,
      guild_id: "guild-1",
      channel_id: "ticket-current",
      member: { permissions: "0", user: { id: "staff-1" }, roles: ["role-1"] },
      data: { name: "ticket", options: [{ type: 1, name: "history" }] },
    }),
  );
  const body = (await response.json()) as {
    type: number;
    data: { flags: number; embeds: Array<{ description: string; fields: unknown[] }> };
  };

  assert.equal(response.status, 200);
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
  assert.equal(body.data.embeds[0]?.description, "1 Ticket for <@user-1>");
  assert.equal(body.data.embeds[0]?.fields.length, 1);
});

test("createRuntimeApp handles /ticket close in an open ticket channel", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const closeCalls: Array<{
    guildId: string;
    channelId: string;
    closedByUserId: string;
    closedAtMs: number;
    transcriptMessageId: string | null;
  }> = [];
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const openTicket: TicketInstance = {
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1_700_000_000_000,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
  };
  const panel = createTicketPanelConfig();

  Date.now = () => 1_700_000_000_000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    } else if (init?.body instanceof FormData) {
      body = {
        payload_json: init.body.get("payload_json"),
        transcript: init.body.get("files[0]"),
      };
    }
    discordCalls.push({ method, url, body });

    if (url.endsWith("/users/@me/guilds") && method === "GET") {
      return Response.json([{ id: "guild-1", name: "COLD AS FK" }]);
    }

    if (url.endsWith("/channels/transcript-channel/messages") && method === "POST") {
      return Response.json({ id: "transcript-message-1", channel_id: "transcript-channel" });
    }

    if (url.endsWith("/channels/ticket-channel-1") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    if (url.includes("/channels/ticket-channel-1/messages") && method === "GET") {
      return Response.json([]);
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async readOpenTicketByChannel(guildId: string, channelId: string) {
          return guildId === "guild-1" && channelId === "ticket-channel-1" ? openTicket : null;
        },
        async closeTicketInstance(body: {
          guildId: string;
          channelId: string;
          closedByUserId: string;
          closedAtMs: number;
          transcriptMessageId: string | null;
        }) {
          closeCalls.push(body);
        },
      }),
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 2,
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { permissions: "0", user: { id: "user-1", username: "Alice" }, roles: [] },
        data: { name: "ticket", options: [{ type: 1, name: "close" }] },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: { flags: 64, content: "Closed ticket and uploaded the transcript." },
    });
    assert.deepEqual(closeCalls, [
      {
        guildId: "guild-1",
        channelId: "ticket-channel-1",
        closedByUserId: "user-1",
        closedAtMs: 1_700_000_000_000,
        transcriptMessageId: "transcript-message-1",
      },
    ]);
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp rejects /ticket close outside an open ticket channel", async () => {
  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readOpenTicketByChannel() {
        return null;
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    createInteractionRequest({
      type: 2,
      guild_id: "guild-1",
      channel_id: "general-channel",
      member: { permissions: "0", user: { id: "user-1" }, roles: [] },
      data: { name: "ticket", options: [{ type: 1, name: "close" }] },
    }),
  );

  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("This ticket is already closed or missing."),
  );
});

test("createRuntimeApp lets support request ticket close via /ticket request-close", async () => {
  const originalFetch = globalThis.fetch;
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const openTicket: TicketInstance = {
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1_700_000_000_000,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
  };
  const panel = createTicketPanelConfig();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    discordCalls.push({ method, url, body });

    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      return Response.json({ id: "message-1", channel_id: "ticket-channel-1", content: "ok" });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async readOpenTicketByChannel(guildId: string, channelId: string) {
          return guildId === "guild-1" && channelId === "ticket-channel-1" ? openTicket : null;
        },
      }),
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 2,
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { permissions: "0", user: { id: "support-1" }, roles: ["role-1"] },
        data: { name: "ticket", options: [{ type: 1, name: "request-close" }] },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: { flags: 64, content: "Requested confirmation from the ticket opener." },
    });

    const requestMessageCall = discordCalls.find(
      (call) => call.method === "POST" && call.url.endsWith("/channels/ticket-channel-1/messages"),
    );
    assert.deepEqual(requestMessageCall?.body, {
      content:
        "<@user-1> <@support-1> requested to close this ticket. Do you want to close it now?",
      allowed_mentions: { parse: [], users: ["user-1"] },
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              custom_id: buildTicketCloseConfirmCustomId("ticket-channel-1"),
              label: "Yes, close ticket",
              style: 4,
            },
            {
              type: 2,
              custom_id: buildTicketCloseDeclineCustomId("ticket-channel-1"),
              label: "No, keep open",
              style: 2,
            },
          ],
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp lets support claim a ticket via /ticket claim", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const claimUpdates: Array<{ claimedByUserId: string | null; claimedAtMs: number | null }> = [];
  const openTicket: TicketInstance = {
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1_700_000_000_000,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
    claimedByUserId: null,
    claimedAtMs: null,
    openingMessageId: "opening-message-1",
  };
  const panel: TicketPanelConfig = { ...createTicketPanelConfig(), enableTicketClaiming: true };
  const openingMessage = {
    id: "opening-message-1",
    ...buildTicketOpeningMessage(openTicket, 1, { enableTicketClaiming: true }),
  };

  Date.now = () => 123;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    discordCalls.push({ method, url, body });

    if (url.endsWith("/channels/ticket-channel-1/messages/opening-message-1")) {
      if (method === "GET") return Response.json(openingMessage);
      if (method === "PATCH") return Response.json({ id: "opening-message-1" });
    }

    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      return Response.json({ id: "message-1", channel_id: "ticket-channel-1", content: "ok" });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const stores = createRuntimeStoresWithOverrides({});
    await stores.tickets.upsertTicketPanelConfig(panel);
    await stores.tickets.createTicketInstance(openTicket);
    const updateTicketClaim = stores.tickets.updateTicketClaim.bind(stores.tickets);
    stores.tickets.updateTicketClaim = async (body) => {
      await updateTicketClaim(body);
      claimUpdates.push(body);
    };
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores,
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 2,
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { permissions: "0", user: { id: "support-1" }, roles: ["role-1"] },
        data: { name: "ticket", options: [{ type: 1, name: "claim" }] },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: { flags: 64, content: "Claimed this ticket." },
    });
    assert.deepEqual(claimUpdates, [
      {
        guildId: "guild-1",
        channelId: "ticket-channel-1",
        claimedByUserId: "support-1",
        claimedAtMs: 123,
      },
    ]);
    const persisted = await stores.tickets.readOpenTicketByChannel("guild-1", "ticket-channel-1");
    assert.equal(persisted?.claimedByUserId, "support-1");
    assert.equal(persisted?.claimedAtMs, 123);
    assert.equal(persisted?.openingMessageId, "opening-message-1");
    const announcement = discordCalls.find(
      (call) => call.method === "POST" && call.url.endsWith("/channels/ticket-channel-1/messages"),
    );
    assert.ok(announcement);
    const { nonce, enforce_nonce, ...body } = announcement.body as Record<string, unknown>;
    assert.deepEqual(body, {
      content: "Ticket claimed by <@support-1>.",
      allowed_mentions: { parse: [], users: ["support-1"] },
    });
    assert.equal(enforce_nonce, true);
    assert.equal(typeof nonce, "string");
    const updatedOpening = discordCalls.find((call) => call.method === "PATCH")?.body as {
      embeds: Array<{ fields: Array<{ name: string; value: string }> }>;
    };
    assert.ok(
      updatedOpening.embeds[0]?.fields.some(
        (field) => field.name === "Claimed by" && field.value === "<@support-1>",
      ),
    );
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp rejects /ticket claim when member lacks support role", async () => {
  const openTicket: TicketInstance = {
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1_700_000_000_000,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
    claimedByUserId: null,
    claimedAtMs: null,
  };
  const panel: TicketPanelConfig = { ...createTicketPanelConfig(), enableTicketClaiming: true };

  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readTicketPanelConfig(guildId: string) {
        return guildId === "guild-1" ? panel : null;
      },
      async readOpenTicketByChannel(guildId: string, channelId: string) {
        return guildId === "guild-1" && channelId === "ticket-channel-1" ? openTicket : null;
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    createInteractionRequest({
      type: 2,
      guild_id: "guild-1",
      channel_id: "ticket-channel-1",
      member: { permissions: "0", user: { id: "member-1" }, roles: [] },
      data: { name: "ticket", options: [{ type: 1, name: "claim" }] },
    }),
  );

  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("Only the configured support role can claim this ticket."),
  );
});

test("createRuntimeApp defers a direct ticket close response and finishes the close in waitUntil", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const waitUntilPromises: Promise<unknown>[] = [];
  const closeCalls: Array<{
    guildId: string;
    channelId: string;
    closedByUserId: string;
    closedAtMs: number;
    transcriptMessageId: string | null;
  }> = [];
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const openTicket: TicketInstance = {
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1_700_000_000_000,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
  };
  const panel = createTicketPanelConfig();

  Date.now = () => 1_700_000_000_000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    } else if (init?.body instanceof FormData) {
      body = {
        payload_json: init.body.get("payload_json"),
        transcript: init.body.get("files[0]"),
      };
    }
    discordCalls.push({ method, url, body });

    if (url.endsWith("/channels/transcript-channel/messages") && method === "POST") {
      return Response.json({ id: "transcript-message-1", channel_id: "transcript-channel" });
    }

    if (url.endsWith("/channels/ticket-channel-1") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    if (url.includes("/channels/ticket-channel-1/messages") && method === "GET") {
      return Response.json([]);
    }

    if (url.endsWith("/webhooks/application-1/token-1/messages/@original") && method === "PATCH") {
      return Response.json({ id: "original-message-1", channel_id: "interaction", content: "" });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async readOpenTicketByChannel(guildId: string, channelId: string) {
          return guildId === "guild-1" && channelId === "ticket-channel-1" ? openTicket : null;
        },
        async closeTicketInstance(body: {
          guildId: string;
          channelId: string;
          closedByUserId: string;
          closedAtMs: number;
          transcriptMessageId: string | null;
        }) {
          closeCalls.push(body);
        },
      }),
      gateway: {} as GatewayController,
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 3,
        application_id: "application-1",
        token: "token-1",
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { user: { id: "user-1", username: "Alice" }, roles: [] },
        data: { custom_id: buildTicketCloseCustomId("ticket-channel-1") },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
    assert.equal(waitUntilPromises.length, 1);

    await Promise.all(waitUntilPromises);

    assert.deepEqual(closeCalls, [
      {
        guildId: "guild-1",
        channelId: "ticket-channel-1",
        closedByUserId: "user-1",
        closedAtMs: 1_700_000_000_000,
        transcriptMessageId: "transcript-message-1",
      },
    ]);
    assert.ok(
      discordCalls.some(
        (call) => call.method === "DELETE" && call.url.endsWith("/channels/ticket-channel-1"),
      ),
    );
    const editCall = discordCalls.find(
      (call) =>
        call.method === "PATCH" &&
        call.url.endsWith("/webhooks/application-1/token-1/messages/@original"),
    );
    assert.deepEqual(editCall?.body, {
      flags: 64,
      content: "Closed ticket and uploaded the transcript.",
    });
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});
test("createRuntimeApp defers a close confirmation response and finishes the close in waitUntil", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const waitUntilPromises: Promise<unknown>[] = [];
  const closeCalls: Array<{
    guildId: string;
    channelId: string;
    closedByUserId: string;
    closedAtMs: number;
    transcriptMessageId: string | null;
  }> = [];
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const openTicket: TicketInstance = {
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1_700_000_000_000,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
  };
  const panel = createTicketPanelConfig();

  Date.now = () => 1_700_000_000_000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    } else if (init?.body instanceof FormData) {
      body = {
        payload_json: init.body.get("payload_json"),
        transcript: init.body.get("files[0]"),
      };
    }
    discordCalls.push({ method, url, body });

    if (url.endsWith("/channels/transcript-channel/messages") && method === "POST") {
      return Response.json({ id: "transcript-message-1", channel_id: "transcript-channel" });
    }

    if (url.endsWith("/channels/ticket-channel-1") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    if (url.includes("/channels/ticket-channel-1/messages") && method === "GET") {
      return Response.json([]);
    }

    if (url.endsWith("/webhooks/application-1/token-1/messages/@original") && method === "PATCH") {
      return Response.json({ id: "original-message-1", channel_id: "interaction", content: "" });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async readOpenTicketByChannel(guildId: string, channelId: string) {
          return guildId === "guild-1" && channelId === "ticket-channel-1" ? openTicket : null;
        },
        async closeTicketInstance(body: {
          guildId: string;
          channelId: string;
          closedByUserId: string;
          closedAtMs: number;
          transcriptMessageId: string | null;
        }) {
          closeCalls.push(body);
        },
      }),
      gateway: {} as GatewayController,
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 3,
        application_id: "application-1",
        token: "token-1",
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { user: { id: "user-1", username: "Alice" }, roles: [] },
        data: { custom_id: buildTicketCloseConfirmCustomId("ticket-channel-1") },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
    assert.equal(waitUntilPromises.length, 1);

    await Promise.all(waitUntilPromises);

    assert.deepEqual(closeCalls, [
      {
        guildId: "guild-1",
        channelId: "ticket-channel-1",
        closedByUserId: "user-1",
        closedAtMs: 1_700_000_000_000,
        transcriptMessageId: "transcript-message-1",
      },
    ]);
    assert.ok(
      discordCalls.some(
        (call) => call.method === "DELETE" && call.url.endsWith("/channels/ticket-channel-1"),
      ),
    );
    const editCall = discordCalls.find(
      (call) =>
        call.method === "PATCH" &&
        call.url.endsWith("/webhooks/application-1/token-1/messages/@original"),
    );
    assert.deepEqual(editCall?.body, {
      flags: 64,
      content: "Closed ticket and uploaded the transcript.",
    });
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp closes a ticket after the opener approves a close request", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const closeCalls: Array<{
    guildId: string;
    channelId: string;
    closedByUserId: string;
    closedAtMs: number;
    transcriptMessageId: string | null;
  }> = [];
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const openTicket: TicketInstance = {
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1_700_000_000_000,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
  };
  const panel = createTicketPanelConfig();

  Date.now = () => 1_700_000_000_000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    } else if (init?.body instanceof FormData) {
      body = {
        payload_json: init.body.get("payload_json"),
        transcript: init.body.get("files[0]"),
      };
    }
    discordCalls.push({ method, url, body });

    if (url.endsWith("/channels/transcript-channel/messages") && method === "POST") {
      return Response.json({ id: "transcript-message-1", channel_id: "transcript-channel" });
    }

    if (url.endsWith("/channels/ticket-channel-1") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    if (url.includes("/channels/ticket-channel-1/messages") && method === "GET") {
      return Response.json([]);
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async readOpenTicketByChannel(guildId: string, channelId: string) {
          return guildId === "guild-1" && channelId === "ticket-channel-1" ? openTicket : null;
        },
        async closeTicketInstance(body: {
          guildId: string;
          channelId: string;
          closedByUserId: string;
          closedAtMs: number;
          transcriptMessageId: string | null;
        }) {
          closeCalls.push(body);
        },
      }),
      gateway: {} as GatewayController,
    });

    const response = await app.fetch(
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { user: { id: "user-1", username: "Alice" }, roles: [] },
        data: { custom_id: buildTicketCloseConfirmCustomId("ticket-channel-1") },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: { flags: 64, content: "Closed ticket and uploaded the transcript." },
    });
    assert.deepEqual(closeCalls, [
      {
        guildId: "guild-1",
        channelId: "ticket-channel-1",
        closedByUserId: "user-1",
        closedAtMs: 1_700_000_000_000,
        transcriptMessageId: "transcript-message-1",
      },
    ]);
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp leaves a ticket open when the opener declines a close request", async () => {
  const openTicket: TicketInstance = {
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1_700_000_000_000,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
  };

  const app = createRuntimeApp({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createRuntimeStoresWithOverrides({
      async readOpenTicketByChannel(guildId: string, channelId: string) {
        return guildId === "guild-1" && channelId === "ticket-channel-1" ? openTicket : null;
      },
    }),
    gateway: {} as GatewayController,
  });

  const response = await app.fetch(
    createInteractionRequest({
      type: 3,
      guild_id: "guild-1",
      channel_id: "ticket-channel-1",
      member: { user: { id: "user-1" }, roles: [] },
      data: { custom_id: buildTicketCloseDeclineCustomId("ticket-channel-1") },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 7,
    data: {
      content: "The ticket opener chose to keep this ticket open.",
      allowed_mentions: { parse: [] },
      components: [],
    },
  });
});

test("createRuntimeApp rejects wrong-actor and expired signed close controls before mutation", async () => {
  const originalDateNow = Date.now;
  let nowMs = 1_700_000_000_000;
  let closeTicketInstanceCalls = 0;
  const openTicket: TicketInstance = {
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1_700_000_000_000,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
  };
  const componentIdSigner = createComponentIdSigner(
    { currentSecret: "component-id-signing-secret-for-ticket-close-test" },
    { now: () => nowMs },
  );
  const expiresAtMs = nowMs + 24 * 60 * 60 * 1000;
  const signedConfirm = await componentIdSigner.issue({
    purpose: "ticket-close-confirm",
    customId: buildTicketCloseConfirmCustomId("ticket-channel-1"),
    guildId: "guild-1",
    actorUserId: "user-1",
    expiresAtMs,
  });
  const signedDecline = await componentIdSigner.issue({
    purpose: "ticket-close-decline",
    customId: buildTicketCloseDeclineCustomId("ticket-channel-1"),
    guildId: "guild-1",
    actorUserId: "user-1",
    expiresAtMs,
  });
  const existingSignedDecline = await componentIdSigner.issue({
    purpose: "ticket-close-decline",
    customId: buildTicketCloseDeclineCustomId("ticket-channel-1"),
    guildId: "guild-1",
  });
  Date.now = () => nowMs;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readOpenTicketByChannel(guildId: string, channelId: string) {
          return guildId === "guild-1" && channelId === "ticket-channel-1" ? openTicket : null;
        },
        async closeTicketInstance() {
          closeTicketInstanceCalls += 1;
        },
      }),
      gateway: {} as GatewayController,
      componentIdSigner,
    });

    const validResponse = await app.fetch(
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: { custom_id: signedDecline },
      }),
    );
    assert.deepEqual(await validResponse.json(), {
      type: 7,
      data: {
        content: "The ticket opener chose to keep this ticket open.",
        allowed_mentions: { parse: [] },
        components: [],
      },
    });

    const existingEnvelopeResponse = await app.fetch(
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: { custom_id: existingSignedDecline },
      }),
    );
    assert.deepEqual(await existingEnvelopeResponse.json(), {
      type: 4,
      data: { flags: 64, content: "This action is no longer available." },
    });

    const wrongActorResponse = await app.fetch(
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { user: { id: "different-user" }, roles: [] },
        data: { custom_id: signedConfirm },
      }),
    );
    assert.deepEqual(await wrongActorResponse.json(), {
      type: 4,
      data: { flags: 64, content: "This action is no longer available." },
    });

    nowMs = expiresAtMs + 31_000;
    const expiredResponse = await app.fetch(
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: { custom_id: signedConfirm },
      }),
    );
    assert.deepEqual(await expiredResponse.json(), {
      type: 4,
      data: { flags: 64, content: "This action is no longer available." },
    });
    assert.equal(openTicket.status, "open");
    assert.equal(openTicket.closedByUserId, null);
    assert.equal(closeTicketInstanceCalls, 0);
  } finally {
    Date.now = originalDateNow;
  }
});

test("createRuntimeApp returns an ephemeral failure when ticket channel creation fails", async () => {
  const originalFetch = globalThis.fetch;
  let createTicketInstanceCalls = 0;
  const panel = createTicketPanelConfig(true);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";

    if (url.endsWith("/guilds/guild-1/channels") && method === "POST") {
      return new Response("boom", { status: 500 });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readConfig() {
          return { guilds: {}, botUserId: "bot-user-id" };
        },
        async reserveNextTicketNumber() {
          return 1;
        },
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async createTicketInstance() {
          createTicketInstanceCalls += 1;
        },
      }),
      gateway: {} as GatewayController,
    });

    const submitResponse = await app.fetch(
      createInteractionRequest({
        type: 5,
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: {
          custom_id: buildTicketOpenCustomId("appeals"),
          components: [
            {
              type: 1,
              components: [{ type: 4, custom_id: "reason", value: "Need help" }],
            },
          ],
        },
      }),
    );
    assert.equal(submitResponse.status, 200);
    assert.deepEqual(await submitResponse.json(), {
      type: 4,
      data: { flags: 64, content: "Failed to create your ticket." },
    });
    assert.equal(createTicketInstanceCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp keeps the ticket open and posts an in-channel error when transcript upload fails", async () => {
  const originalFetch = globalThis.fetch;
  const closeCalls: Array<{
    guildId: string;
    channelId: string;
    closedByUserId: string;
    closedAtMs: number;
    transcriptMessageId: string | null;
  }> = [];
  const discordCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const panel = createTicketPanelConfig();
  const openTicket: TicketInstance = {
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [
      {
        questionId: "reason",
        label: "Why are you opening this ticket?",
        value: "Need help",
      },
    ],
    openedAtMs: 1_700_000_000_000,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    let body: unknown = null;

    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    } else if (init?.body instanceof FormData) {
      body = {
        payload_json: init.body.get("payload_json"),
        transcript: init.body.get("files[0]"),
      };
    }

    discordCalls.push({ method, url, body });

    if (url.endsWith("/channels/ticket-channel-1/messages?limit=100") && method === "GET") {
      return Response.json([
        {
          id: "message-1",
          channel_id: "ticket-channel-1",
          content: "Need help",
          timestamp: "2024-01-01T00:00:00.000Z",
          author: {
            id: "user-1",
            username: "alice",
            discriminator: "0001",
            global_name: "Alice",
          },
        },
      ]);
    }

    if (url.endsWith("/channels/transcript-channel/messages") && method === "POST") {
      return new Response("boom", { status: 500 });
    }

    if (url.endsWith("/channels/ticket-channel-1/messages") && method === "POST") {
      return Response.json({
        id: "warning-message-1",
        channel_id: "ticket-channel-1",
        content: "",
      });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async readOpenTicketByChannel(guildId: string, channelId: string) {
          return guildId === "guild-1" && channelId === "ticket-channel-1" ? openTicket : null;
        },
        async closeTicketInstance(body: {
          guildId: string;
          channelId: string;
          closedByUserId: string;
          closedAtMs: number;
          transcriptMessageId: string | null;
        }) {
          closeCalls.push(body);
        },
      }),
      gateway: {} as GatewayController,
    });

    const closeResponse = await app.fetch(
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: { custom_id: buildTicketCloseCustomId("ticket-channel-1") },
      }),
    );
    assert.equal(closeResponse.status, 200);
    assert.deepEqual(await closeResponse.json(), {
      type: 4,
      data: {
        flags: 64,
        content:
          "Failed to upload the transcript. The ticket is still open, and a warning was posted in the channel.",
      },
    });
    assert.deepEqual(closeCalls, []);
    assert.ok(
      !discordCalls.some(
        (call) => call.method === "DELETE" && call.url.endsWith("/channels/ticket-channel-1"),
      ),
    );
    const warningCall =
      [...discordCalls]
        .reverse()
        .find(
          (call) =>
            call.method === "POST" && call.url.endsWith("/channels/ticket-channel-1/messages"),
        ) ?? null;
    assert.deepEqual(warningCall?.body, {
      content:
        "Failed to upload the transcript for this ticket. The ticket will remain open so support staff can retry closing it.",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRuntimeApp reports partial success when ticket close cleanup fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const closeCalls: Array<{
    guildId: string;
    channelId: string;
    closedByUserId: string;
    closedAtMs: number;
    transcriptMessageId: string | null;
  }> = [];
  const panel = createTicketPanelConfig();
  const openTicket: TicketInstance = {
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1_700_000_000_000,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";

    if (url.endsWith("/channels/ticket-channel-1/messages?limit=100") && method === "GET") {
      return Response.json([]);
    }

    if (url.endsWith("/channels/transcript-channel/messages") && method === "POST") {
      return Response.json({
        id: "transcript-message-1",
        channel_id: "transcript-channel",
        content: "",
      });
    }

    if (url.endsWith("/channels/ticket-channel-1") && method === "DELETE") {
      return new Response("boom", { status: 500 });
    }

    throw new Error(`Unexpected Discord call: ${method} ${url}`);
  }) as typeof fetch;

  try {
    Date.now = () => 1_700_000_000_000;
    const app = createRuntimeApp({
      discordPublicKey: "a".repeat(64),
      discordBotToken: "bot-token",
      verifyDiscordRequest: async () => true,
      stores: createRuntimeStoresWithOverrides({
        async readTicketPanelConfig(guildId: string) {
          return guildId === "guild-1" ? panel : null;
        },
        async readOpenTicketByChannel(guildId: string, channelId: string) {
          return guildId === "guild-1" && channelId === "ticket-channel-1" ? openTicket : null;
        },
        async closeTicketInstance(body: {
          guildId: string;
          channelId: string;
          closedByUserId: string;
          closedAtMs: number;
          transcriptMessageId: string | null;
        }) {
          closeCalls.push(body);
        },
      }),
      gateway: {} as GatewayController,
    });

    const closeResponse = await app.fetch(
      createInteractionRequest({
        type: 3,
        guild_id: "guild-1",
        channel_id: "ticket-channel-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: { custom_id: buildTicketCloseCustomId("ticket-channel-1") },
      }),
    );
    assert.equal(closeResponse.status, 200);
    assert.deepEqual(await closeResponse.json(), {
      type: 4,
      data: {
        flags: 64,
        content:
          "Closed ticket and uploaded the transcript, but failed to delete the channel. Please clean it up manually.",
      },
    });
    assert.deepEqual(closeCalls, [
      {
        guildId: "guild-1",
        channelId: "ticket-channel-1",
        closedByUserId: "user-1",
        closedAtMs: 1_700_000_000_000,
        transcriptMessageId: "transcript-message-1",
      },
    ]);
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

function createInteractionRequest(body: unknown): Request {
  return new Request("https://runtime.example/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": "ignored-for-test",
      "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
    },
    body: JSON.stringify(body),
  });
}

function createHafAdminCommand(
  options:
    | {
        interactionGuildId: string;
        memberRoles: unknown;
        subcommand: "show-plan" | "repair-verification-panel";
        guildId: string;
      }
    | {
        interactionGuildId: string;
        memberRoles: unknown;
        subcommand: "list-guilds";
      }
    | {
        interactionGuildId: string;
        memberRoles: unknown;
        subcommand: "list-suspensions";
      }
    | {
        interactionGuildId: string;
        memberRoles: unknown;
        subcommand: "gateway-status" | "start-gateway";
      }
    | {
        interactionGuildId: string;
        memberRoles: unknown;
        subcommand: "suspend-guild";
        guildId: string;
        reason: string;
      }
    | {
        interactionGuildId: string;
        memberRoles: unknown;
        subcommand: "leave-guild";
        guildId: string;
        reason: string;
        confirmedGuildId: string;
      }
    | {
        interactionGuildId: string;
        memberRoles: unknown;
        subcommand: "restore-guild";
        guildId: string;
      },
) {
  const subOptions =
    "guildId" in options
      ? [
          { type: 3, name: "guild_id", value: options.guildId },
          ...(options.subcommand === "suspend-guild" || options.subcommand === "leave-guild"
            ? [{ type: 3, name: "reason", value: options.reason }]
            : []),
          ...(options.subcommand === "leave-guild"
            ? [{ type: 3, name: "confirm_guild_id", value: options.confirmedGuildId }]
            : []),
        ]
      : [];

  return {
    type: 2,
    guild_id: options.interactionGuildId,
    member: {
      permissions: "0",
      roles: options.memberRoles,
      user: { id: "haf-admin-user" },
    },
    data: {
      name: "haf-admin",
      options: [{ type: 1, name: options.subcommand, options: subOptions }],
    },
  };
}

function createTicketPanelConfig(published = false): TicketPanelConfig {
  return {
    guildId: "guild-1",
    panelChannelId: "panel-channel",
    categoryChannelId: "category-1",
    transcriptChannelId: "transcript-channel",
    panelEmoji: "🎫",
    panelTitle: "Support tickets",
    panelDescription: "Use the button below to open a ticket.",
    panelFooter: "TicketTool.xyz - Ticketing without clutter",
    panelColor: 0x57f287,
    panelMessageId: published ? "published-panel" : null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    aiTranscriptSummariesEnabled: false,
    ticketTypes: [
      {
        id: "appeals",
        label: "Appeal",
        emoji: "🧾",
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "appeal",
        responseRules: [],
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        ticketHistoryPromptVisibility: "off",
        limitExclusion: false,
        mentionSupportRole: false,
        participantManagementEnabled: false,
        questions: [
          {
            id: "reason",
            label: "Why are you opening this ticket?",
            style: "paragraph",
            placeholder: "Explain the situation",
            required: true,
          },
        ],
      },
    ],
  };
}

function assertTicketPanelValidationIssue(body: unknown, path: string): void {
  assert.equal(typeof body, "object");
  assert.notEqual(body, null);
  const response = body as { error?: unknown; fieldIssues?: Array<{ path?: unknown }> };
  assert.equal(response.error, "Invalid request body");
  assert.ok(
    response.fieldIssues?.some((issue) => issue.path === path),
    `expected ticket panel validation issue at ${path}`,
  );
}

function createCustomerAuthMock(options?: {
  organizations?: Array<{ id: string; name: string; slug: string; role: string }>;
  activeRole?: string;
}) {
  return {
    handler: async () => new Response(null, { status: 404 }),
    api: {
      getSession: async () => ({
        session: { activeOrganizationId: null },
        user: {
          id: "user-1",
          discordUserId: "discord-user-1",
          name: "Customer User",
        },
      }),
      setActiveOrganization: async () => ({ id: "workspace-1" }),
      getActiveMember: async () => ({
        userId: "user-1",
        organizationId: "workspace-1",
        role: options?.activeRole ?? "owner",
      }),
      getActiveMemberRole: async ({ query }: { query: { organizationId: string } }) => ({
        role:
          options?.organizations?.find((org) => org.id === query.organizationId)?.role ??
          options?.activeRole ??
          "owner",
      }),
      listOrganizations: async () =>
        (options?.organizations ?? []).map(({ role: _role, ...org }) => org),
    },
  } as never;
}

function createWorkspaceStoreMock(guildIds: string[]) {
  return {
    linkGuildToWorkspace: async () => {},
    unlinkGuildFromWorkspace: async () => {},
    listGuildsForWorkspace: async (workspaceId: string) =>
      guildIds.map((guildId, index) => ({
        workspaceId,
        guildId,
        linkedByUserId: "user-1",
        linkedAtMs: index,
      })),
    isGuildLinkedToWorkspace: async (_workspaceId: string, guildId: string) =>
      guildIds.includes(guildId),
    readWorkspaceIdForGuild: async (guildId: string) =>
      guildIds.includes(guildId) ? "workspace-1" : null,
    readEntitlement: async (workspaceId: string) => ({
      workspaceId,
      plan: "free",
      status: "manual",
      enabledFlags: [],
      updatedAtMs: 0,
    }),
    upsertEntitlement: async () => {},
  } as never;
}

function createPermissiveWorkspaceStoreMock() {
  return {
    linkGuildToWorkspace: async () => {},
    unlinkGuildFromWorkspace: async () => {},
    listGuildsForWorkspace: async () =>
      ["guild-1", "guild-2", "guild-3"].map((guildId) => ({
        workspaceId: "workspace-1",
        guildId,
        linkedByUserId: "user-1",
        linkedAtMs: 0,
      })),
    isGuildLinkedToWorkspace: async () => true,
    readWorkspaceIdForGuild: async () => "workspace-1",
    readEntitlement: async () => ({
      workspaceId: "workspace-1",
      plan: "free",
      status: "manual",
      enabledFlags: [],
      updatedAtMs: 0,
    }),
    upsertEntitlement: async () => {},
  } as never;
}

test("self-service access separates feature, delegation and owner policy capabilities", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const persona of [
      "owner",
      "administrator",
      "manager",
      "nominated",
      "ordinary",
      "failed",
    ] as const) {
      for (const enabled of [true, false]) {
        const stores = createRuntimeStoresWithOverrides({});
        await stores.guildRbac.setManageServerAdminEnabled("guild-1", enabled);
        await stores.guildRbac.upsertGuildAdminRoleId("guild-1", "nominated-role");
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (persona === "failed")
            return Response.json({ message: "Unavailable" }, { status: 403 });
          if (url.endsWith("/guilds/guild-1"))
            return Response.json({
              id: "guild-1",
              name: "Synthetic guild",
              owner_id: persona === "owner" ? "discord-user-1" : "someone-else",
            });
          if (url.endsWith("/members/discord-user-1"))
            return Response.json({ user: { id: "discord-user-1" }, roles: [persona + "-role"] });
          if (url.endsWith("/roles"))
            return Response.json([
              { id: "guild-1", name: "@everyone", permissions: "0", position: 0 },
              { id: "administrator-role", name: "Admin", permissions: "8", position: 1 },
              { id: "manager-role", name: "Manager", permissions: "32", position: 1 },
              { id: "nominated-role", name: "HAF", permissions: "0", position: 1 },
            ]);
          throw new Error(`Unexpected isolated Discord call: ${url}`);
        }) as typeof fetch;
        const app = createTestRuntimeApp({
          discordPublicKey: "a".repeat(64),
          discordBotToken: `matrix-${persona}-${enabled}`,
          customerAuth: createCustomerAuthMock({ organizations: [] }),
          stores,
          guildResources: createPermissiveGuildResourceValidator(),
          gateway: { status: async () => ({ status: "ready" }) } as unknown as GatewayController,
        });
        const request = (path: string, body?: object) =>
          app.fetch(
            new Request(
              `https://runtime.example/admin/api/${path}`,
              body
                ? {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(body),
                  }
                : undefined,
            ),
          );
        const featureAllowed =
          persona === "owner" ||
          persona === "administrator" ||
          persona === "nominated" ||
          (persona === "manager" && enabled);
        assert.equal(
          (await request("blocklist?guildId=guild-1")).status,
          featureAllowed ? 200 : 403,
          `${persona}/${enabled}: feature access`,
        );
        assert.equal(
          (await request("guild-rbac/admin-role", { guildId: "guild-1", adminRoleId: null }))
            .status,
          persona === "owner" || persona === "administrator" ? 200 : 403,
          `${persona}/${enabled}: delegation`,
        );
        assert.equal(
          (
            await request("guild-rbac/admin-role", {
              guildId: "guild-1",
              manageServerAdminEnabled: !enabled,
            })
          ).status,
          persona === "owner" ? 200 : 403,
          `${persona}/${enabled}: owner policy`,
        );
        assert.equal(
          await stores.guildRbac.readManageServerAdminEnabled("guild-1"),
          persona === "owner" ? !enabled : enabled,
        );
        assert.equal(await stores.guildRbac.readManageServerAdminEnabled("guild-2"), true);
        assert.equal(
          (
            await request("guild-rbac/admin-role", {
              guildId: "guild-2",
              manageServerAdminEnabled: false,
            })
          ).status,
          403,
          "cross-guild access",
        );
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
