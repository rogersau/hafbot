/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import type { BanCase, BanCaseConfig } from "../src/types";
import { BanCaseService } from "../src/services/ban-case-service";
import { afterStoreSeed, createProductionRuntimeStores } from "./support/production-runtime-stores";
import {
  handleBanCaseComponentInteraction,
  isBanCaseComponentInteraction,
} from "../src/runtime/ban-case-interaction-handler";
import type { DiscordInteraction, RuntimeStores } from "../src/runtime/app-types";

const config: BanCaseConfig = {
  guildId: "guild-1",
  enabled: true,
  forumChannelId: "forum-1",
  modRoleIds: ["mod-role-1"],
  updatedAtMs: 100,
};

const banCase: BanCase = {
  guildId: "guild-1",
  caseId: "case-1",
  sourceId: "source-1",
  publicId: "pub-1",
  subject: { platform: "steam", id: "76561199304898090" },
  username: "KXWR.xyz",
  status: "new",
  threadChannelId: "thread-1",
  threadMessageId: "thread-1",
  createdAtMs: 100,
  updatedAtMs: 100,
};

function createStores(
  options: {
    config?: BanCaseConfig;
    banCase?: BanCase;
  } = {},
): { stores: RuntimeStores; service: BanCaseService } {
  const fixture = createProductionRuntimeStores();
  const rawStore = fixture.stores.banCases;
  const seededConfig = options.config ?? config;
  const seededCase = options.banCase ?? banCase;
  const store = afterStoreSeed(
    rawStore,
    Promise.all([rawStore.upsertConfig(seededConfig), rawStore.createBanCase(seededCase)]),
  );
  const stores = { ...fixture.stores, banCases: store };
  const service = new BanCaseService(store, {
    discord: {
      createForumThread: async () => ({ id: "thread-1", message: { id: "thread-1" } }),
      createChannelMessage: async () => {},
      editChannelMessage: async () => {},
      modifyThread: async () => {},
      postAudit: async () => {},
    },
    guildEntitlements: fixture.stores.guildEntitlements,
    guildAuditLog: fixture.stores.guildAuditLog,
    now: () => 200,
  });
  return { stores, service };
}

function buildInteraction(overrides: Partial<DiscordInteraction> = {}): DiscordInteraction {
  return {
    type: 3,
    guild_id: "guild-1",
    member: {
      permissions: "0",
      roles: ["mod-role-1"],
      user: { id: "mod-1", username: "Mod", global_name: "Mod" },
    },
    data: { custom_id: "ban-case:complete:guild-1:case-1" },
    ...overrides,
  };
}

test("isBanCaseComponentInteraction recognises the complete button", () => {
  assert.equal(isBanCaseComponentInteraction(buildInteraction()), true);
  assert.equal(
    isBanCaseComponentInteraction(
      buildInteraction({ data: { custom_id: "image-rules:approve:1" } }),
    ),
    false,
  );
});

test("handleBanCaseComponentInteraction allows a configured mod role", async () => {
  const { stores, service } = createStores();
  const response = await handleBanCaseComponentInteraction(buildInteraction(), stores, service);
  const body = (await response.json()) as { data: { content?: string } };
  assert.match(body.data.content ?? "", /completed/);
});

test("handleBanCaseComponentInteraction denies a non-mod member when mod roles are configured", async () => {
  const { stores, service } = createStores();
  const response = await handleBanCaseComponentInteraction(
    buildInteraction({
      member: { permissions: "0", roles: ["other-role"], user: { id: "user-1" } },
    }),
    stores,
    service,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: { content?: string } };
  assert.match(body.data.content ?? "", /Only Ban Case moderators/);
});

test("handleBanCaseComponentInteraction denies a cross-guild complete without mutation", async () => {
  const { stores, service } = createStores();
  const response = await handleBanCaseComponentInteraction(
    buildInteraction({
      guild_id: "guild-2",
      member: { permissions: "8", roles: ["mod-role-1"], user: { id: "admin-2" } },
    }),
    stores,
    service,
  );
  const body = (await response.json()) as { data: { content?: string } };

  assert.match(body.data.content ?? "", /not available in this server/);
  assert.equal((await stores.banCases.readBanCase("guild-1", "case-1"))?.status, "new");
});

test("handleBanCaseComponentInteraction falls back to guild admin when zero mod roles configured", async () => {
  const { stores, service } = createStores({ config: { ...config, modRoleIds: [] } });
  // Administrator permission bit set.
  const response = await handleBanCaseComponentInteraction(
    buildInteraction({
      member: {
        permissions: "8",
        roles: [],
        user: { id: "admin-1" },
      },
    }),
    stores,
    service,
  );
  const body = (await response.json()) as { data: { content?: string } };
  assert.match(body.data.content ?? "", /completed/);
});

test("handleBanCaseComponentInteraction reports already handled for a completed case", async () => {
  const { stores, service } = createStores({
    banCase: { ...banCase, status: "completed" },
  });
  const response = await handleBanCaseComponentInteraction(buildInteraction(), stores, service);
  const body = (await response.json()) as { data: { content?: string } };
  assert.match(body.data.content ?? "", /already been handled/);
});

test("handleBanCaseComponentInteraction rejects a malformed custom id", async () => {
  const { stores, service } = createStores();
  const response = await handleBanCaseComponentInteraction(
    buildInteraction({ data: { custom_id: "ban-case:complete:guild-1" } }),
    stores,
    service,
  );
  const body = (await response.json()) as { data: { content?: string } };
  assert.match(body.data.content ?? "", /Unsupported Ban Case action/);
});
