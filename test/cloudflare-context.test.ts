import type { Cache } from "../src/runtime/discord-json-cache";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { createSqliteContext } from "./support/sqlite/runtime/sqlite-context";
import { createSqliteGuildR2ObjectStore } from "./support/sqlite/runtime/sqlite-guild-r2-object-store";
import type { Env } from "./support/test-env";
import { SqliteD1Database } from "./support/sqlite-d1-database";

function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    DISCORD_BOT_TOKEN: "bot-token",
    BOT_USER_ID: "bot-user-id",
    DISCORD_PUBLIC_KEY: "9113b842d4ade29e412959490d5a7dff2e74c41b12500c73612285bf4ca0e6b5",
    DISCORD_APPLICATION_ID: "app-id",
    GATEWAY_SESSION_DO: {
      get: () => ({ fetch: () => Promise.resolve(new Response()) }) as any,
      idFromName: () => ({}) as any,
    } as any,
    GATEWAY_EVENT_QUEUE: { send: async () => undefined } as any,
    WEBHOOK_PROXY_DELIVERY_QUEUE: { send: async () => undefined } as any,
    HAF_DB: createNoopD1Database(),
    COMPONENT_ID_SIGNING_SECRET: "component-id-signing-secret-for-production-tests",
    ...overrides,
  } as Env;
}

function createNoopD1Database(): D1Database {
  return {
    exec: async () => ({ count: 0, duration: 0 }),
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      }),
    }),
    batch: async () => [],
  } as unknown as D1Database;
}

test("createSqliteContext reuses customer auth for matching auth configuration", () => {
  const env = createMockEnv({
    HAF_DB: {} as D1Database,
    BETTER_AUTH_SECRET: "c9a7Jd8Nq2vR5xT1mP0sL6wY3eK4hB7z",
    BETTER_AUTH_URL: "https://worker.example",
    DISCORD_OAUTH_CLIENT_ID: "discord-client-id",
    DISCORD_OAUTH_CLIENT_SECRET: "discord-client-secret",
  });

  const firstContext = createSqliteContext(env);
  const secondContext = createSqliteContext(env);

  assert.ok(firstContext.customerAuth);
  assert.strictEqual(firstContext.customerAuth, secondContext.customerAuth);
});

test("createSqliteContext exposes grouped stores by bounded context", () => {
  const env = createMockEnv();
  const context = createSqliteContext(env);

  assert.strictEqual(context.database.binding, env.HAF_DB);
  assert.ok(context.database.drizzle);
  assert.ok(context.stores, "context.stores should be defined");
  assert.ok(context.stores.blocklist, "context.stores.blocklist should be defined");
  assert.ok(context.stores.appConfig, "context.stores.appConfig should be defined");
  assert.ok(context.stores.timedRoles, "context.stores.timedRoles should be defined");
  assert.ok(context.stores.tickets, "context.stores.tickets should be defined");
  assert.ok(context.stores.webhookProxy, "context.stores.webhookProxy should be defined");
  assert.ok(context.stores.guildEntitlements, "context.stores.guildEntitlements should be defined");
  assert.ok(context.stores.guildR2Objects, "context.stores.guildR2Objects should be defined");
  assert.ok(context.discordAccounts, "context.discordAccounts should be defined");

  assert.strictEqual(typeof context.stores.blocklist.readConfig, "function");
  assert.strictEqual(typeof context.stores.blocklist.applyGuildEmojiMutation, "function");
  assert.strictEqual(typeof context.stores.appConfig.upsertAppConfig, "function");
  assert.strictEqual(typeof context.stores.timedRoles.listTimedRoles, "function");
  assert.strictEqual(typeof context.stores.timedRoles.listTimedRolesByGuild, "function");
  assert.strictEqual(typeof context.stores.timedRoles.upsertTimedRole, "function");
  assert.strictEqual(typeof context.stores.timedRoles.deleteTimedRole, "function");
  assert.strictEqual(typeof context.stores.timedRoles.readNewMemberTimedRoleConfig, "function");
  assert.strictEqual(typeof context.stores.timedRoles.upsertNewMemberTimedRoleConfig, "function");
  assert.strictEqual(
    typeof context.stores.timedRoles.readManualAssignmentTimedRoleConfig,
    "function",
  );
  assert.strictEqual(
    typeof context.stores.timedRoles.upsertManualAssignmentTimedRoleConfig,
    "function",
  );
  assert.strictEqual(typeof context.stores.tickets.reserveNextTicketNumber, "function");
  assert.strictEqual(typeof context.stores.tickets.readTicketPanelConfig, "function");
  assert.strictEqual(typeof context.stores.tickets.upsertTicketPanelConfig, "function");
  assert.strictEqual(typeof context.stores.tickets.createTicketInstance, "function");
  assert.strictEqual(typeof context.stores.tickets.deleteTicketInstance, "function");
  assert.strictEqual(typeof context.stores.tickets.readOpenTicketByChannel, "function");
  assert.strictEqual(typeof context.stores.tickets.listClosedTicketInstances, "function");
  assert.strictEqual(typeof context.stores.tickets.closeTicketInstance, "function");
  assert.strictEqual(typeof context.stores.webhookProxy.readWebhookProxyConfig, "function");
  assert.strictEqual(typeof context.stores.webhookProxy.listWebhookProxyConfigs, "function");
  assert.strictEqual(typeof context.stores.webhookProxy.upsertWebhookProxyConfig, "function");
  assert.strictEqual(typeof context.stores.webhookProxy.deleteWebhookProxyConfig, "function");
  assert.strictEqual(typeof context.stores.guildEntitlements.readGuildEntitlement, "function");
  assert.strictEqual(typeof context.stores.guildR2Objects.upsertObject, "function");
  assert.strictEqual(typeof context.stores.guildR2Objects.deleteObject, "function");
  assert.strictEqual(typeof context.stores.guildR2Objects.getGuildUsageBytes, "function");
  assert.strictEqual(typeof context.discordAccounts.readDiscordAccessToken, "function");
});

