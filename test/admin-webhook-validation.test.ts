/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";
import type { z } from "zod";
import { createAdminApiHandler } from "./helpers/admin-api";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";
import { createWebhookCredentialKeyRing } from "../src/security/webhook-credentials";
import {
  WebhookCredentialService,
  type StoredWebhookCredential,
  type WebhookCredentialStore,
} from "../src/security/webhook-credentials/store";
import type { RuntimeStores } from "../src/runtime/app-types";
import type { WebhookProxyConfig } from "../src/types";
import { webhookProxyConfigBodySchema } from "../src/contracts/admin/webhook-proxy";

const GUILD_ID = "1483606177261551777";
const SAVE_URL = "https://runtime.example/admin/api/webhook-proxy/config";

type WebhookProxySaveBody = z.input<typeof webhookProxyConfigBodySchema>;

function createWebhookProxySaveBody(): WebhookProxySaveBody {
  return {
    guildId: GUILD_ID,
    publicId: "",
    name: "Alerts",
    enabled: true,
    destinations: [
      {
        id: "main",
        label: "Main",
        credential: {
          action: "replace",
          url: "https://discord.com/api/webhooks/900000/c03-secret-token",
        },
      },
    ],
    defaultDestinationIds: ["main"],
    routingRules: [],
  };
}

function createTrackingCredentialService() {
  const credentials = new Map<string, StoredWebhookCredential>();
  const writes: string[] = [];
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
      writes.push(`upsert:${credential.credentialId}`);
      credentials.set(credential.credentialId, credential);
    },
    async delete(credentialId) {
      writes.push(`delete:${credentialId}`);
      credentials.delete(credentialId);
    },
  };
  return {
    writes,
    service: new WebhookCredentialService(
      store,
      createWebhookCredentialKeyRing({ keyV1: Buffer.alloc(32, 7).toString("base64") }),
    ),
  };
}

function createPremiumStores(): { stores: RuntimeStores; close: () => void } {
  const fixture = createProductionRuntimeStores();
  return {
    stores: {
      ...fixture.stores,
      guildEntitlements: {
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium" as const, updatedAtMs: 0 };
        },
      },
    },
    close: () => fixture.close(),
  };
}

