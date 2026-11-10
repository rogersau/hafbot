/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createPublicRoutes } from "../src/routes/public-routes";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import { createCloudflareTicketTranscriptCapabilityStore } from "../src/runtime/cloudflare-ticket-transcript-capability-store";
import type { WebhookIngressGuardDO } from "../src/durable-objects/webhook-ingress-guard";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("public routes serve the customer changelog application", async () => {
  const routes = createPublicRoutes({ features: ALL_FEATURES_ENABLED });

  const response = await routes(new Request("https://worker.example/changelog"));

  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match((await response?.text()) ?? "", /landing-root/);
});

test("public routes retire legacy tokenless ticket transcripts", async () => {
  const requestedHtmlKeys: string[] = [];
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    ticketTranscriptBlobs: {
      putHtml: async () => {},
      getHtml: async (key) => {
        requestedHtmlKeys.push(key);
        return key === "guild-1/channel-1.html" ? "<html>legacy transcript</html>" : null;
      },
      putAttachment: async () => {},
      getAttachment: async () => null,
    },
  });

  const response = await routes(
    new Request("https://worker.example/transcripts/guild-1/channel-1"),
  );

  assert.equal(response, null);
  assert.deepEqual(requestedHtmlKeys, []);
});

test("public routes retire legacy tokenless transcript attachments", async () => {
  const requestedAttachmentKeys: string[] = [];
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    ticketTranscriptBlobs: {
      putHtml: async () => {},
      getHtml: async () => null,
      putAttachment: async () => {},
      getAttachment: async (key) => {
        requestedAttachmentKeys.push(key);
        return key === "guild-1/channel-1/attachments/attachment-1/proof.png"
          ? { body: "legacy-image", contentType: "image/png" }
          : null;
      },
    },
  });

  const response = await routes(
    new Request(
      "https://worker.example/transcripts/guild-1/channel-1/media/attachment-1/proof.png",
    ),
  );

  assert.equal(response, null);
  assert.deepEqual(requestedAttachmentKeys, []);
});

test("public routes fail closed for legacy token-in-object-path transcripts", async () => {
  const requestedHtmlKeys: string[] = [];
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    ticketTranscriptBlobs: {
      putHtml: async () => {},
      getHtml: async (key) => {
        requestedHtmlKeys.push(key);
        return "<html>legacy transcript</html>";
      },
      putAttachment: async () => {},
      getAttachment: async () => null,
    },
  });

  const response = await routes(
    new Request("https://worker.example/transcripts/guild-1/channel-1/legacy-token"),
  );

  assert.equal(response?.status, 404);
  assert.equal(await response?.text(), '{"error":"Not found"}');
  assert.deepEqual(requestedHtmlKeys, []);
});

test("public routes reject an expired transcript capability before reading content", async () => {
  const originalDateNow = Date.now;
  Date.now = () => 3_000;
  const database = new SqliteD1Database();
  const capabilities = createCloudflareTicketTranscriptCapabilityStore(database.d1);
  await capabilities.issue({
    objectId: "transcript-1",
    guildId: "guild-1",
    channelId: "channel-1",
    accessToken: "expired-token",
    createdAtMs: 1_000,
    expiresAtMs: 2_000,
    retentionExpiresAtMs: 10_000,
  });
  const requestedHtmlKeys: string[] = [];
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    ticketTranscriptCapabilities: capabilities,
    ticketTranscriptBlobs: {
      putHtml: async () => {},
      getHtml: async (key) => {
        requestedHtmlKeys.push(key);
        return "<html>expired transcript</html>";
      },
      putAttachment: async () => {},
      getAttachment: async () => null,
    },
  });

  try {
    const response = await routes(
      new Request("https://worker.example/transcripts/guild-1/channel-1/expired-token"),
    );

    assert.equal(response?.status, 404);
    assert.equal(await response?.text(), '{"error":"Not found"}');
    assert.equal(response?.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.equal(response?.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(requestedHtmlKeys, []);
  } finally {
    Date.now = originalDateNow;
    database.close();
  }
});