test("public Billing starts with only the current plan prices", async () => {
  const context = createSqliteContext(
    createMockEnv({
      BILLING_SYNC_QUEUE: { send: async () => undefined } as unknown as Queue<unknown>,
      STRIPE_SECRET_KEY: "sk_test_public_billing_key_material",
      STRIPE_WEBHOOK_SECRET: "whsec_public_billing_key_material",
      STRIPE_API_VERSION: "2026-06-24.dahlia",
      STRIPE_PORTAL_CONFIGURATION_ID: "bpc_public",
      BETTER_AUTH_URL: "https://public.example.test",
      STRIPE_PREMIUM_MONTHLY_PRICE_ID: "price_pm",
      STRIPE_PREMIUM_YEARLY_PRICE_ID: "price_py",
      STRIPE_PREMIUM_PRODUCT_ID: "prod_p",
      STRIPE_PREMIUM_PLUS_MONTHLY_PRICE_ID: "price_ppm",
      STRIPE_PREMIUM_PLUS_YEARLY_PRICE_ID: "price_ppy",
      STRIPE_PREMIUM_PLUS_PRODUCT_ID: "prod_pp",
    }),
  );
  assert.ok(context.billingCheckoutService);
  assert.deepEqual(
    (await context.billingCheckoutService.listCatalog()).map(({ priceId }) => priceId),
    ["price_pm", "price_py", "price_ppm", "price_ppy"],
  );
});

test("createSqliteContext wires Commerce only with its dedicated webhook secret and Queue", () => {
  const queue = { send: async () => undefined } as unknown as Queue<unknown>;
  const configured = createSqliteContext(
    createMockEnv({
      COMMERCE_SYNC_QUEUE: queue,
      COMMERCE_ROLE_QUEUE: queue,
      STAGING_MODE: "true",
      STRIPE_SECRET_KEY: "sk_test_platform_key_material",
      STRIPE_API_VERSION: "2026-06-24.dahlia",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_key_material",
    }),
  );
  assert.equal(typeof configured.commerceWebhookHandler, "function");
  assert.equal(typeof configured.sweepCommerceSyncOutbox, "function");
  assert.equal(typeof configured.scheduleCommerceReconciliation, "function");
  assert.equal(typeof configured.sweepCommerceRoleOutbox, "function");
  assert.equal(typeof configured.reconcileCommerceRoles, "function");

  const billingSecretOnly = createSqliteContext(
    createMockEnv({
      COMMERCE_SYNC_QUEUE: queue,
      STAGING_MODE: "true",
      STRIPE_SECRET_KEY: "sk_test_platform_key_material",
      STRIPE_API_VERSION: "2026-06-24.dahlia",
      STRIPE_WEBHOOK_SECRET: "whsec_premium",
    }),
  );
  assert.equal(billingSecretOnly.commerceWebhookHandler, undefined);
});

