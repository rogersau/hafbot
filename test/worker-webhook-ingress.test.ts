/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import worker from "../src/index";
import type { Env } from "../src/env";

test("worker.fetch keeps a warmed valid webhook outside request-scoped invalid admission", async () => {
  const publicId = "worker_cache_webhook_1234";
  let rejectInvalidAdmission = false;
  let configReads = 0;
  const queued: unknown[] = [];
  const database = createWebhookDatabase(publicId, () => {
    configReads += 1;
  });
  const env = {
    DISCORD_BOT_TOKEN: "bot-token",
    BOT_USER_ID: "bot-user-id",
    DISCORD_PUBLIC_KEY: "a".repeat(64),
    COMPONENT_ID_SIGNING_SECRET: "component-id-signing-secret-for-production-tests",
    HAF_DB: database,
    GATEWAY_SESSION_DO: {} as DurableObjectNamespace,
    GATEWAY_EVENT_QUEUE: { send: async () => undefined } as unknown as Queue<unknown>,
    WEBHOOK_PROXY_DELIVERY_QUEUE: {
      async send(message: unknown) {
        queued.push(message);
      },
    } as unknown as Queue<unknown>,
    WEBHOOK_INGRESS_GUARD_DO: {
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
    } as unknown as Env["WEBHOOK_INGRESS_GUARD_DO"],
  } as Env;
  const fetchWebhook = (candidate: string) =>
    worker.fetch(
      new Request(`https://worker.example/webhooks/${candidate}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );

  assert.equal((await fetchWebhook(publicId)).status, 204);
  rejectInvalidAdmission = true;
  const unknown = await fetchWebhook("unknown_worker_webhook_1234");
  const known = await fetchWebhook(publicId);

  assert.equal(unknown.status, 429);
  assert.equal(unknown.headers.get("retry-after"), "60");
  assert.equal(known.status, 204);
  assert.equal(configReads, 1);
  assert.equal(queued.length, 2);
});

function createWebhookDatabase(publicId: string, onConfigRead: () => void): D1Database {
  return {
    prepare(query: string) {
      let bindings: unknown[] = [];
      const rows = () => {
        if (query.includes("webhook_proxy_configs")) {
          onConfigRead();
          return bindings[0] === publicId
            ? [
                {
                  guild_id: "guild-worker-cache",
                  public_id: publicId,
                  name: "Worker cache",
                  enabled: 1,
                  destinations_json: JSON.stringify([
                    {
                      id: "main",
                      label: "Main",
                      url: "https://discord.com/api/webhooks/1/main",
                    },
                  ]),
                  default_destination_ids_json: '["main"]',
                  routing_rules_json: "[]",
                  content_replacements_json: "[]",
                  ban_lookup_enabled: 0,
                  ban_lookup_notification_url: null,
                  ban_lookup_app_ids_json: "[]",
                  destinations_v2_json: null,
                  ban_lookup_credential_id: null,
                  credential_migrated_at_ms: null,
                  created_at_ms: 1,
                  updated_at_ms: 1,
                },
              ]
            : [];
        }
        if (query.includes("guild_entitlements")) {
          return [
            {
              guild_id: "guild-worker-cache",
              tier: "premium",
              plan: "premium",
              updated_at_ms: 1,
            },
          ];
        }
        return [];
      };
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async all() {
          return { results: rows(), success: true, meta: {} as D1Meta };
        },
        async first() {
          return rows()[0] ?? null;
        },
        async raw() {
          return rows().map((row) => Object.values(row));
        },
        async run() {
          return { success: true, meta: {} as D1Meta };
        },
      } as unknown as D1PreparedStatement;
    },
    async exec() {
      return {} as D1ExecResult;
    },
    async batch() {
      return [];
    },
    async dump() {
      return new ArrayBuffer(0);
    },
    withSession() {
      return this;
    },
  } as unknown as D1Database;
}
