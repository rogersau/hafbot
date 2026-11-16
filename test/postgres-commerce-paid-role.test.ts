import type { PostgresDatabaseCapability } from "../src/runtime/postgres/postgres-capability";
import assert from "node:assert/strict";
import test from "node:test";

import { PostgresPaidRoleStore } from "../src/runtime/postgres/postgres-commerce-paid-role-store";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";

const postgresUrl = process.env.TEST_POSTGRES_URL;
const NOW = 1_800_000_000_000;

for (const fixture of [
  {
    name: "omitted offering returns all managed statuses in update order",
    offeringId: undefined,
    expected: ["assigned", "removing", "failed", "pending", "withheld"],
  },
  {
    name: "text offering restricts managed assignments",
    offeringId: "offering-one",
    expected: ["assigned", "failed", "pending"],
  },
  {
    name: "unknown text offering returns no assignments",
    offeringId: "offering-unknown",
    expected: [],
  },
]) {
  test(
    `PostgreSQL nullable recovery: ${fixture.name}`,
    { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
    async () => {
      await withPostgres(async (database) => {
        await seedAssignments(database);
        const store = new PostgresPaidRoleStore(database);
        const assignments = await store.listManagedAssignments({
          guildId: "guild-one",
          discordRoleId: "role-shared",
          ...(fixture.offeringId === undefined ? {} : { offeringId: fixture.offeringId }),
        });
        assert.deepEqual(
          assignments.map((assignment) => assignment.id),
          fixture.expected,
        );
      });
    },
  );
}

async function withPostgres(operation: (database: PostgresDatabaseCapability) => Promise<void>) {
  assert.ok(postgresUrl);
  const url = new URL(postgresUrl);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  assert.match(url.pathname, /_test$/);
  const database = createPostgresDatabaseCapabilityFromEnvironment({
    DATABASE_URL: postgresUrl,
    NODE_ENV: "test",
    PG_POOL_MAX: "4",
  });
  try {
    await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await initializePostgresSchema(database);
    await operation(database);
  } finally {
    await database.close();
  }
}

async function seedAssignments(database: PostgresDatabaseCapability) {
  for (const guild of ["guild-one", "guild-two"]) {
    await database.queryResult(
      "INSERT INTO commerce_connected_accounts(id, guild_id, stripe_account_id, status, created_at_ms, updated_at_ms)\n        VALUES ($1, $2, $3, 'active', $4, $5)",
      [`seller-${guild}`, guild, `acct-${guild}`, NOW, NOW],
    );
  }
  for (const offering of [
    { id: "offering-one", guild: "guild-one", role: "role-shared" },
    { id: "offering-two", guild: "guild-one", role: "role-shared" },
    { id: "offering-other-guild", guild: "guild-two", role: "role-shared" },
    { id: "offering-other-role", guild: "guild-one", role: "role-other" },
  ]) {
    // A replacement and its archived predecessor can share a Guild/role pair.
    const archived = offering.id === "offering-two";
    await database.queryResult(
      "INSERT INTO commerce_offerings(id, connected_account_id, guild_id, discord_role_id, name, purchase_type, state, archived_at_ms, created_at_ms, updated_at_ms)\n      VALUES ($1, $2, $3, $4, 'Fixture Offering', 'subscription', $5, $6, $7, $8)",
      [
        offering.id,
        `seller-${offering.guild}`,
        offering.guild,
        offering.role,
        archived ? "archived" : "published",
        archived ? NOW : null,
        NOW,
        NOW,
      ],
    );
  }
  for (const fixture of [
    {
      id: "pending",
      offering: "offering-one",
      guild: "guild-one",
      role: "role-shared",
      status: "pending",
      offset: 40,
    },
    {
      id: "assigned",
      offering: "offering-one",
      guild: "guild-one",
      role: "role-shared",
      status: "assigned",
      offset: 10,
    },
    {
      id: "withheld",
      offering: "offering-two",
      guild: "guild-one",
      role: "role-shared",
      status: "withheld",
      offset: 50,
    },
    {
      id: "removing",
      offering: "offering-two",
      guild: "guild-one",
      role: "role-shared",
      status: "removing",
      offset: 20,
    },
    {
      id: "failed",
      offering: "offering-one",
      guild: "guild-one",
      role: "role-shared",
      status: "failed",
      offset: 30,
    },
    {
      id: "removed",
      offering: "offering-one",
      guild: "guild-one",
      role: "role-shared",
      status: "removed",
      offset: 0,
    },
    {
      id: "other-guild",
      offering: "offering-other-guild",
      guild: "guild-two",
      role: "role-shared",
      status: "assigned",
      offset: 0,
    },
    {
      id: "other-role",
      offering: "offering-other-role",
      guild: "guild-one",
      role: "role-other",
      status: "assigned",
      offset: 0,
    },
    {
      id: "missing-entitlement",
      offering: null,
      guild: "guild-one",
      role: "role-shared",
      status: "assigned",
      offset: 0,
    },
  ]) {
    await database.queryResult(
      "INSERT INTO commerce_buyers(id, discord_user_id, created_at_ms, updated_at_ms) VALUES ($1, $2, $3, $4)",
      [`buyer-${fixture.id}`, `user-${fixture.id}`, NOW, NOW],
    );
    if (fixture.offering !== null) {
      await database.queryResult(
        "INSERT INTO commerce_entitlements(id, connected_account_id, buyer_id, offering_id, source_type, source_id, status, effective_at_ms, created_at_ms, updated_at_ms)\n        VALUES ($1, $2, $3, $4, 'subscription', $5, 'active', $6, $7, $8)",
        [
          `entitlement-${fixture.id}`,
          `seller-${fixture.guild}`,
          `buyer-${fixture.id}`,
          fixture.offering,
          `sub-${fixture.id}`,
          NOW,
          NOW,
          NOW,
        ],
      );
    }
    await database.queryResult(
      "INSERT INTO commerce_role_assignments(id, entitlement_id, guild_id, discord_user_id, discord_role_id, status, withheld_reason, created_at_ms, updated_at_ms)\n      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        fixture.id,
        `entitlement-${fixture.id}`,
        fixture.guild,
        `user-${fixture.id}`,
        fixture.role,
        fixture.status,
        fixture.status === "withheld" ? "member_absent" : null,
        NOW,
        NOW + fixture.offset,
      ],
    );
  }
}
