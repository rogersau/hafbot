import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { createCloudflareAppConfigStore } from "../src/runtime/cloudflare-app-config-store";
import { createCloudflarePlatformLinkStore } from "../src/runtime/cloudflare-platform-link-store";
import { createCloudflareSteamLinkStore } from "../src/runtime/cloudflare-steam-link-store";
import { createCloudflareTicketStore } from "../src/runtime/cloudflare-ticket-store";
import { createCloudflareReactionRoleStore } from "../src/runtime/cloudflare-reaction-role-store";
import { verifyTicketClaimDelivery } from "./helpers/ticket-claim-delivery";
import {
  createPostgresDatabaseCapabilityFromEnvironment,
  type PostgresDatabaseCapability,
} from "../src/runtime/postgres/postgres-capability";
import {
  __testing,
  createPostgresD1CompatibilityDatabase,
} from "../src/runtime/postgres/postgres-d1-compat";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../src/runtime/postgres/postgres-migrations";

test("PostgreSQL D1 compatibility translates only the supported SQLite subset", () => {
  assert.deepEqual(__testing.replacePlaceholders("SELECT ?, ?2, '?', \"?\""), {
    sql: "SELECT $1, $2, '?', \"?\"",
    parameterCount: 2,
  });
  assert.equal(
    __testing.translateSql(
      "INSERT OR IGNORE INTO example (id, value) VALUES (?, MAX(?, MIN(?, ?))) RETURNING id",
      0,
    ).sql,
    "INSERT INTO example (id, value) VALUES ($1, GREATEST($2, LEAST($3, $4))) ON CONFLICT DO NOTHING RETURNING id",
  );
  assert.equal(
    __testing.translateSql("UPDATE example SET value = ? WHERE changes() = 1", 1).sql,
    "UPDATE example SET value = $1 WHERE 1 = 1",
  );
  assert.equal(
    __testing.translateSql(
      'INSERT INTO "example" ("id") VALUES (?) ON CONFLICT ("example"."id") DO NOTHING',
      0,
    ).sql,
    'INSERT INTO "example" ("id") VALUES ($1) ON CONFLICT ("id") DO NOTHING',
  );
  assert.equal(
    __testing.translateSql("SELECT MAX(value) FROM example", 0).sql,
    "SELECT MAX(value) FROM example",
  );
  assert.throws(
    () => __testing.translateSql("PRAGMA foreign_keys = ON", 0),
    /unsupported SQLite-only operation/,
  );
  assert.throws(
    () => __testing.translateSql("INSERT OR REPLACE INTO example VALUES (?)", 0),
    /unsupported SQLite-only operation/,
  );
});

const postgresUrl = process.env.TEST_POSTGRES_URL;