test("createSqliteContext fails closed for malformed Commerce Stripe secrets", () => {
  const queue = { send: async () => undefined } as unknown as Queue<unknown>;
  const context = createSqliteContext(
    createMockEnv({
      COMMERCE_ENABLED: "true",
      COMMERCE_SUPPORT_PAYMENTS_ENABLED: "true",
      COMMERCE_SYNC_QUEUE: queue,
      COMMERCE_ROLE_QUEUE: queue,
      STAGING_MODE: "true",
      STRIPE_SECRET_KEY: "sk_test_short",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_key_material",
      STRIPE_API_VERSION: "2026-06-24.dahlia",
    }),
  );
  assert.equal(context.commerceWebhookHandler, undefined);
  assert.equal(context.commerceAdmin, undefined);
  assert.equal(context.commerceBuyerCheckoutService, undefined);
  assert.equal(context.commerceSupportService, undefined);
});

test("createSqliteContext fails fast when HAF_DB is missing", () => {
  const env = createMockEnv({ HAF_DB: undefined });
  assert.throws(() => createSqliteContext(env), /HAF_DB binding is required/);
});

test("createSqliteContext fails closed when production component signing is missing", () => {
  const env = createMockEnv({ COMPONENT_ID_SIGNING_SECRET: undefined });
  assert.throws(() => createSqliteContext(env), /COMPONENT_ID_SIGNING_SECRET/);
});

test("createSqliteContext passes through DISCORD_SUPPORT_INVITE", () => {
  const env = createMockEnv({
    DISCORD_SUPPORT_INVITE: "https://discord.gg/HpRPkdm6dv",
  });

  const context = createSqliteContext(env);

  assert.strictEqual(context.discordSupportInvite, "https://discord.gg/HpRPkdm6dv");
});

test("createSqliteContext passes through optional Discord cache KV binding", () => {
  const discordCache = {} as Cache<string>;
  const env = createMockEnv({
    discordCache: discordCache,
  });

  const context = createSqliteContext(env);

  assert.strictEqual(context.discordCache, discordCache);
});

test("createSqliteContext exposes image rules classifier env when configured", () => {
  const env = createMockEnv({
    IMAGE_RULES_API_BASE_URL: "https://api.example.com",
    IMAGE_RULES_API_KEY: "secret-key",
    IMAGE_RULES_MODEL: "gpt-4o",
    IMAGE_RULES_MAX_IMAGE_BYTES: "20971520",
    IMAGE_RULES_MAX_IMAGE_DIMENSION: "4096",
    IMAGE_RULES_TIMEOUT_MS: "5000",
    IMAGE_RULES_MAX_RETRIES: "1",
  });

  const context = createSqliteContext(env);

  assert.ok(context.imageRulesClassifierEnv);
  assert.equal(context.imageRulesClassifierEnv.apiBaseUrl, "https://api.example.com");
  assert.equal(context.imageRulesClassifierEnv.apiKey, "secret-key");
  assert.equal(context.imageRulesClassifierEnv.model, "gpt-4o");
  assert.equal(context.imageRulesClassifierEnv.maxImageBytes, 20_971_520);
  assert.equal(context.imageRulesClassifierEnv.maxImageDimension, 4096);
  assert.equal(context.imageRulesClassifierEnv.timeoutMs, 5000);
  assert.equal(context.imageRulesClassifierEnv.maxRetries, 1);
});

test("createSqliteContext omits image rules classifier env when base URL is missing", () => {
  const env = createMockEnv({
    IMAGE_RULES_API_BASE_URL: undefined,
    IMAGE_RULES_API_KEY: "secret-key",
  });

  const context = createSqliteContext(env);

  assert.equal(context.imageRulesClassifierEnv, undefined);
});