test("public routes authorize transcript attachments through the parent capability", async () => {
  let cancelled = 0;
  const database = new SqliteD1Database();
  const capabilities = createCloudflareTicketTranscriptCapabilityStore(database.d1);
  await capabilities.issue({
    objectId: "transcript-object-1",
    guildId: "guild-1",
    channelId: "channel-1",
    accessToken: "valid-token",
    createdAtMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 10_000,
    retentionExpiresAtMs: Date.now() + 20_000,
  });
  const requestedAttachmentKeys: string[] = [];
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    ticketTranscriptCapabilities: capabilities,
    ticketTranscriptBlobs: {
      putHtml: async () => {},
      getHtml: async () => null,
      putAttachment: async () => {},
      getAttachment: async (key) => {
        requestedAttachmentKeys.push(key);
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("image"));
            },
            pull(controller) {
              controller.close();
            },
            cancel() {
              cancelled += 1;
            },
          }),
          contentType: "image/png",
        };
      },
    },
  });

  try {
    const response = await routes(
      new Request(
        "https://worker.example/transcripts/guild-1/channel-1/valid-token/media/attachment-1/proof.png",
      ),
    );

    assert.equal(response?.status, 200);
    assert.equal(await response?.text(), "image");
    assert.deepEqual(requestedAttachmentKeys, [
      "guild-1/channel-1/transcript-object-1/attachments/attachment-1/proof.png",
    ]);
    assert.equal(cancelled, 0);
    const head = await routes(
      new Request(
        "https://worker.example/transcripts/guild-1/channel-1/valid-token/media/attachment-1/proof.png",
        { method: "HEAD" },
      ),
    );
    assert.equal(head?.status, 200);
    assert.equal(head?.headers.get("content-type"), "image/png");
    assert.equal(head?.body, null);
    assert.equal(cancelled, 1);
  } finally {
    database.close();
  }
});

test("public routes make revoked transcript and attachment links indistinguishable", async () => {
  const database = new SqliteD1Database();
  const capabilities = createCloudflareTicketTranscriptCapabilityStore(database.d1);
  const nowMs = Date.now();
  await capabilities.issue({
    objectId: "transcript-object-1",
    guildId: "guild-1",
    channelId: "channel-1",
    accessToken: "revoked-token",
    createdAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 10_000,
    retentionExpiresAtMs: nowMs + 20_000,
  });
  await capabilities.revoke({
    guildId: "guild-1",
    channelId: "channel-1",
    revokedAtMs: nowMs,
  });
  let blobReads = 0;
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    ticketTranscriptCapabilities: capabilities,
    ticketTranscriptBlobs: {
      putHtml: async () => {},
      getHtml: async () => {
        blobReads += 1;
        return "<html>revoked</html>";
      },
      putAttachment: async () => {},
      getAttachment: async () => {
        blobReads += 1;
        return { body: "revoked", contentType: "image/png" };
      },
    },
  });

  try {
    const [transcript, attachment] = await Promise.all([
      routes(new Request("https://worker.example/transcripts/guild-1/channel-1/revoked-token")),
      routes(
        new Request(
          "https://worker.example/transcripts/guild-1/channel-1/revoked-token/media/a/proof.png",
        ),
      ),
    ]);

    assert.equal(transcript?.status, 404);
    assert.equal(attachment?.status, 404);
    assert.equal(await transcript?.text(), await attachment?.text());
    assert.equal(
      transcript?.headers.get("cache-control"),
      attachment?.headers.get("cache-control"),
    );
    assert.equal(transcript?.headers.get("referrer-policy"), "no-referrer");
    assert.equal(blobReads, 0);
  } finally {
    database.close();
  }
});