async function postSave(
  handler: ReturnType<typeof createAdminApiHandler>,
  body: WebhookProxySaveBody,
): Promise<Response> {
  const response = await handler(
    new Request(SAVE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    new URL(SAVE_URL),
  );
  assert.ok(response, "expected the admin route to handle the Webhook Proxy save");
  return response;
}

test("Webhook Proxy save rejects invalid IDs, URLs, regexes, flags and references before writes", async (t) => {
  const { stores, close } = createPremiumStores();
  t.after(close);
  const credentials = createTrackingCredentialService();
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "test-bot-token",
    webhookCredentialService: credentials.service,
  });

  const invalidCases: Array<{
    name: string;
    mutate: (body: WebhookProxySaveBody) => void;
    field: string;
    message: string;
  }> = [
    {
      name: "blank configuration name",
      mutate: (body) => {
        body.name = " \t ";
      },
      field: "name",
      message: "Missing name",
    },
    {
      name: "blank destination label",
      mutate: (body) => {
        body.destinations[0]!.label = " \t ";
      },
      field: "destinations.0.label",
      message: "Missing label",
    },
    {
      name: "blank routing label",
      mutate: (body) => {
        body.routingRules = [
          { id: "errors", label: " \t ", pattern: "error", destinationIds: ["main"] },
        ];
      },
      field: "routingRules.0.label",
      message: "Missing label",
    },
    {
      name: "blank replacement label",
      mutate: (body) => {
        body.contentReplacements = [
          { id: "clean", label: " \t ", pattern: "error", replacement: "warning" },
        ];
      },
      field: "contentReplacements.0.label",
      message: "Missing label",
    },
    {
      name: "invalid public ID",
      mutate: (body) => {
        body.publicId = "bad id";
      },
      field: "publicId",
      message: "Invalid publicId",
    },
    {
      name: "invalid destination ID",
      mutate: (body) => {
        body.destinations[0]!.id = "bad id";
        body.defaultDestinationIds = ["bad id"];
      },
      field: "destinations.0.id",
      message: "Invalid id",
    },
    {
      name: "invalid default destination ID",
      mutate: (body) => {
        body.defaultDestinationIds = ["bad id"];
      },
      field: "defaultDestinationIds.0",
      message: "Invalid id",
    },
    {
      name: "invalid credential ID",
      mutate: (body) => {
        body.destinations[0]!.credential = {
          action: "preserve",
          credentialId: "not-a-uuid",
        };
      },
      field: "destinations.0.credential.credentialId",
      message: "Invalid UUID",
    },
    {
      name: "invalid webhook URL host",
      mutate: (body) => {
        body.destinations[0]!.credential = {
          action: "replace",
          url: "https://example.com/api/webhooks/123456/c03-secret-token",
        };
      },
      field: "destinations.0.credential.url",
      message: "Invalid Discord webhook URL",
    },
    {
      name: "non-https webhook URL",
      mutate: (body) => {
        body.destinations[0]!.credential = {
          action: "replace",
          url: "http://discord.com/api/webhooks/123456/c03-secret-token",
        };
      },
      field: "destinations.0.credential.url",
      message: "Invalid Discord webhook URL",
    },
    {
      name: "invalid routing regex",
      mutate: (body) => {
        body.routingRules = [
          {
            id: "errors",
            label: "Errors",
            pattern: "(",
            flags: "i",
            destinationIds: ["main"],
          },
        ];
      },
      field: "routingRules.0.pattern",
      message: "Invalid or unsafe regex",
    },
    {
      name: "invalid routing flags",
      mutate: (body) => {
        body.routingRules = [
          {
            id: "errors",
            label: "Errors",
            pattern: "error",
            flags: "ii",
            destinationIds: ["main"],
          },
        ];
      },
      field: "routingRules.0.flags",
      message: "Invalid flags",
    },
    {
      name: "routing pattern incompatible with Unicode flags",
      mutate: (body) => {
        body.routingRules = [
          { id: "unicode", label: "Unicode", pattern: "\\q", flags: "u", destinationIds: ["main"] },
        ];
      },
      field: "routingRules.0.pattern",
      message: "Invalid regex for the selected flags",
    },
    {
      name: "invalid replacement regex",
      mutate: (body) => {
        body.contentReplacements = [
          { id: "broken", label: "Broken", pattern: "(", flags: "g", replacement: "value" },
        ];
      },
      field: "contentReplacements.0.pattern",
      message: "Invalid or unsafe regex",
    },
    {
      name: "invalid replacement flags",
      mutate: (body) => {
        body.contentReplacements = [
          {
            id: "duplicate-flags",
            label: "Duplicate flags",
            pattern: "value",
            flags: "gg",
            replacement: "replacement",
          },
        ];
      },
      field: "contentReplacements.0.flags",
      message: "Invalid flags",
    },
    {
      name: "replacement pattern incompatible with Unicode flags",
      mutate: (body) => {
        body.contentReplacements = [
          { id: "unicode", label: "Unicode", pattern: "\\q", flags: "u", replacement: "value" },
        ];
      },
      field: "contentReplacements.0.pattern",
      message: "Invalid regex for the selected flags",
    },
    {
      name: "duplicate destination",
      mutate: (body) => {
        body.destinations.push({ ...body.destinations[0]!, label: "Duplicate" });
      },
      field: "destinations.1.id",
      message: "Duplicate destinations entry",
    },
    {
      name: "duplicate default destination",
      mutate: (body) => {
        body.defaultDestinationIds = ["main", "main"];
      },
      field: "defaultDestinationIds.1",
      message: "Duplicate destinations entry",
    },
    {
      name: "dangling default destination",
      mutate: (body) => {
        body.defaultDestinationIds = ["missing"];
      },
      field: "defaultDestinationIds.0",
      message: "Unknown destinations entry",
    },
    {
      name: "dangling routing destination",
      mutate: (body) => {
        body.routingRules = [
          {
            id: "errors",
            label: "Errors",
            pattern: "error",
            destinationIds: ["missing"],
          },
        ];
      },
      field: "routingRules.0.destinationIds.0",
      message: "Unknown destinations entry",
    },
    {
      name: "duplicate routing destination",
      mutate: (body) => {
        body.routingRules = [
          {
            id: "errors",
            label: "Errors",
            pattern: "error",
            destinationIds: ["main", "main"],
          },
        ];
      },
      field: "routingRules.0.destinationIds.1",
      message: "Duplicate destinations entry",
    },
    {
      name: "duplicate routing rule",
      mutate: (body) => {
        body.routingRules = [
          { id: "errors", label: "Errors", pattern: "error", destinationIds: ["main"] },
          { id: "errors", label: "Errors again", pattern: "warn", destinationIds: ["main"] },
        ];
      },
      field: "routingRules.1.id",
      message: "Duplicate routingRules entry",
    },
    {
      name: "duplicate content replacement",
      mutate: (body) => {
        body.contentReplacements = [
          {
            id: "cftools",
            label: "CFTools",
            pattern: "7656119\\d{10}",
            replacement: "$1",
          },
          {
            id: "cftools",
            label: "CFTools duplicate",
            pattern: "7656119\\d{10}",
            replacement: "$1",
          },
        ];
      },
      field: "contentReplacements.1.id",
      message: "Duplicate contentReplacements entry",
    },
  ];

  for (const invalid of invalidCases) {
    const body = createWebhookProxySaveBody();
    invalid.mutate(body);
    const response = await postSave(handler, body);
    const payload = (await response.json()) as {
      code?: string;
      action?: string;
      correlationId?: string;
      retryable?: boolean;
      fieldIssues?: Array<{ path: string; code: string; message: string }>;
      issues?: unknown;
    };

    assert.equal(response.status, 400, `${invalid.name}: ${JSON.stringify(payload)}`);
    assert.equal(payload.code, "invalid_request", invalid.name);
    assert.equal(payload.action, "fix_fields", invalid.name);
    assert.equal(payload.retryable, false, invalid.name);
    assert.match(payload.correlationId ?? "", /^[^ ]+$/, invalid.name);
    assert.equal(payload.issues, undefined, `${invalid.name} used the retired issues alias`);
    assert.ok(
      payload.fieldIssues?.some(
        (issue) => issue.path === invalid.field && issue.message === invalid.message,
      ),
      `${invalid.name}: expected ${invalid.field} (${invalid.message}), got ${JSON.stringify(payload.fieldIssues)}`,
    );
    assert.deepEqual(credentials.writes, [], `${invalid.name} wrote a credential`);
    assert.deepEqual(
      await stores.webhookProxy.listWebhookProxyConfigs(GUILD_ID),
      [],
      `${invalid.name} wrote a configuration`,
    );
  }

  assert.equal(credentials.writes.length, 0);
});

