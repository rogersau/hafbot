/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflarePlatformLinkStore } from "../src/runtime/cloudflare-platform-link-store";
import { createCloudflareSteamLinkStore } from "../src/runtime/cloudflare-steam-link-store";
import type {
  PendingPlatformLink,
  PlatformLink,
  PlatformLinkConfig,
} from "../src/runtime/contracts/platform-link-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("createCloudflarePlatformLinkStore reads and writes platform link configs per platform", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflarePlatformLinkStore(database as unknown as D1Database);
  const steamConfig = createConfig({
    guildId: "guild-1",
    platform: "steam",
    linkedRoleId: "role-steam",
    logChannelId: "log-1",
    gameAppIds: [221100, 393380],
    allowRelink: false,
    whoisFields: ["platformId", "profile"],
    customLinks: [{ label: "CFTools", url: "https://cfan.eu/players/{platformId}" }],
    panelChannelId: "channel-1",
    panelMessageId: "message-1",
    updatedAtMs: 100,
  });
  const xboxConfig = createConfig({
    guildId: "guild-1",
    platform: "xbox",
    linkedRoleId: "role-xbox",
    logChannelId: "log-2",
    panelTitle: "Link your Xbox account",
    panelButtonLabel: "Link Xbox",
    updatedAtMs: 200,
  });

  await store.upsertPlatformLinkConfig(steamConfig);
  await store.upsertPlatformLinkConfig(xboxConfig);

  assert.deepEqual(await store.readPlatformLinkConfig("guild-1", "steam"), steamConfig);
  assert.deepEqual(await store.readPlatformLinkConfig("guild-1", "xbox"), xboxConfig);
  assert.equal(await store.readPlatformLinkConfig("guild-1", "cftools"), null);
  assert.equal(await store.readPlatformLinkConfig("guild-2", "steam"), null);
  assert.equal(database.execCalls, 0);
});

test("createCloudflarePlatformLinkStore creates, reads, deletes, and cleans up pending platform links", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflarePlatformLinkStore(database as unknown as D1Database);
  const expiredSteam = createPending({
    state: "state-expired-steam",
    platform: "steam",
    createdAtMs: 100,
  });
  const activeXbox = createPending({
    state: "state-active-xbox",
    platform: "xbox",
    createdAtMs: 300,
  });

  await store.createPendingPlatformLink(expiredSteam);
  await store.createPendingPlatformLink(activeXbox);

  assert.deepEqual(await store.readPendingPlatformLink("state-expired-steam"), expiredSteam);
  assert.deepEqual(await store.readPendingPlatformLink("state-active-xbox"), activeXbox);

  await store.clearExpiredPendingPlatformLinks(200);

  assert.equal(await store.readPendingPlatformLink("state-expired-steam"), null);
  assert.deepEqual(await store.readPendingPlatformLink("state-active-xbox"), activeXbox);

  await store.deletePendingPlatformLink("state-active-xbox");

  assert.equal(await store.readPendingPlatformLink("state-active-xbox"), null);
});

test("createCloudflarePlatformLinkStore upserts, reads, and deletes platform links with platform discriminator", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflarePlatformLinkStore(database as unknown as D1Database);
  const steamLink = createLink({
    guildId: "guild-1",
    userId: "user-1",
    platform: "steam",
    platformId: "76561198000000001",
    manual: false,
    metadataJson: JSON.stringify({
      gameOwnership: [{ appId: "221100", name: "DayZ", owned: true }],
    }),
  });
  const xboxLink = createLink({
    guildId: "guild-1",
    userId: "user-1",
    platform: "xbox",
    platformId: "xuid-12345",
    linkedAtMs: 200,
    manual: true,
    actionedByUserId: "admin-1",
    metadataJson: null,
  });

  await store.upsertPlatformLink(steamLink);
  await store.upsertPlatformLink(xboxLink);

  assert.deepEqual(await store.readPlatformLink("guild-1", "user-1", "steam"), steamLink);
  assert.deepEqual(await store.readPlatformLink("guild-1", "user-1", "xbox"), xboxLink);
  assert.equal(await store.readPlatformLink("guild-1", "user-1", "cftools"), null);

  assert.deepEqual(
    await store.readPlatformLinkByPlatformId("guild-1", "steam", "76561198000000001"),
    steamLink,
  );
  assert.deepEqual(
    await store.readPlatformLinkByPlatformId("guild-1", "xbox", "xuid-12345"),
    xboxLink,
  );

  await store.deletePlatformLink("guild-1", "user-1", "steam");

  assert.equal(await store.readPlatformLink("guild-1", "user-1", "steam"), null);
  assert.deepEqual(await store.readPlatformLink("guild-1", "user-1", "xbox"), xboxLink);
});

