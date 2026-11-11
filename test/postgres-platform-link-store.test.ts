import assert from "node:assert/strict";
import test from "node:test";
import type {
  PlatformLink,
  PlatformLinkConfig,
} from "../src/runtime/contracts/platform-link-store";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";
import { createPostgresPlatformLinkStore } from "../src/runtime/postgres/postgres-platform-link-store";

const postgresUrl = process.env.TEST_POSTGRES_URL;

test(
  "native PostgreSQL Player Links preserve configuration, ownership and atomic replacement",
  {
    skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured",
  },
  async () => {
    assert.ok(postgresUrl);
    const url = new URL(postgresUrl);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) {
      throw new Error("PostgreSQL integration tests require a local database ending in _test.");
    }
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
    });
    try {
      await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await initializePostgresSchema(database);
      const store = createPostgresPlatformLinkStore(database);
      const config: PlatformLinkConfig = {
        guildId: "guild-1",
        platform: "steam",
        linkedRoleId: "role-1",
        logChannelId: null,
        gameAppIds: [221100],
        panelTitle: "Link Steam",
        panelDescription: "Link your account",
        panelButtonLabel: "Link",
        panelButtonStyle: "Primary",
        panelColor: 123,
        allowRelink: true,
        allowMultipleLinks: false,
        requireRelinkOnRejoin: true,
        whoisFields: ["steamId64"],
        customLinks: [],
        panelChannelId: null,
        panelMessageId: null,
        updatedAtMs: 1_800_000_000_000,
      };
      assert.equal(await store.readPlatformLinkConfig("guild-1", "steam"), null);
      await store.upsertPlatformLinkConfig(config);
      assert.deepEqual(await store.readPlatformLinkConfig("guild-1", "steam"), config);
      await store.upsertPlatformLinkConfig({ ...config, panelColor: 456 });
      assert.equal((await store.readPlatformLinkConfig("guild-1", "steam"))?.panelColor, 456);
      assert.equal(await store.setPlatformLinkEnabled!("guild-1", "steam", false), true);
      assert.equal((await store.readPlatformLinkConfig("guild-1", "steam"))?.enabled, false);
      assert.equal(await store.setPlatformLinkEnabled!("guild-2", "steam", false), false);

      const pending = {
        guildId: "guild-1",
        userId: "user-1",
        platform: "steam" as const,
        state: "state",
        createdAtMs: 10,
      };
      await store.createPendingPlatformLink(pending);
      assert.deepEqual(await store.readPendingPlatformLink("state"), pending);
      await store.clearExpiredPendingPlatformLinks(10);
      assert.deepEqual(await store.readPendingPlatformLink("state"), pending);
      await store.clearExpiredPendingPlatformLinks(11);
      assert.equal(await store.readPendingPlatformLink("state"), null);

      const original: PlatformLink = {
        guildId: "guild-1",
        userId: "user-1",
        platform: "steam",
        platformId: "76561198000000001",
        linkedAtMs: 1_800_000_000_000,
        manual: false,
        actionedByUserId: null,
        metadataJson: null,
        active: true,
      };
      const other = { ...original, userId: "other", platformId: "76561198000000002" };
      const xbox = { ...original, platform: "xbox" as const, platformId: "xbox-1" };
      for (const link of [original, other, xbox]) await store.upsertPlatformLink(link);
      assert.deepEqual(await store.readPlatformLink("guild-1", "user-1", "steam"), original);
      assert.equal(
        await store.readPlatformLinkEntry("guild-1", "other", "steam", original.platformId),
        null,
      );
      assert.equal(
        await store.readPlatformLinkByPlatformId("guild-2", "steam", original.platformId),
        null,
      );
      await assert.rejects(
        store.replacePlatformLinks({ ...original, platformId: other.platformId }),
      );
      assert.deepEqual(await store.readPlatformLink("guild-1", "user-1", "steam"), original);
      const replacement = {
        ...original,
        platformId: "76561198000000003",
        active: false,
        metadataJson: '{"verified":true}',
      };
      await store.replacePlatformLinks(replacement);
      assert.equal(
        await store.readPlatformLinkByPlatformId("guild-1", "steam", original.platformId),
        null,
      );
      assert.deepEqual(
        await store.readPlatformLinkByPlatformId("guild-1", "steam", other.platformId),
        other,
      );
      const reconstructed = createPostgresPlatformLinkStore(database);
      assert.deepEqual(
        await reconstructed.readPlatformLink("guild-1", "user-1", "steam"),
        replacement,
      );
      assert.deepEqual(await reconstructed.readPlatformLink("guild-1", "user-1", "xbox"), xbox);
      await store.deletePlatformLink("guild-1", "other", "steam", replacement.platformId);
      assert.deepEqual(await store.readPlatformLink("guild-1", "user-1", "steam"), replacement);
      await store.deletePlatformLink("guild-1", "user-1", "steam", replacement.platformId);
      assert.equal(await store.readPlatformLink("guild-1", "user-1", "steam"), null);
      assert.deepEqual(await store.listPlatformLinksByUser("guild-1", "user-1"), [xbox]);
    } finally {
      await database.close();
    }
  },
);
