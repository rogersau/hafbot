/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareSteamLinkStore } from "../src/runtime/cloudflare-steam-link-store";
import type {
  PendingSteamLink,
  SteamLink,
  SteamLinkConfig,
} from "../src/runtime/contracts/steam-link-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("createCloudflareSteamLinkStore reads and writes Steam Link configs from the unified database", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareSteamLinkStore(database as unknown as D1Database);
  const config = createConfig({
    guildId: "guild-1",
    steamLinkedRoleId: "role-1",
    logChannelId: "log-1",
    gameAppIds: [221100, 393380],
    allowRelink: false,
    whoisFields: ["steamId64", "profile"],
    customLinks: [{ label: "CFTools", url: "https://cfan.eu/players/{steamId64}" }],
    panelChannelId: "channel-1",
    panelMessageId: "message-1",
    updatedAtMs: 100,
  });

  await store.upsertSteamLinkConfig(config);

  assert.deepEqual(await store.readSteamLinkConfig("guild-1"), config);
  assert.equal(await store.readSteamLinkConfig("guild-2"), null);
  assert.equal(database.execCalls, 0);
});

test("createCloudflareSteamLinkStore updates Steam Link configs and defaults legacy custom links", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareSteamLinkStore(database as unknown as D1Database);

  await database
    .prepare(
      `INSERT INTO steam_link_configs(
        guild_id, steam_linked_role_id, log_channel_id, game_app_ids_json,
        panel_title, panel_description, panel_button_label, panel_button_style,
        allow_relink, whois_fields_json, updated_at_ms, panel_channel_id, panel_message_id
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "guild-legacy",
      null,
      null,
      "[]",
      "Link Steam",
      "Link Steam",
      "Link",
      "Primary",
      1,
      "[]",
      1,
      null,
      null,
    )
    .run();

  assert.deepEqual((await store.readSteamLinkConfig("guild-legacy"))?.customLinks, [
    { label: "CFTools", url: "https://app.cftools.cloud/profile/{steamId64}" },
  ]);

  const original = createConfig({ guildId: "guild-1", steamLinkedRoleId: "role-old" });
  const updated = createConfig({
    guildId: "guild-1",
    steamLinkedRoleId: "role-new",
    panelTitle: "Updated title",
    panelDescription: "Updated description",
    panelButtonLabel: "Verify",
    panelButtonStyle: "Secondary",
    updatedAtMs: 200,
  });

  await store.upsertSteamLinkConfig(original);
  await store.upsertSteamLinkConfig(updated);

  assert.deepEqual(await store.readSteamLinkConfig("guild-1"), updated);
});

test("createCloudflareSteamLinkStore creates, reads, deletes, and cleans up Pending Steam Links", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareSteamLinkStore(database as unknown as D1Database);
  const expired = createPending({ state: "state-expired", createdAtMs: 100 });
  const active = createPending({ state: "state-active", createdAtMs: 300 });

  await store.createPendingSteamLink(expired);
  await store.createPendingSteamLink(active);

  assert.deepEqual(await store.readPendingSteamLink("state-expired"), expired);
  assert.deepEqual(await store.readPendingSteamLink("state-active"), active);

  await store.clearExpiredPendingSteamLinks(200);

  assert.equal(await store.readPendingSteamLink("state-expired"), null);
  assert.deepEqual(await store.readPendingSteamLink("state-active"), active);

  await store.deletePendingSteamLink("state-active");

  assert.equal(await store.readPendingSteamLink("state-active"), null);
});

test("createCloudflareSteamLinkStore upserts, reads, and deletes Steam Links", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareSteamLinkStore(database as unknown as D1Database);
  const original = createLink({
    guildId: "guild-1",
    userId: "user-1",
    steamId64: "76561198000000001",
    manual: false,
    gameOwnership: [
      { appId: "221100", name: "DayZ", owned: true, playtimeHours: 10, note: "Owned" },
    ],
  });
  const updated = createLink({
    guildId: "guild-1",
    userId: "user-1",
    steamId64: "76561198000000002",
    linkedAtMs: 200,
    manual: true,
    actionedByUserId: "admin-1",
    gameOwnership: [
      { appId: "393380", name: "Squad", owned: false, playtimeHours: null, note: "Missing" },
    ],
  });

  await store.upsertSteamLink(original);

  assert.deepEqual(await store.readSteamLink("guild-1", "user-1"), original);
  assert.deepEqual(await store.readSteamLinkBySteamId64("guild-1", "76561198000000001"), original);
  assert.equal(await store.readSteamLink("guild-1", "user-2"), null);

  await store.upsertSteamLink(updated);

  assert.deepEqual(await store.readSteamLink("guild-1", "user-1"), updated);
  assert.deepEqual(await store.readSteamLinkBySteamId64("guild-1", "76561198000000002"), updated);

  await store.deleteSteamLink("guild-1", "user-1");

  assert.equal(await store.readSteamLink("guild-1", "user-1"), null);
});

test("createCloudflareSteamLinkStore lists Steam Links for one Guild", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareSteamLinkStore(database as unknown as D1Database);
  const guildLinkA = createLink({ guildId: "guild-1", userId: "user-a", steamId64: "1" });
  const guildLinkB = createLink({ guildId: "guild-1", userId: "user-b", steamId64: "2" });
  const otherGuildLink = createLink({ guildId: "guild-2", userId: "user-c", steamId64: "3" });

  await store.upsertSteamLink(guildLinkA);
  await store.upsertSteamLink(otherGuildLink);
  await store.upsertSteamLink(guildLinkB);

  assert.deepEqual(await store.listSteamLinks("guild-1"), [guildLinkA, guildLinkB]);
});

function createConfig(overrides: Partial<SteamLinkConfig> = {}): SteamLinkConfig {
  return {
    guildId: "guild-1",
    steamLinkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    panelTitle: "Link your Steam account",
    panelDescription:
      "Click the button below to securely link your Discord account to your Steam account.",
    panelButtonLabel: "Link Steam",
    panelButtonStyle: "Primary",
    panelColor: 0x5865f2,
    allowRelink: true,
    allowMultipleLinks: false,
    whoisFields: [],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: 1,
    ...overrides,
  };
}

function createPending(overrides: Partial<PendingSteamLink> = {}): PendingSteamLink {
  return {
    state: "state-1",
    guildId: "guild-1",
    userId: "user-1",
    createdAtMs: 100,
    ...overrides,
  };
}

function createLink(overrides: Partial<SteamLink> = {}): SteamLink {
  return {
    guildId: "guild-1",
    userId: "user-1",
    steamId64: "76561198000000000",
    linkedAtMs: 100,
    manual: false,
    actionedByUserId: null,
    gameOwnership: [],
    ...overrides,
  };
}
