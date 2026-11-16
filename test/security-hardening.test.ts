import type { WebhookIngressGuardNamespace } from "../src/runtime/contracts/webhook-ingress-guard";
import assert from "node:assert/strict";
import test from "node:test";

import { createEvidenceMediaCapability } from "../src/security/evidence-media-capability";
import {
  createWebhookCredentialKeyRing,
  decryptWebhookCredential,
  decryptWardogsRconCredential,
  encryptWebhookCredential,
  encryptWardogsRconCredential,
  parseDiscordWebhookCredential,
  type PlaintextWardogsRconSecret,
  redactWebhookSecrets,
} from "../src/security/webhook-credentials";
import { readBoundedUtf8Body } from "../src/runtime/bounded-request-body";
import {
  parsePublicIngressContentType,
  PUBLIC_INGRESS_POLICIES,
} from "../src/runtime/public-ingress-policy";
import { handlePublicWebhookIngress } from "../src/runtime/public-webhook-ingress";
import { WebhookProxyNotFoundError } from "../src/services/webhook-proxy-service";

test("evidence media capabilities are scoped, expiring, and tamper resistant", async () => {
  const capability = createEvidenceMediaCapability("dedicated-secret", { now: () => 1_000_000 });
  const token = await capability.issue({
    guildId: "g",
    recordId: "r",
    imageId: "i",
    expiresAtSeconds: 1_600,
  });
  assert.deepEqual(await capability.verify(token, { guildId: "g", recordId: "r", imageId: "i" }), {
    ok: true,
    expiresAtSeconds: 1_600,
  });
  assert.equal(
    (await capability.verify(token, { guildId: "g", recordId: "r", imageId: "other" })).ok,
    false,
  );
  assert.equal(
    (await capability.verify(`${token}x`, { guildId: "g", recordId: "r", imageId: "i" })).ok,
    false,
  );
});

test("Discord webhook credentials parse, canonicalize, mask, encrypt, and bind owner context", async () => {
  const parsed = await parseDiscordWebhookCredential(
    "https://canary.discord.com/api/webhooks/123456789012345678/Abc_def-123",
  );
  assert.equal(
    parsed.canonicalUrl,
    "https://discord.com/api/webhooks/123456789012345678/Abc_def-123",
  );
  assert.doesNotMatch(parsed.maskedDisplay, /Abc/);
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const keyRing = await createWebhookCredentialKeyRing({ keyV1: key });
  const owner = {
    kind: "proxy_destination" as const,
    guildId: "g",
    publicId: "p",
    destinationId: "d",
  };
  const envelope = await encryptWebhookCredential({
    plaintext: parsed.canonicalUrl,
    credentialId: "c",
    owner,
    keyRing,
  });
  assert.equal(
    await decryptWebhookCredential({ envelope, credentialId: "c", owner, keyRing }),
    parsed.canonicalUrl,
  );
  await assert.rejects(() =>
    decryptWebhookCredential({
      envelope,
      credentialId: "c",
      owner: { ...owner, destinationId: "other" },
      keyRing,
    }),
  );

  const rconOwner = { kind: "wardogs_rcon" as const, guildId: "g", publicId: "target" };
  const rconEnvelope = await encryptWardogsRconCredential({
    plaintext: "rcon-password" as PlaintextWardogsRconSecret,
    credentialId: "rcon-c",
    owner: rconOwner,
    keyRing,
  });
  assert.equal(
    await decryptWardogsRconCredential({
      envelope: rconEnvelope,
      credentialId: "rcon-c",
      owner: rconOwner,
      keyRing,
    }),
    "rcon-password",
  );
  await assert.rejects(() =>
    decryptWebhookCredential({
      envelope: rconEnvelope,
      credentialId: "rcon-c",
      owner: rconOwner,
      keyRing,
    }),
  );
});

test("webhook parser rejects provider and path tricks and redactor removes tokens recursively", async () => {
  for (const value of [
    "http://discord.com/api/webhooks/123456/token",
    "https://discord.com.evil.test/api/webhooks/123456/token",
    "https://discord.com/api/webhooks/123456/token/slack",
    "https://discord.com/api/webhooks/123456/token?wait=true",
    "https://discord.com/api/webhooks/123456/a%2Fb",
  ])
    await assert.rejects(() => parseDiscordWebhookCredential(value));
  const secret = "https://discord.com/api/webhooks/123456/token_value";
  const redacted = redactWebhookSecrets({ message: `failed ${secret}`, nested: [secret] });
  assert.doesNotMatch(JSON.stringify(redacted), /token_value/);
  assert.match(JSON.stringify(redacted), /REDACTED_WEBHOOK_TOKEN/);
});