test("public routes reject capabilities issued for another Guild or channel", async () => {
  const database = new SqliteD1Database();
  const capabilities = createCloudflareTicketTranscriptCapabilityStore(database.d1);
  await capabilities.issue({
    objectId: "transcript-object-1",
    guildId: "guild-1",
    channelId: "channel-1",
    accessToken: "bound-token",
    createdAtMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 10_000,
    retentionExpiresAtMs: Date.now() + 20_000,
  });
  let blobReads = 0;
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    ticketTranscriptCapabilities: capabilities,
    ticketTranscriptBlobs: {
      putHtml: async () => {},
      getHtml: async () => {
        blobReads += 1;
        return "<html>private</html>";
      },
      putAttachment: async () => {},
      getAttachment: async () => null,
    },
  });

  try {
    const [otherGuild, otherChannel] = await Promise.all([
      routes(new Request("https://worker.example/transcripts/guild-2/channel-1/bound-token")),
      routes(new Request("https://worker.example/transcripts/guild-1/channel-2/bound-token")),
    ]);

    assert.equal(otherGuild?.status, 404);
    assert.equal(otherChannel?.status, 404);
    assert.equal(await otherGuild?.text(), await otherChannel?.text());
    assert.equal(blobReads, 0);
  } finally {
    database.close();
  }
});

test("public routes durably limit transcript capability failures", async () => {
  let reservations = 0;
  let authorizations = 0;
  const guard = {
    getByName(name: string) {
      return {
        async reserve() {
          reservations += 1;
          if (name.includes(":client:") && reservations > 2) {
            return {
              ok: false as const,
              reason: "rate_limited" as const,
              retryAfterSeconds: 60,
            };
          }
          return {
            ok: true as const,
            leaseId: `${name}-lease`,
            expiresAtMs: Date.now() + 1_000,
          };
        },
        async complete() {},
      };
    },
  } as unknown as DurableObjectNamespace<WebhookIngressGuardDO>;
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    ticketTranscriptAccessGuard: guard,
    ticketTranscriptCapabilities: {
      async authorize() {
        authorizations += 1;
        return null;
      },
    } as never,
  });
  const request = () =>
    new Request("https://worker.example/transcripts/guild-1/channel-1/invalid-token", {
      headers: { "cf-connecting-ip": "192.0.2.1" },
    });

  const first = await routes(request());
  const limited = await routes(request());

  assert.equal(first?.status, 404);
  assert.equal(limited?.status, 404);
  assert.equal(await first?.text(), await limited?.text());
  assert.equal(limited?.headers.get("retry-after"), null);
  assert.equal(authorizations, 1);
});

test("public ban case webhook route returns accepted empty response", async () => {
  const publicIds: string[] = [];
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    banCaseService: {
      async handleInboundBanWebhook(publicId: string) {
        publicIds.push(publicId);
        return { accepted: false, reason: "no-extract" };
      },
    } as never,
  });

  const response = await routes(
    new Request("https://worker.example/ban-cases/source-1", {
      method: "POST",
      body: "not a matching ban",
    }),
  );

  assert.equal(response?.status, 204);
  assert.equal(await response?.text(), "");
  assert.deepEqual(publicIds, ["source-1"]);
});

test("webhook proxy GET verification probe returns 200 without reading config", async () => {
  const readCalls: string[] = [];
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    webhookProxyService: {
      async handleInboundWebhook(publicId: string) {
        readCalls.push(publicId);
        return { publicId, acceptedDestinations: 0 };
      },
    } as never,
  });

  const response = await routes(
    new Request("https://worker.example/webhooks/public_webhook_1234", {
      method: "GET",
    }),
  );

  // A constant 200 — valid or not — so the URL cannot be confirmed alive.
  assert.equal(response?.status, 200);
  assert.deepEqual(readCalls, []);
});

