import assert from "node:assert/strict";
import test from "node:test";

import { parseDeploymentMode } from "../src/runtime/deployment-mode";
import { createPostgresGuildEntitlementStore } from "../src/runtime/postgres/postgres-guild-entitlement-store";
import { createSqliteGuildEntitlementStore } from "./support/sqlite/runtime/sqlite-guild-entitlement-store";
import type { PostgresDatabaseCapability } from "../src/runtime/postgres/postgres-capability";
import { assertGuildPremiumTier } from "../src/runtime/entitlement-checks";

test("self-hosted core capabilities need no subscription row or database read", async () => {
  const database = {
    query: async () => assert.fail("Unexpected entitlement database access"),
  } as unknown as PostgresDatabaseCapability;
  for (const store of [
    createPostgresGuildEntitlementStore(database, "self-hosted"),
    createSqliteGuildEntitlementStore({} as D1Database, "self-hosted"),
  ]) {
    assert.deepEqual(await store.readGuildEntitlement("guild-a"), {
      guildId: "guild-a",
      tier: "premium_plus",
      updatedAtMs: 0,
    });
    assert.deepEqual(await assertGuildPremiumTier(store, "guild-a"), { ok: true });
    assert.equal((await store.readGuildEntitlement("guild-b")).guildId, "guild-b");
  }
});

test("default hosted mode keeps database authority and Free fallback", async () => {
  const reads: unknown[][] = [];
  const database = {
    query: async (_sql: string, args: unknown[]) => {
      reads.push(args);
      return [];
    },
  } as unknown as PostgresDatabaseCapability;
  for (const mode of [undefined, "hosted"]) {
    const store = createPostgresGuildEntitlementStore(database, mode);
    assert.equal((await store.readGuildEntitlement("guild-a")).tier, "free");
    assert.deepEqual(await assertGuildPremiumTier(store, "guild-a"), {
      ok: false,
      message: "This feature requires the premium tier.",
    });
  }
  assert.equal(reads.length, 4);
});

test("invalid deployment modes fail closed instead of granting paid capabilities", () => {
  assert.equal(parseDeploymentMode(undefined), "hosted");
  for (const invalid of ["", "true", "selfhosted", "SELF-HOSTED"]) {
    assert.throws(
      () => createPostgresGuildEntitlementStore({} as PostgresDatabaseCapability, invalid),
      /HAF_DEPLOYMENT_MODE/,
    );
    assert.throws(
      () => createSqliteGuildEntitlementStore({} as D1Database, invalid),
      /HAF_DEPLOYMENT_MODE/,
    );
  }
});

test("a self-hosted read never changes a cached hosted store for the same database", () => {
  const database = {} as D1Database;
  const hosted = createSqliteGuildEntitlementStore(database);
  const selfHosted = createSqliteGuildEntitlementStore(database, "self-hosted");
  assert.notEqual(hosted, selfHosted);
  assert.equal(createSqliteGuildEntitlementStore(database, "hosted"), hosted);
});