test("bounded body reader stops false-small and invalid UTF-8 bodies", async () => {
  const tooLarge = await readBoundedUtf8Body(
    new Request("https://example.test", {
      method: "POST",
      headers: { "content-length": "1" },
      body: "12345",
    }),
    { maxBytes: 4, canonicalMediaType: "text/plain" },
  );
  assert.deepEqual(tooLarge, { ok: false, reason: "too_large" });
  const invalid = await readBoundedUtf8Body(
    new Request("https://example.test", { method: "POST", body: new Uint8Array([0xff]) }),
    { maxBytes: 4 },
  );
  assert.deepEqual(invalid, { ok: false, reason: "invalid_utf8" });
});

test("public ingress media-type policy accepts structured JSON and rejects binary declarations", () => {
  assert.equal(parsePublicIngressContentType("application/problem+json; charset=utf-8").ok, true);
  assert.equal(parsePublicIngressContentType(null).ok, true);
  assert.equal(parsePublicIngressContentType("image/png").ok, false);
});

test("product partitions preserve the original aggregate valid-source capacity", () => {
  const policies = Object.values(PUBLIC_INGRESS_POLICIES);
  assert.equal(
    policies.reduce((total, policy) => total + policy.globalRequestsPerMinute, 0),
    1_200,
  );
  assert.equal(
    policies.reduce((total, policy) => total + policy.globalBurst, 0),
    200,
  );
  assert.equal(
    policies.reduce((total, policy) => total + policy.globalConcurrency, 0),
    100,
  );
});

