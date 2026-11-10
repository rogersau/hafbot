/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { syncWhiteLabelApplicationCommands } from "../src/runtime/white-label-command-sync";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";

test("syncWhiteLabelApplicationCommands syncs global commands excluding haf-admin", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify([]), { status: 200 });
  }) as typeof fetch;

  try {
    await syncWhiteLabelApplicationCommands({
      applicationId: "white-label-app-1",
      botToken: "white-label-token",
      features: ALL_FEATURES_ENABLED,
    });

    assert.equal(requests.length, 1);
    assert.equal(
      requests[0]?.url,
      "https://discord.com/api/v10/applications/white-label-app-1/commands",
    );
    assert.equal(requests[0]?.init?.method, "PUT");
    assert.equal(
      (requests[0]?.init?.headers as Record<string, string>)?.Authorization,
      "Bot white-label-token",
    );

    const body = JSON.parse((requests[0]?.init?.body as string) ?? "[]");
    const commandNames = body.map((command: { name: string }) => command.name);
    assert.ok(commandNames.length > 0, "expected at least one command");
    assert.ok(
      !commandNames.includes("haf-admin"),
      "haf-admin should not be synced to white-label apps",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("syncWhiteLabelApplicationCommands throws on Discord API error", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response("Forbidden", { status: 403 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        syncWhiteLabelApplicationCommands({
          applicationId: "white-label-app-1",
          botToken: "white-label-token",
          features: ALL_FEATURES_ENABLED,
        }),
      /Failed to sync application commands/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