test("webhook proxy HEAD verification probe returns 200 for an unknown path", async () => {
  const readCalls: string[] = [];
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    webhookProxyService: {
      async handleInboundWebhook(publicId: string) {
        readCalls.push(publicId);
        return { publicId, acceptedDestinations: 0 };
      },
    } as never,
  });

  const response = await routes(
    new Request("https://worker.example/webhooks/this-path-does-not-exist", {
      method: "HEAD",
    }),
  );

  // An unknown path still returns 200 so it cannot be distinguished from a live one.
  assert.equal(response?.status, 200);
  assert.deepEqual(readCalls, []);
});

test("webhook proxy OPTIONS verification probe returns 204 without reading config", async () => {
  const readCalls: string[] = [];
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    webhookProxyService: {
      async handleInboundWebhook(publicId: string) {
        readCalls.push(publicId);
        return { publicId, acceptedDestinations: 0 };
      },
    } as never,
  });

  const response = await routes(
    new Request("https://worker.example/webhooks/public_webhook_1234", {
      method: "OPTIONS",
    }),
  );

  assert.equal(response?.status, 204);
  assert.equal(response?.headers.get("allow"), "GET, HEAD, POST, OPTIONS");
  assert.deepEqual(readCalls, []);
});

test("webhook proxy POST preserves retries without exposing source state", async () => {
  let handled = false;
  let limitInvalidSource = false;
  let limitKnownSource = false;
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    webhookIngressGuard: {
      getByName(name: string) {
        return {
          async reserve() {
            if (
              (limitInvalidSource && name.startsWith("invalid-source:")) ||
              (limitKnownSource && name === "global:v2:webhook-proxy")
            ) {
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
    } as unknown as DurableObjectNamespace<WebhookIngressGuardDO>,
    webhookProxyService: {
      async readCachedInboundWebhookSource(publicId: string) {
        return publicId.startsWith("known_") ? true : null;
      },
      async hasInboundWebhookSource() {
        return false;
      },
      async handleInboundWebhook() {
        handled = true;
        return { publicId: "unknown_public_id_123", acceptedDestinations: 0 };
      },
    } as never,
  });

  limitInvalidSource = true;
  const unknownLimited = await routes(
    new Request("https://worker.example/webhooks/unknown_public_id_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  limitInvalidSource = false;
  const unknownInvalidBody = await routes(
    new Request("https://worker.example/webhooks/unknown_public_id_456", {
      method: "POST",
      body: new Uint8Array([0xff]),
    }),
  );
  const knownInvalidBody = await routes(
    new Request("https://worker.example/webhooks/known_public_id_12345", {
      method: "POST",
      body: new Uint8Array([0xff]),
    }),
  );
  limitKnownSource = true;
  const knownLimited = await routes(
    new Request("https://worker.example/webhooks/known_public_id_12345", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );

  assert.deepEqual(
    [
      unknownLimited?.status,
      knownLimited?.status,
      unknownInvalidBody?.status,
      knownInvalidBody?.status,
    ],
    [429, 429, 400, 400],
  );
  assert.deepEqual(
    await Promise.all([
      unknownLimited?.text(),
      knownLimited?.text(),
      unknownInvalidBody?.text(),
      knownInvalidBody?.text(),
    ]),
    ["", "", "", ""],
  );
  assert.equal(unknownLimited?.headers.get("retry-after"), "60");
  assert.equal(knownLimited?.headers.get("retry-after"), "60");
  assert.equal(handled, false);
});

test("ban case GET verification probe returns 200 without invoking the service", async () => {
  const publicIds: string[] = [];
  const routes = createPublicRoutes({
    features: ALL_FEATURES_ENABLED,
    banCaseService: {
      async handleInboundBanWebhook(publicId: string) {
        publicIds.push(publicId);
        return { accepted: false, reason: "no-extract" };
      },
    } as never,
  });

  const response = await routes(
    new Request("https://worker.example/ban-cases/source-1", {
      method: "GET",
    }),
  );

  // A constant 200 — valid or not — so the URL cannot be confirmed alive.
  assert.equal(response?.status, 200);
  assert.deepEqual(publicIds, []);
});