test("createCloudflarePlatformLinkStore lists all platform links for a user across platforms", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflarePlatformLinkStore(database as unknown as D1Database);
  const steamLink = createLink({
    guildId: "guild-1",
    userId: "user-1",
    platform: "steam",
    platformId: "76561198000000001",
  });
  const xboxLink = createLink({
    guildId: "guild-1",
    userId: "user-1",
    platform: "xbox",
    platformId: "xuid-12345",
    linkedAtMs: 200,
  });

  await store.upsertPlatformLink(steamLink);
  await store.upsertPlatformLink(xboxLink);

  const links = await store.listPlatformLinksByUser("guild-1", "user-1");

  assert.equal(links.length, 2);
  assert.ok(links.some((l) => l.platform === "steam" && l.platformId === "76561198000000001"));
  assert.ok(links.some((l) => l.platform === "xbox" && l.platformId === "xuid-12345"));
});

test("createCloudflarePlatformLinkStore deletes one account without removing sibling links", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflarePlatformLinkStore(database as unknown as D1Database);
  const first = createLink({ userId: "user-1", platform: "steam", platformId: "steam-1" });
  const second = createLink({ userId: "user-1", platform: "steam", platformId: "steam-2" });
  const xbox = createLink({ userId: "user-1", platform: "xbox", platformId: "xbox-1" });

  await store.upsertPlatformLink(first);
  await store.upsertPlatformLink(second);
  await store.upsertPlatformLink(xbox);
  await store.deletePlatformLink("guild-1", "user-1", "steam", "steam-1");

  assert.equal(await store.readPlatformLinkEntry("guild-1", "user-1", "steam", "steam-1"), null);
  assert.deepEqual(
    await store.readPlatformLinkEntry("guild-1", "user-1", "steam", "steam-2"),
    second,
  );
  assert.deepEqual(await store.readPlatformLinkEntry("guild-1", "user-1", "xbox", "xbox-1"), xbox);
});

test("createCloudflarePlatformLinkStore lists platform links filtered by platform", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflarePlatformLinkStore(database as unknown as D1Database);
  const steamLink1 = createLink({
    guildId: "guild-1",
    userId: "user-a",
    platform: "steam",
    platformId: "steam-1",
  });
  const steamLink2 = createLink({
    guildId: "guild-1",
    userId: "user-b",
    platform: "steam",
    platformId: "steam-2",
  });
  const xboxLink = createLink({
    guildId: "guild-1",
    userId: "user-c",
    platform: "xbox",
    platformId: "xbox-1",
  });

  await store.upsertPlatformLink(steamLink1);
  await store.upsertPlatformLink(steamLink2);
  await store.upsertPlatformLink(xboxLink);

  assert.deepEqual(await store.listPlatformLinks("guild-1", "steam"), [steamLink1, steamLink2]);
  assert.deepEqual(await store.listPlatformLinks("guild-1", "xbox"), [xboxLink]);
  assert.equal((await store.listPlatformLinks("guild-1", "cftools")).length, 0);
});

test("createCloudflarePlatformLinkStore deletes all platform links for a user when platform is omitted", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflarePlatformLinkStore(database as unknown as D1Database);
  const steamLink = createLink({
    guildId: "guild-1",
    userId: "user-1",
    platform: "steam",
    platformId: "steam-1",
  });
  const xboxLink = createLink({
    guildId: "guild-1",
    userId: "user-1",
    platform: "xbox",
    platformId: "xbox-1",
  });

  await store.upsertPlatformLink(steamLink);
  await store.upsertPlatformLink(xboxLink);

  await store.deletePlatformLink("guild-1", "user-1");

  assert.equal(await store.readPlatformLink("guild-1", "user-1", "steam"), null);
  assert.equal(await store.readPlatformLink("guild-1", "user-1", "xbox"), null);
  assert.equal((await store.listPlatformLinksByUser("guild-1", "user-1")).length, 0);
});

function createConfig(overrides: Partial<PlatformLinkConfig> = {}): PlatformLinkConfig {
  return {
    guildId: "guild-1",
    platform: "steam",
    linkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    panelTitle: "Link your account",
    panelDescription: "Click the button below to securely link your Discord account.",
    panelButtonLabel: "Link",
    panelButtonStyle: "Primary",
    panelColor: 0x5865f2,
    allowRelink: true,
    allowMultipleLinks: false,
    requireRelinkOnRejoin: false,
    whoisFields: [],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: 1,
    ...overrides,
  };
}

function createPending(overrides: Partial<PendingPlatformLink> = {}): PendingPlatformLink {
  return {
    state: "state-1",
    guildId: "guild-1",
    userId: "user-1",
    platform: "steam",
    createdAtMs: 100,
    ...overrides,
  };
}