test(
  "PostgreSQL D1 compatibility preserves D1 query, batch, and Drizzle behavior",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
      PG_POOL_MAX: "4",
    });
    try {
      await resetAndMigrate(database);
      await database.execute(`CREATE TABLE compat_probe (
        id BIGINT PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        enabled BOOLEAN NOT NULL,
        happened_at TIMESTAMPTZ NOT NULL,
        count BIGINT NOT NULL,
        amount NUMERIC NOT NULL
      )`);
      const d1 = createPostgresD1CompatibilityDatabase(database);

      const binary = Buffer.from([0, 1, 2, 255]).subarray(1, 3);
      const boundBinary = await d1
        .prepare("SELECT CAST(? AS BYTEA) AS bytes")
        .bind(binary)
        .first<Uint8Array>("bytes");
      assert.deepEqual(Array.from(boundBinary ?? []), [1, 2]);

      const inserted = await d1
        .prepare(
          `INSERT INTO compat_probe (id, label, enabled, happened_at, count, amount)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id, enabled, happened_at, count, amount`,
        )
        .bind(1, "first", true, new Date("2026-08-20T00:00:00.000Z"), 5, 2.5)
        .run<{
          id: number;
          enabled: number;
          happened_at: string;
          count: number;
          amount: number;
        }>();
      assert.equal(inserted.meta.changes, 1);
      assert.deepEqual(inserted.results, [
        {
          id: 1,
          enabled: 1,
          happened_at: "2026-08-20T00:00:00.000Z",
          count: 5,
          amount: 2.5,
        },
      ]);

      const ignored = await d1
        .prepare(
          "INSERT OR IGNORE INTO compat_probe (id, label, enabled, happened_at, count, amount) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(1, "duplicate", false, new Date("2026-08-20T00:00:00.000Z"), 1, 1)
        .run();
      assert.equal(ignored.meta.changes, 0);

      const batch = await d1.batch([
        d1
          .prepare(
            "INSERT INTO compat_probe (id, label, enabled, happened_at, count, amount) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(2, "second", false, new Date("2026-08-21T00:00:00.000Z"), 7, 3),
        d1
          .prepare("UPDATE compat_probe SET count = MAX(count, ?) WHERE id = ? AND changes() = 1")
          .bind(9, 2),
      ]);
      assert.deepEqual(
        batch.map((entry) => entry.meta.changes),
        [1, 1],
      );

      await assert.rejects(
        d1.batch([
          d1
            .prepare(
              "INSERT INTO compat_probe (id, label, enabled, happened_at, count, amount) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(3, "rolled-back", true, new Date("2026-08-22T00:00:00.000Z"), 1, 1),
          d1
            .prepare(
              "INSERT INTO compat_probe (id, label, enabled, happened_at, count, amount) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(3, "duplicate-id", true, new Date("2026-08-22T00:00:00.000Z"), 1, 1),
        ]),
        /duplicate key value/,
      );
      assert.equal(
        await d1
          .prepare("SELECT COUNT(*) AS count FROM compat_probe WHERE id = ?")
          .bind(3)
          .first<number>("count"),
        0,
      );

      assert.deepEqual(
        await d1
          .prepare("SELECT id, MIN(count, ?) AS bounded FROM compat_probe ORDER BY id")
          .bind(6)
          .raw({ columnNames: true }),
        [
          ["id", "bounded"],
          [1, 5],
          [2, 6],
        ],
      );
      await assert.rejects(d1.prepare("SELECT ?").all(), /expected 1 bound values/);

      const appConfig = createCloudflareAppConfigStore(d1);
      const platformLinks = createCloudflarePlatformLinkStore(d1);
      const legacyLinks = createCloudflareSteamLinkStore(d1);
      const original = {
        guildId: "guild-1",
        userId: "user-1",
        platform: "steam" as const,
        platformId: "original",
        linkedAtMs: 1,
        manual: false,
        actionedByUserId: null,
        metadataJson: null,
        active: true,
      };
      await platformLinks.upsertPlatformLink(original);
      await legacyLinks.upsertSteamLink({
        guildId: "guild-1",
        userId: "user-1",
        steamId64: "legacy-only",
        linkedAtMs: 1,
        manual: false,
        actionedByUserId: null,
        gameOwnership: [],
      });
      await legacyLinks.upsertSteamLink({
        guildId: "guild-1",
        userId: "other-user",
        steamId64: "owned",
        linkedAtMs: 1,
        manual: false,
        actionedByUserId: null,
        gameOwnership: [],
      });
      const beforeReplacement = await platformLinks.listPlatformLinks("guild-1");
      await assert.rejects(
        platformLinks.replacePlatformLinks({ ...original, platformId: "owned" }),
      );
      assert.deepEqual(await platformLinks.listPlatformLinks("guild-1"), beforeReplacement);
      await platformLinks.replacePlatformLinks({ ...original, platformId: "replacement" });
      assert.deepEqual(await platformLinks.listPlatformLinksByUser("guild-1", "user-1"), [
        { ...original, platformId: "replacement" },
      ]);
      assert.deepEqual(await legacyLinks.listSteamLinksByUser("guild-1", "user-1"), []);
      const ticketStore = createCloudflareTicketStore(d1);
      await d1
        .prepare("INSERT INTO ticket_counters (guild_id, next_ticket_number) VALUES (?, ?)")
        .bind("counter-migrated-guild", 30)
        .run();
      assert.equal(await ticketStore.reserveNextTicketNumber("counter-migrated-guild"), 30);
      assert.equal(await ticketStore.reserveNextTicketNumber("counter-migrated-guild"), 31);
      assert.equal(await ticketStore.reserveNextTicketNumber("counter-new-guild"), 1);
      await verifyTicketClaimDelivery(ticketStore);
      const reactionRoles = createCloudflareReactionRoleStore(d1);
      const lease = { token: "pg-reaction-role-lease", nowMs: 1000 };
      assert.equal(await reactionRoles.claimLease("100", lease.token, lease.nowMs), true);
      assert.equal(
        await reactionRoles.savePanel(
          {
            guildId: "100",
            id: "pg-panel",
            botUserId: "900",
            channelId: "200",
            messageId: null,
            title: "Games",
            description: "Choose your games",
            options: [{ emoji: "🟢", roleId: "300", label: "DayZ" }],
            publishedOptions: [],
            activatedAtMs: null,
            enabled: false,
            updatedAtMs: 1000,
          },
          lease,
        ),
        true,
      );
      assert.equal((await reactionRoles.readPanel("100"))?.title, "Games");
      assert.equal(await reactionRoles.renewLease("100", lease.token, 2000), true);
      assert.equal(
        await reactionRoles.deletePanel("100", { token: "wrong-lease", nowMs: 2000 }),
        false,
      );
      assert.equal(
        await reactionRoles.deletePanel("100", { token: lease.token, nowMs: 2000 }),
        true,
      );
      await reactionRoles.releaseLease("100", lease.token);
      await appConfig.upsertAppConfig({ key: "portable", value: "one" });
      await appConfig.upsertAppConfig({ key: "portable", value: "two" });
      assert.equal(
        await d1
          .prepare("SELECT value FROM app_config WHERE key = ?")
          .bind("portable")
          .first<string>("value"),
        "two",
      );
    } finally {
      await database.close();
    }
  },
);

async function resetAndMigrate(database: PostgresDatabaseCapability): Promise<void> {
  await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await applyPostgresMigrations(
    database,
    await readPostgresMigrations(resolve("migrations/postgres")),
  );
}

function assertSafeTestDatabase(value: string): void {
  const url = new URL(value);
  const databaseName = url.pathname.slice(1);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || !databaseName.endsWith("_test")) {
    throw new Error("PostgreSQL integration tests require a local database ending in _test.");
  }
}