test("public ingress propagates handler errors after releasing guard leases", async () => {
  const completions: string[] = [];
  const source = {
    async reserve() {
      return { ok: true as const, leaseId: "source-lease" };
    },
    async registerBody() {
      return { ok: true as const };
    },
    async complete() {
      completions.push("source");
    },
  };
  const global = {
    async reserve() {
      return { ok: true as const, leaseId: "global-lease" };
    },
    async complete() {
      completions.push("global");
    },
  };
  const guard = {
    getByName(name: string) {
      return name === "global:v2:webhook-proxy" ? global : source;
    },
  } as unknown as WebhookIngressGuardNamespace;
  const expected = new WebhookProxyNotFoundError("Webhook not found");

  await assert.rejects(
    handlePublicWebhookIngress({
      request: new Request("https://example.test/webhooks/public_webhook_1234", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      product: "webhook-proxy",
      publicId: "public_webhook_1234",
      guard,
      async readCachedSourceExists() {
        return true;
      },
      async sourceExists() {
        return true;
      },
      async handle() {
        throw expected;
      },
    }),
    (error) => error === expected,
  );
  assert.deepEqual(completions.sort(), ["global", "source"]);
});

test("unknown public IDs use only the independently limited invalid-source capacity", async () => {
  const names: string[] = [];
  const completions: string[] = [];
  const guard = createIngressGuardMock({
    onGet(name) {
      names.push(name);
    },
    onComplete(name, outcome) {
      completions.push(`${name}:${outcome}`);
    },
  });

  for (let index = 0; index < 25; index += 1) {
    const result = await handlePublicWebhookIngress({
      request: webhookRequest(`random_public_id_${String(index).padStart(2, "0")}`),
      product: "webhook-proxy",
      publicId: `random_public_id_${String(index).padStart(2, "0")}`,
      guard,
      async readCachedSourceExists() {
        return null;
      },
      async sourceExists() {
        return false;
      },
      async handle() {
        assert.fail("unknown sources must not reach the handler");
      },
    });
    assert.deepEqual(result, { ok: false, reason: "invalid_source" });
  }

  assert.equal(
    names.some((name) => name === "global:v2:webhook-proxy"),
    false,
  );
  assert.equal(
    names.some((name) => name.startsWith("source:v1:")),
    false,
  );
  assert.equal(
    names.some((name) => name.startsWith("invalid-source:v1:webhook-proxy:client:")),
    true,
  );
  assert.equal(names.includes("invalid-source:v1:webhook-proxy:global"), true);
  assert.equal(
    completions.every((entry) => entry.endsWith(":invalid_source")),
    true,
  );
});

test("valid-source global capacity is isolated by webhook product", async () => {
  const reservedNames: string[] = [];
  let banCaseHandled = false;
  const guard = createIngressGuardMock({
    reserve(name) {
      reservedNames.push(name);
      if (name === "global:v2:webhook-proxy")
        return { ok: false as const, reason: "rate_limited" as const, retryAfterSeconds: 10 };
      return { ok: true as const, leaseId: `${name}-lease`, expiresAtMs: Date.now() + 30_000 };
    },
  });

  const webhookResult = await handlePublicWebhookIngress({
    request: webhookRequest("known_webhook_id_1234"),
    product: "webhook-proxy",
    publicId: "known_webhook_id_1234",
    guard,
    async readCachedSourceExists() {
      return true;
    },
    async sourceExists() {
      return true;
    },
    async handle() {
      assert.fail("limited Webhook Proxy traffic must not reach the handler");
    },
  });
  const banCaseResult = await handlePublicWebhookIngress({
    request: webhookRequest("known_ban_case_id_12"),
    product: "ban-case",
    publicId: "known_ban_case_id_12",
    guard,
    async readCachedSourceExists() {
      return true;
    },
    async sourceExists() {
      return true;
    },
    async handle() {
      banCaseHandled = true;
    },
  });

  assert.equal(webhookResult.ok, false);
  assert.deepEqual(banCaseResult, { ok: true, duplicate: false });
  assert.equal(banCaseHandled, true);
  assert.equal(reservedNames.includes("global:v2:webhook-proxy"), true);
  assert.equal(reservedNames.includes("global:v2:ban-case"), true);
  assert.equal(reservedNames.includes("global:v1"), false);
});

test("exhausted invalid-source capacity does not affect a known source", async () => {
  const reservedNames: string[] = [];
  let handled = false;
  let sourceLookups = 0;
  const guard = createIngressGuardMock({
    reserve(name) {
      reservedNames.push(name);
      if (name.startsWith("invalid-source:"))
        return { ok: false as const, reason: "rate_limited" as const, retryAfterSeconds: 60 };
      return { ok: true as const, leaseId: `${name}-lease`, expiresAtMs: Date.now() + 30_000 };
    },
  });

  const unknown = await handlePublicWebhookIngress({
    request: webhookRequest("unknown_source_id_123"),
    product: "webhook-proxy",
    publicId: "unknown_source_id_123",
    guard,
    async readCachedSourceExists() {
      return null;
    },
    async sourceExists() {
      sourceLookups += 1;
      return false;
    },
    async handle() {
      assert.fail("unknown sources must not reach the handler");
    },
  });
  const known = await handlePublicWebhookIngress({
    request: webhookRequest("known_source_id_12345"),
    product: "webhook-proxy",
    publicId: "known_source_id_12345",
    guard,
    async readCachedSourceExists() {
      return true;
    },
    async sourceExists() {
      return true;
    },
    async handle() {
      handled = true;
    },
  });

  assert.deepEqual(unknown, {
    ok: false,
    reason: "limited",
    retryAfterSeconds: 60,
  });
  assert.deepEqual(known, { ok: true, duplicate: false });
  assert.equal(handled, true);
  assert.equal(sourceLookups, 0);
  assert.equal(reservedNames.includes("global:v2:webhook-proxy"), true);
});

test("malformed public IDs are rejected before source lookup or Durable Object access", async () => {
  let sourceLookups = 0;
  let guardLookups = 0;
  const guard = {
    getByName() {
      guardLookups += 1;
      throw new Error("must not be called");
    },
  } as unknown as WebhookIngressGuardNamespace;

  const result = await handlePublicWebhookIngress({
    request: webhookRequest("short"),
    product: "webhook-proxy",
    publicId: "short",
    guard,
    async readCachedSourceExists() {
      sourceLookups += 1;
      return null;
    },
    async sourceExists() {
      sourceLookups += 1;
      return false;
    },
    async handle() {
      assert.fail("malformed sources must not reach the handler");
    },
  });

  assert.deepEqual(result, { ok: false, reason: "invalid_source" });
  assert.equal(sourceLookups, 0);
  assert.equal(guardLookups, 0);
});

function webhookRequest(publicId: string): Request {
  return new Request(`https://example.test/webhooks/${publicId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
    },
    body: "{}",
  });
}

function createIngressGuardMock(options: {
  onGet?: (name: string) => void;
  reserve?: (
    name: string,
  ) =>
    | { ok: true; leaseId: string; expiresAtMs: number }
    | { ok: false; reason: "rate_limited" | "concurrency_limited"; retryAfterSeconds: number };
  onComplete?: (name: string, outcome: string) => void;
}): WebhookIngressGuardNamespace {
  return {
    getByName(name: string) {
      options.onGet?.(name);
      return {
        async reserve() {
          return (
            options.reserve?.(name) ?? {
              ok: true as const,
              leaseId: `${name}-lease`,
              expiresAtMs: Date.now() + 30_000,
            }
          );
        },
        async registerBody() {
          return { ok: true as const };
        },
        async complete(input: { outcome: string }) {
          options.onComplete?.(name, input.outcome);
        },
      };
    },
  } as unknown as WebhookIngressGuardNamespace;
}