function createLink(overrides: Partial<PlatformLink> = {}): PlatformLink {
  return {
    guildId: "guild-1",
    userId: "user-1",
    platform: "steam",
    platformId: "76561198000000000",
    linkedAtMs: 100,
    manual: false,
    actionedByUserId: null,
    metadataJson: null,
    active: true,
    ...overrides,
  };
}

for (const failInsert of [false, true]) {
  test(`Platform Link replacement ${failInsert ? "rolls back both stores on insert failure" : "commits without resurrecting legacy Steam identities"}`, async () => {
    const database = new SqliteD1Database();
    const store = createCloudflarePlatformLinkStore(database.d1);
    const legacy = createCloudflareSteamLinkStore(database.d1);
    const current = createLink({ platformId: "current" });
    const sibling = createLink({ platformId: "sibling", active: false });
    const xbox = createLink({ platform: "xbox", platformId: "xbox" });
    const otherUser = createLink({ userId: "other-user", platformId: "other-user-account" });
    try {
      for (const link of [current, sibling, xbox, otherUser]) await store.upsertPlatformLink(link);
      await legacy.upsertSteamLink({
        guildId: "guild-1",
        userId: "user-1",
        steamId64: "legacy-only",
        linkedAtMs: 10,
        manual: false,
        actionedByUserId: null,
        gameOwnership: [],
      });
      const before = await store.listPlatformLinks("guild-1");
      const replacement = createLink({ platformId: "replacement", metadataJson: '{"ready":true}' });
      if (failInsert) {
        database.execRaw(`CREATE TRIGGER fail_replacement BEFORE INSERT ON platform_links
          WHEN NEW.platform_id = 'replacement' BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`);
        await assert.rejects(store.replacePlatformLinks(replacement), /injected insert failure/);
        assert.deepEqual(await store.listPlatformLinks("guild-1"), before);
        assert.equal((await legacy.listSteamLinks("guild-1")).length, 1);
      } else {
        await store.replacePlatformLinks(replacement);
        assert.deepEqual(await store.listPlatformLinksByUser("guild-1", "user-1"), [
          replacement,
          xbox,
        ]);
        assert.deepEqual(
          await store.readPlatformLinkByPlatformId("guild-1", "steam", "other-user-account"),
          otherUser,
        );
        assert.deepEqual(await legacy.listSteamLinks("guild-1"), []);
        assert.equal(
          await store.readPlatformLinkByPlatformId("guild-1", "steam", "legacy-only"),
          null,
        );
      }
    } finally {
      database.close();
    }
  });
}

for (const legacyDuplicate of [false, true]) {
  test(`Platform Link replacement cannot claim another user's ${legacyDuplicate ? "legacy" : "current"} identity`, async () => {
    const database = new SqliteD1Database();
    const store = createCloudflarePlatformLinkStore(database.d1);
    try {
      const original = createLink({ platformId: "original" });
      await store.upsertPlatformLink(original);
      if (legacyDuplicate) {
        await createCloudflareSteamLinkStore(database.d1).upsertSteamLink({
          guildId: "guild-1",
          userId: "other-user",
          steamId64: "owned",
          linkedAtMs: 10,
          manual: false,
          actionedByUserId: null,
          gameOwnership: [],
        });
      } else {
        await store.upsertPlatformLink(createLink({ userId: "other-user", platformId: "owned" }));
      }
      const before = await store.listPlatformLinks("guild-1");
      await assert.rejects(store.replacePlatformLinks(createLink({ platformId: "owned" })));
      assert.deepEqual(await store.listPlatformLinks("guild-1"), before);
      assert.deepEqual(await store.readPlatformLink("guild-1", "user-1", "steam"), original);
    } finally {
      database.close();
    }
  });
}

for (const platform of ["xbox", "playstation"] as const) {
  test(`Platform Link replacement rolls back ${platform} identities on a conflicting insert`, async () => {
    const database = new SqliteD1Database();
    const store = createCloudflarePlatformLinkStore(database.d1);
    try {
      const original = createLink({ platform, platformId: "original" });
      const other = createLink({ platform, userId: "other", platformId: "owned" });
      await store.upsertPlatformLink(original);
      await store.upsertPlatformLink(other);
      await assert.rejects(
        store.replacePlatformLinks(createLink({ platform, platformId: "owned" })),
      );
      assert.deepEqual(await store.readPlatformLink("guild-1", "user-1", platform), original);
      await store.replacePlatformLinks(createLink({ platform, platformId: "replacement" }));
      assert.equal(
        (await store.listPlatformLinksByUser("guild-1", "user-1"))[0]?.platformId,
        "replacement",
      );
    } finally {
      database.close();
    }
  });
}
