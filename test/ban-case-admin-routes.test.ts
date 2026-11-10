/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  appearsPubliclyVisible,
  createBanCasesAdminRoutes,
} from "../src/runtime/admin-routes/ban-cases";
import type { DiscordChannelResource } from "../src/discord/guilds";
import { dispatchAdminRoute } from "../src/runtime/admin-route-registry";
import type { RuntimeStores } from "../src/runtime/app-types";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import { allowAllAdminAccess } from "./helpers/admin-api";
import type { BanCaseSource } from "../src/types";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

const forum: DiscordChannelResource = {
  id: "forum-1",
  name: "ban-cases",
  type: 15,
  parent_id: "category-1",
  position: 1,
};

test("appearsPubliclyVisible treats an explicit everyone deny as staff-scoped", () => {
  const scopedForum: DiscordChannelResource = {
    ...forum,
    permission_overwrites: [{ id: "guild-1", type: 0, allow: "0", deny: "1024" }],
  };

  assert.equal(appearsPubliclyVisible("guild-1", scopedForum), false);
});

test("Ban Case forum config rejects an unsynced public forum under a private category", async () => {
  const category: DiscordChannelResource = {
    id: "category-1",
    name: "staff",
    type: 4,
    parent_id: null,
    position: 0,
    permission_overwrites: [{ id: "guild-1", type: 0, allow: "0", deny: "1024" }],
  };

  const originalFetch = globalThis.fetch;
  const writes: unknown[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/channels")) return Response.json([forum, category]);
    if (url.endsWith("/roles")) return Response.json([]);
    throw new Error(`Unexpected Discord request: ${url}`);
  };
  const { dispatch, close } = createBanCaseDispatcher({
    readConfig: async () => null,
    upsertConfig: async (config) => {
      writes.push(config);
    },
  });

  try {
    const rejected = await dispatch("/admin/api/ban-cases/config/forum-channel", {
      guildId: "guild-1",
      forumChannelId: forum.id,
    });
    assert.equal(rejected?.status, 400);
    assert.deepEqual(writes, []);

    const syncedForum = { ...forum, permission_overwrites: category.permission_overwrites };
    globalThis.fetch = async (input) =>
      Response.json(String(input).endsWith("/channels") ? [syncedForum, category] : []);
    const accepted = await dispatch("/admin/api/ban-cases/config/forum-channel", {
      guildId: "guild-1",
      forumChannelId: forum.id,
    });
    assert.equal(accepted?.status, 200);
    assert.equal(writes.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    close();
  }
});

test("appearsPubliclyVisible flags forums without an everyone deny", () => {
  assert.equal(appearsPubliclyVisible("guild-1", forum), true);
});

test("Ban Case source creation generates URL credentials without Math.random", async () => {
  const originalRandom = Math.random;
  const sources: BanCaseSource[] = [];
  const { dispatch, close } = createBanCaseDispatcher({
    upsertBanCaseSource: async (source) => {
      sources.push(source);
    },
  });
  Math.random = () => {
    throw new Error("Insecure random source used for a webhook credential");
  };

  try {
    const response = await dispatch("/admin/api/ban-cases/config", {
      guildId: "guild-1",
      name: "Ban feed",
      enabled: true,
      platform: "steam",
      pattern: "(?<subject>\\d+) (?<name>.+) (?<reason>.+)",
      subjectIdGroup: "subject",
      nameGroup: "name",
      reasonGroup: "reason",
    });
    assert.equal(response?.status, 200);
    assert.equal(sources.length, 1);
    assert.match(sources[0]!.publicId, /^[A-Za-z0-9_-]{16,64}$/);
    assert.match(sources[0]!.sourceId, /^[A-Za-z0-9_-]{1,64}$/);
  } finally {
    Math.random = originalRandom;
    close();
  }
});

function createBanCaseDispatcher(banCases: Partial<RuntimeStores["banCases"]>) {
  const fixture = createProductionRuntimeStores();
  const stores: RuntimeStores = {
    ...fixture.stores,
    banCases: { ...fixture.stores.banCases, ...banCases },
    guildEntitlements: {
      readGuildEntitlement: async () => ({ guildId: "guild-1", tier: "premium", updatedAtMs: 0 }),
    },
  };
  const routes = createBanCasesAdminRoutes({ stores, discordBotToken: "test-token" });
  const dispatch = (path: string, body: unknown) =>
    dispatchAdminRoute(
      routes,
      new Request(`https://example.com${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { stores, adminAccess: allowAllAdminAccess, features: ALL_FEATURES_ENABLED },
    );
  return { dispatch, close: fixture.close };
}