test("createSqliteContext passes through optional webhook proxy delivery queue binding", () => {
  const webhookProxyDeliveryQueue = { send: async () => undefined } as unknown as Queue<unknown>;
  const env = createMockEnv({
    WEBHOOK_PROXY_DELIVERY_QUEUE: webhookProxyDeliveryQueue,
  });

  const context = createSqliteContext(env);

  assert.strictEqual(context.webhookProxyDeliveryQueue, webhookProxyDeliveryQueue);
});

test("createSqliteContext omits discordSupportInvite when env var is missing", () => {
  const env = createMockEnv({
    DISCORD_SUPPORT_INVITE: undefined,
  });

  const context = createSqliteContext(env);

  assert.strictEqual(context.discordSupportInvite, undefined);
});

test("createSqliteContext wires ticket transcript R2 helpers when a bucket is configured", async () => {
  const bucketCalls: Array<{ action: string; key: string; body?: unknown; contentType?: string }> =
    [];
  const env = createMockEnv({
    HAF_DB: new SqliteD1Database() as unknown as D1Database,
    TICKET_TRANSCRIPTS_BUCKET: {
      async put(
        key: string,
        value: unknown,
        options?: { httpMetadata?: { contentType?: string } },
      ) {
        bucketCalls.push({
          action: "put",
          key,
          body: value,
          contentType: options?.httpMetadata?.contentType,
        });
        return {
          key,
          size: typeof value === "string" ? new TextEncoder().encode(value).byteLength : 0,
        } as R2Object;
      },
      async get(key: string) {
        bucketCalls.push({ action: "get", key });
        if (key.endsWith("/proof.png")) {
          return {
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("image-bytes"));
                controller.close();
              },
            }),
            httpMetadata: { contentType: "image/png" },
          } as unknown as R2ObjectBody;
        }

        return {
          text: async () => "<html>stored transcript</html>",
        } as unknown as R2ObjectBody;
      },
    } as unknown as R2Bucket,
  });

  const context = createSqliteContext(env);

  await context.ticketTranscriptBlobs?.putHtml(
    "guild-1/channel-1.html",
    "<html>stored transcript</html>",
  );
  const html = await context.ticketTranscriptBlobs?.getHtml("guild-1/channel-1.html");
  await context.ticketTranscriptBlobs?.putAttachment(
    "guild-1/channel-1/attachments/attachment-1/proof.png",
    "image-bytes",
    {
      contentType: "image/png",
    },
  );
  const attachment = await context.ticketTranscriptBlobs?.getAttachment(
    "guild-1/channel-1/attachments/attachment-1/proof.png",
  );

  assert.equal(html, "<html>stored transcript</html>");
  assert.equal(attachment?.contentType, "image/png");
  assert.equal(await new Response(attachment?.body).text(), "image-bytes");
  assert.deepEqual(bucketCalls, [
    {
      action: "put",
      key: "guild-1/channel-1.html",
      body: "<html>stored transcript</html>",
      contentType: "text/html; charset=utf-8",
    },
    {
      action: "get",
      key: "guild-1/channel-1.html",
    },
    {
      action: "put",
      key: "guild-1/channel-1/attachments/attachment-1/proof.png",
      body: "image-bytes",
      contentType: "image/png",
    },
    {
      action: "get",
      key: "guild-1/channel-1/attachments/attachment-1/proof.png",
    },
  ]);
});