test("Webhook Proxy save applies shared defaults and keeps replace URLs transient", async (t) => {
  const { stores, close } = createPremiumStores();
  t.after(close);
  const credentials = createTrackingCredentialService();
  const handler = createAdminApiHandler({
    stores,
    discordBotToken: "test-bot-token",
    webhookCredentialService: credentials.service,
  });
  const body = createWebhookProxySaveBody();
  body.name = "  Alerts  ";
  body.routingRules = [
    { id: "errors", label: "Errors", pattern: "error", destinationIds: ["main"] },
  ];
  body.contentReplacements = [
    {
      id: "profile",
      label: "Profile",
      pattern: "7656119\\d{10}",
      flags: "g",
      replacement: "profile",
    },
  ];

  const response = await postSave(handler, body);

  assert.equal(response.status, 200);
  const saved = (await response.json()) as { ok: boolean; publicId: string };
  assert.equal(saved.ok, true);
  assert.match(saved.publicId, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(credentials.writes.length, 1);
  assert.match(credentials.writes[0]!, /^upsert:/);

  const config = await stores.webhookProxy.readWebhookProxyConfig(saved.publicId);
  assert.ok(config, "expected the saved configuration to be readable");
  assert.equal(config.name, "Alerts");
  assert.equal(config.banLookupEnabled, false);
  assert.equal(config.banLookupCredentialId, null);
  assert.deepEqual(config.banLookupAppIds, []);
  assert.match(
    config.destinations[0]!.credentialId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.deepEqual(config.defaultDestinationIds, ["main"]);
  assert.deepEqual(config.routingRules, [
    { id: "errors", label: "Errors", pattern: "error", flags: "", destinationIds: ["main"] },
  ]);
  assert.deepEqual(config.contentReplacements, [
    {
      id: "profile",
      label: "Profile",
      pattern: "7656119\\d{10}",
      flags: "g",
      replacement: "profile",
    },
  ]);
  assert.equal(
    JSON.stringify(config).includes("c03-secret-token"),
    false,
    "the replaced URL must not be stored on the configuration",
  );

  const preservedCredentialId = config.destinations[0]!.credentialId;
  const preserveResponse = await postSave(handler, {
    ...createWebhookProxySaveBody(),
    publicId: saved.publicId,
    name: "Renamed",
    destinations: [
      {
        id: "main",
        label: "Main",
        credential: { action: "preserve", credentialId: preservedCredentialId },
      },
    ],
  });

  assert.equal(preserveResponse.status, 200);
  assert.equal(credentials.writes.length, 1, "preserving a reference must not write credentials");
  const renamed = await stores.webhookProxy.readWebhookProxyConfig(saved.publicId);
  assert.ok(renamed);
  assert.equal(renamed.name, "Renamed");
  assert.equal(renamed.destinations[0]!.credentialId, preservedCredentialId);

  const savedConfigs: WebhookProxyConfig[] =
    await stores.webhookProxy.listWebhookProxyConfigs(GUILD_ID);
  assert.equal(savedConfigs.length, 1);
});
