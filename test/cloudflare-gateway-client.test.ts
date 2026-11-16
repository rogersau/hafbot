/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { createSqliteGatewayClient } from "./support/sqlite/runtime/sqlite-gateway-client";

test("createSqliteGatewayClient wraps gateway status and bootstrap calls", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const gatewayClient = createSqliteGatewayClient({
    fetch(input, init) {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return Promise.resolve(
        Response.json({
          status: "idle",
          sessionId: null,
          resumeGatewayUrl: null,
          lastSequence: null,
          backoffAttempt: 0,
          lastError: null,
          heartbeatIntervalMs: null,
        }) as any,
      );
    },
  });

  await gatewayClient.status();
  await gatewayClient.start();
  await gatewayClient.stop();

  assert.deepEqual(requests, [
    { url: "https://gateway-session/status", method: "GET" },
    { url: "https://gateway-session/start", method: "POST" },
    { url: "https://gateway-session/stop", method: "POST" },
  ]);
});

test("createSqliteGatewayClient throws descriptive error on non-ok response", async () => {
  const gatewayClient = createSqliteGatewayClient({
    fetch() {
      return Promise.resolve(
        new Response("provider response is not logged", {
          status: 503,
          statusText: "Service Unavailable",
        }) as any,
      );
    },
  });

  await assert.rejects(
    async () => {
      await gatewayClient.status();
    },
    {
      name: "Error",
      message: /Cloudflare gateway request failed: 503$/,
    },
  );
});

test("createSqliteGatewayClient excludes untrusted response details", async () => {
  const gatewayClient = createSqliteGatewayClient({
    fetch() {
      return Promise.resolve(
        new Response('{"token":"provider-secret","customer":"customer@example.com"}', {
          status: 503,
          statusText: '{"token":"provider-secret"}',
        }) as any,
      );
    },
  });

  await assert.rejects(
    async () => {
      await gatewayClient.status();
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Cloudflare gateway request failed: 503");
      assert.doesNotMatch(error.message, /provider-secret|customer@example\.com/);
      return true;
    },
  );
});

test("gateway JSON parse failures cannot expose response fragments", async () => {
  const gatewayClient = createSqliteGatewayClient({
    fetch: async () => new Response('private@example.com {"token":"provider-secret"}'),
  });
  await assert.rejects(
    () => gatewayClient.status(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Cloudflare gateway returned an invalid JSON response.");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.stack ?? "", /private@example\.com|provider-secret/);
      return true;
    },
  );
});

test("createSqliteGatewayClient sends bot identity headers when configured", async () => {
  const requests: Array<{
    url: string;
    method: string;
    token: string | null;
    identity: string | null;
  }> = [];
  const gatewayClient = createSqliteGatewayClient(
    {
      fetch(input, init) {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          token: headers.get("X-Discord-Bot-Token"),
          identity: headers.get("X-Gateway-Bot-Identity"),
        });
        return Promise.resolve(Response.json({ status: "connecting" }) as any);
      },
    },
    { botIdentityId: "white-label:guild-1", discordBotToken: "resolved-token" },
  );

  await gatewayClient.start();

  assert.deepEqual(requests, [
    {
      url: "https://gateway-session/start",
      method: "POST",
      token: "resolved-token",
      identity: "white-label:guild-1",
    },
  ]);
});
