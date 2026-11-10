/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import {
  loadGuildResources,
  resetGuildResourcesCache,
} from "../src/admin/lib/guild-resources-cache";

test("an older failed request cannot evict a successful forced refresh", async () => {
  const originalFetch = globalThis.fetch;
  let rejectOriginal!: (error: Error) => void;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return calls === 1
      ? new Promise<Response>((_, reject) => {
          rejectOriginal = reject;
        })
      : Promise.resolve(
          Response.json({
            guildId: "guild-1",
            roles: [],
            categories: [],
            textChannels: [],
            voiceChannels: [],
            forumChannels: [],
          }),
        );
  };
  try {
    const original = loadGuildResources("workspace-1", "guild-1");
    const failed = assert.rejects(original, /old request/);
    const refreshed = await loadGuildResources("workspace-1", "guild-1", { refresh: true });
    rejectOriginal(new Error("old request"));
    await failed;
    assert.equal(await loadGuildResources("workspace-1", "guild-1"), refreshed);
    assert.equal(calls, 2);
  } finally {
    resetGuildResourcesCache();
    globalThis.fetch = originalFetch;
  }
});

test("guild resources reuse the same guild response within the app session", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return Response.json({
      guildId: "guild-1",
      roles: [],
      categories: [],
      textChannels: [],
      voiceChannels: [{ id: "voice-1", name: "Squad 1" }],
    });
  };

  try {
    const first = await loadGuildResources("workspace-1", "guild-1");
    await loadGuildResources("workspace-1", "guild-1");

    assert.deepEqual(first.voiceChannels, [{ id: "voice-1", name: "Squad 1" }]);
    assert.deepEqual(requests, [
      "/admin/api/tickets/resources?guildId=guild-1&workspaceId=workspace-1",
    ]);
  } finally {
    resetGuildResourcesCache();
    globalThis.fetch = originalFetch;
  }
});

test("guild resources fetch again after the session cache is reset", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return Response.json({
      guildId: "guild-1",
      roles: [],
      categories: [],
      textChannels: [],
      voiceChannels: [],
    });
  };

  try {
    await loadGuildResources("workspace-1", "guild-1");
    resetGuildResourcesCache();
    await loadGuildResources("workspace-1", "guild-1");

    assert.deepEqual(requests, [
      "/admin/api/tickets/resources?guildId=guild-1&workspaceId=workspace-1",
      "/admin/api/tickets/resources?guildId=guild-1&workspaceId=workspace-1",
    ]);
  } finally {
    resetGuildResourcesCache();
    globalThis.fetch = originalFetch;
  }
});

test("guild resources forced refresh bypasses the cached response", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return Response.json({
      guildId: "guild-1",
      roles: [],
      categories: [],
      textChannels: [],
      voiceChannels: [],
    });
  };

  try {
    await loadGuildResources("workspace-1", "guild-1");
    await loadGuildResources("workspace-1", "guild-1", { refresh: true });

    assert.deepEqual(requests, [
      "/admin/api/tickets/resources?guildId=guild-1&workspaceId=workspace-1",
      "/admin/api/tickets/resources?guildId=guild-1&workspaceId=workspace-1&refresh=1",
    ]);
  } finally {
    resetGuildResourcesCache();
    globalThis.fetch = originalFetch;
  }
});

test("guild resources load fresh data for a different guild", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return Response.json({
      guildId: "guild-1",
      roles: [],
      categories: [],
      textChannels: [],
      voiceChannels: [],
    });
  };

  try {
    await loadGuildResources("workspace-1", "guild-1");
    await loadGuildResources("workspace-1", "guild-2");

    assert.deepEqual(requests, [
      "/admin/api/tickets/resources?guildId=guild-1&workspaceId=workspace-1",
      "/admin/api/tickets/resources?guildId=guild-2&workspaceId=workspace-1",
    ]);
  } finally {
    resetGuildResourcesCache();
    globalThis.fetch = originalFetch;
  }
});