test("createSqliteContext isolates Managed Media and rejects unclassified objects regardless of age", async () => {
  const database = new SqliteD1Database();
  const objects = new Map<
    string,
    {
      body: ArrayBuffer;
      contentType: string;
      customMetadata?: Record<string, string>;
      uploaded?: Date;
    }
  >();
  const bucketReads: string[] = [];
  const bucket = {
    async put(
      key: string,
      value: ArrayBuffer,
      options?: {
        httpMetadata?: { contentType?: string };
        customMetadata?: Record<string, string>;
      },
    ) {
      objects.set(key, {
        body: value,
        contentType: options?.httpMetadata?.contentType ?? "application/octet-stream",
        customMetadata: options?.customMetadata,
      });
      return { key, size: value.byteLength } as R2Object;
    },
    async get(key: string) {
      bucketReads.push(key);
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: new Response(object.body).body!,
        httpMetadata: { contentType: object.contentType },
        customMetadata: object.customMetadata,
        uploaded: object.uploaded ?? new Date("2026-07-30T00:00:00Z"),
      } as unknown as R2ObjectBody;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  } as unknown as R2Bucket;
  const context = createSqliteContext(
    createMockEnv({
      HAF_DB: database as unknown as D1Database,
      TICKET_TRANSCRIPTS_BUCKET: bucket,
    }),
  );
  assert.ok(context.publicManagedMedia);
  assert.ok(context.evidenceVaultBlobs);
  const filename = "11111111-1111-4111-8111-111111111111.png";
  const key = `guild-1/managed-media/${filename}`;

  await context.publicManagedMedia.putImage({
    guildId: "guild-1",
    filename,
    body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer,
    contentType: "image/png",
    sizeBytes: 4,
  });

  assert.deepEqual(objects.get(key)?.customMetadata, {
    visibility: "public",
    contentClass: "managed-message-media",
  });
  assert.equal(
    (await context.publicManagedMedia.getImage({ guildId: "guild-1", filename }))?.contentType,
    "image/png",
  );

  await context.evidenceVaultBlobs.putImage(key, new ArrayBuffer(1), {
    contentType: "image/png",
    sizeBytes: 1,
  });
  assert.equal(await context.publicManagedMedia.getImage({ guildId: "guild-1", filename }), null);

  objects.set(key, {
    body: new ArrayBuffer(1),
    contentType: "image/png",
    uploaded: new Date("2026-08-14T23:59:59.999Z"),
  });
  assert.equal(await context.publicManagedMedia.getImage({ guildId: "guild-1", filename }), null);

  objects.set(key, {
    body: new ArrayBuffer(1),
    contentType: "image/png",
    uploaded: new Date("2026-08-15T00:00:00Z"),
  });
  assert.equal(await context.publicManagedMedia.getImage({ guildId: "guild-1", filename }), null);

  objects.set(key, {
    body: new ArrayBuffer(1),
    contentType: "image/png",
    uploaded: new Date("2026-08-15T00:00:00.001Z"),
  });
  assert.equal(await context.publicManagedMedia.getImage({ guildId: "guild-1", filename }), null);

  const readsBeforeInvalidPath = bucketReads.length;
  await assert.rejects(
    context.publicManagedMedia.getImage({ guildId: "../private", filename: "transcript.html" }),
    /Invalid managed image path/,
  );
  assert.equal(bucketReads.length, readsBeforeInvalidPath);

  await context.publicManagedMedia.deleteImage({ guildId: "guild-1", filename });
  assert.equal(objects.has(key), false);
});

test("createSqliteContext enforces R2 quota before transcript blob writes", async () => {
  const bucketCalls: Array<{ action: string; key: string }> = [];
  const database = new SqliteD1Database();
  await createSqliteGuildR2ObjectStore(database as unknown as D1Database).upsertObject({
    guildId: "guild-1",
    key: "guild-1/existing.bin",
    sizeBytes: 100 * 1024 * 1024 - 2,
    createdAtMs: 1,
  });
  const env = createMockEnv({
    HAF_DB: database as unknown as D1Database,
    TICKET_TRANSCRIPTS_BUCKET: {
      async put(key: string, value: unknown) {
        bucketCalls.push({ action: "put", key });
        return {
          key,
          size: typeof value === "string" ? new TextEncoder().encode(value).byteLength : 0,
        } as R2Object;
      },
    } as unknown as R2Bucket,
  });

  const context = createSqliteContext(env);
  assert.ok(context.ticketTranscriptBlobs);

  await context.ticketTranscriptBlobs.putHtml("guild-1/channel-1.html", "ab");
  await assert.rejects(
    context.ticketTranscriptBlobs.putAttachment(
      "guild-1/channel-1/attachments/attachment-1/proof.txt",
      "abc",
      { contentType: "text/plain" },
    ),
    /R2 storage quota exceeded/,
  );

  assert.deepEqual(bucketCalls, [{ action: "put", key: "guild-1/channel-1.html" }]);
});
