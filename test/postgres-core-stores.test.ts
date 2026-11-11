import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { user } from "../src/db/postgres/auth-schema";
import { createPostgresAppConfigStore } from "../src/runtime/postgres/postgres-app-config-store";
import {
  __testing,
  createPostgresDatabaseCapabilityFromEnvironment,
  type PostgresDatabaseCapability,
} from "../src/runtime/postgres/postgres-capability";
import { createPostgresCustomerAuth } from "../src/runtime/postgres/postgres-customer-auth";
import { createPostgresGuildRbacStore } from "../src/runtime/postgres/postgres-guild-rbac-store";
import { createPostgresGuildServiceSuspensionStore } from "../src/runtime/postgres/postgres-guild-service-suspension-store";
import { createPostgresKnownGuildStore } from "../src/runtime/postgres/postgres-known-guild-store";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";
import { createPostgresUserPreferencesStore } from "../src/runtime/postgres/postgres-user-preferences-store";
import { createPostgresWorkspaceStore } from "../src/runtime/postgres/postgres-workspace-store";
import { WorkspaceGuildAlreadyLinkedError } from "../src/runtime/workspace-store";

test("PostgreSQL environment validation requires verified production TLS", () => {
  assert.throws(() => __testing.validatePostgresUrl("not-a-url", false), /valid PostgreSQL URL/);
  assert.throws(
    () => __testing.validatePostgresUrl("postgresql://localhost", false),
    /database name/,
  );
  assert.throws(
    () => __testing.validatePostgresUrl("postgresql://user:pass@db.example/haf", true),
    /sslmode=verify-full/,
  );
  assert.throws(
    () =>
      __testing.validatePostgresUrl("postgresql://user:pass@db.example/haf?sslmode=require", true),
    /sslmode=verify-full/,
  );
  assert.doesNotThrow(() =>
    __testing.validatePostgresUrl(
      "postgresql://user:pass@db.example/haf?sslmode=verify-full",
      true,
    ),
  );
});

test("PostgreSQL production permits only an explicit internal Docker TLS exception", async () => {
  const localDockerUrl = "postgresql://haf:example@postgres:5432/haf?sslmode=disable";
  assert.throws(() => __testing.validatePostgresUrl(localDockerUrl, true), /explicit flag/);
  assert.doesNotThrow(() => __testing.validatePostgresUrl(localDockerUrl, true, true));
  assert.throws(
    () =>
      __testing.validatePostgresUrl(
        "postgresql://haf:example@db.example/haf?sslmode=disable",
        true,
        true,
      ),
    /sslmode=verify-full/,
  );
  assert.throws(
    () => __testing.validatePostgresUrl("postgresql://haf:example@postgres/haf", true, true),
    /sslmode=verify-full/,
  );
  assert.throws(
    () =>
      createPostgresDatabaseCapabilityFromEnvironment({
        DATABASE_URL: localDockerUrl,
        NODE_ENV: "production",
        PG_ALLOW_INSECURE_DOCKER_NETWORK: "yes",
      }),
    /must be true or false/,
  );
  const database = createPostgresDatabaseCapabilityFromEnvironment({
    DATABASE_URL: localDockerUrl,
    NODE_ENV: "production",
    PG_ALLOW_INSECURE_DOCKER_NETWORK: "true",
  });
  await database.close();
});

const postgresUrl = process.env.TEST_POSTGRES_URL;

test(
  "PostgreSQL core adapters satisfy persistence, concurrency, auth, and fresh schema initialization",
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
      await resetTestDatabase(database);
      await Promise.all([initializePostgresSchema(database), initializePostgresSchema(database)]);

      await verifyAppConfig(database);
      await verifyGuildRbac(database);
      await verifyKnownGuilds(database);
      await verifyUserPreferences(database);
      await verifyWorkspaceStore(database);
      await verifySuspensions(database);
      await verifyAuthSchema(database);
      await verifyReadOnlyHttpConnection(postgresUrl);
      assert.deepEqual(
        await database.query(`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
        AND (tablename LIKE 'legacy_%' OR tablename IN (
          'haf_schema_migrations', 'billing_founder_places', 'steam_link_configs',
          'steam_links', 'pending_steam_links', 'reaction_role_additional_panels'
        ))
      `),
        [],
      );
      await database.execute("CREATE TABLE unrelated_private_state (id TEXT)");
      await assert.rejects(initializePostgresSchema(database), /current public schema or be empty/);
      await database.execute("DROP TABLE unrelated_private_state");
    } finally {
      await database.close();
    }
  },
);

async function verifyReadOnlyHttpConnection(url: string): Promise<void> {
  const database = createPostgresDatabaseCapabilityFromEnvironment(
    {
      DATABASE_URL: url,
      NODE_ENV: "test",
      PG_HTTP_POOL_MAX: "2",
    },
    { readOnly: true },
  );
  try {
    assert.deepEqual(await database.query("SHOW default_transaction_read_only"), [
      { default_transaction_read_only: "on" },
    ]);
    assert.equal(
      (await database.query("SELECT key FROM app_config WHERE key = $1", ["gateway"]))[0]?.key,
      "gateway",
    );
    await assert.rejects(
      database.execute("INSERT INTO app_config (key, value) VALUES ('http-write', 'blocked')"),
      /read-only transaction/,
    );
  } finally {
    await database.close();
  }
}

async function verifyAppConfig(database: PostgresDatabaseCapability): Promise<void> {
  const store = createPostgresAppConfigStore(database);
  await store.upsertAppConfig({ key: "gateway", value: "one" });
  await store.upsertAppConfig({ key: "gateway", value: "two" });
  const rows = await database.query<{ value: string }>(
    "SELECT value FROM app_config WHERE key = $1",
    ["gateway"],
  );
  assert.equal(rows[0]?.value, "two");
}

async function verifyGuildRbac(database: PostgresDatabaseCapability): Promise<void> {
  const store = createPostgresGuildRbacStore(database);
  assert.equal(await store.readManageServerAdminEnabled("guild-1"), true);
  await store.setManageServerAdminEnabled("guild-1", false);
  assert.equal(await store.readGuildAdminRoleId("guild-1"), null);
  await store.upsertGuildAdminRoleId("guild-2", "role-2");
  await store.upsertGuildAdminRoleId("guild-1", "role-1");
  await store.upsertGuildAdminRoleId("guild-1", "role-replaced");
  assert.deepEqual(await store.listGuildAdminRoleAssignments(), [
    { guildId: "guild-1", roleId: "role-replaced" },
    { guildId: "guild-2", roleId: "role-2" },
  ]);
  await store.upsertGuildAdminRoleId("guild-1", null);
  assert.equal(await store.readGuildAdminRoleId("guild-1"), null);
  assert.equal(await store.readManageServerAdminEnabled("guild-1"), false);
  assert.equal(await store.readManageServerAdminEnabled("guild-2"), true);
  await store.setManageServerAdminEnabled("guild-1", true);
  assert.equal(await store.readManageServerAdminEnabled("guild-1"), true);
}

async function verifyKnownGuilds(database: PostgresDatabaseCapability): Promise<void> {
  const store = createPostgresKnownGuildStore(database);
  const record = {
    guildId: "guild-known",
    name: "Known Guild",
    memberCount: 10,
    ownerId: "owner-1",
    icon: null,
    installedAtMs: 100,
    removedAtMs: null,
  };
  assert.deepEqual(
    (await Promise.all([store.insertKnownGuild(record), store.insertKnownGuild(record)])).sort(),
    [false, true],
  );
  await store.updateMetadata(record.guildId, { memberCount: 11, icon: "icon" });
  assert.deepEqual(await store.readKnownGuild(record.guildId), {
    ...record,
    memberCount: 11,
    icon: "icon",
  });
  await store.setRemoved(record.guildId, 200);
  assert.equal((await store.readKnownGuild(record.guildId))?.removedAtMs, 200);
  await store.clearRemoved(record.guildId);
  assert.equal((await store.readKnownGuild(record.guildId))?.removedAtMs, null);
}

async function verifyUserPreferences(database: PostgresDatabaseCapability): Promise<void> {
  const store = createPostgresUserPreferencesStore(database);
  assert.equal(await store.readUserPreferences("user-preferences"), null);
  const preferences = {
    hiddenGuildIds: ["guild-hidden"],
    defaultGuildId: "guild-known",
    emailNotifications: false,
    pushNotifications: true,
    theme: "dark" as const,
    language: "fr" as const,
  };
  await store.upsertUserPreferences("user-preferences", preferences);
  assert.deepEqual(await store.readUserPreferences("user-preferences"), preferences);
}

async function verifyWorkspaceStore(database: PostgresDatabaseCapability): Promise<void> {
  await database.execute(
    `INSERT INTO "Organization" ("id", "name", "slug", "createdAt") VALUES
       ('workspace-1', 'Workspace One', 'workspace-one', CURRENT_TIMESTAMP),
       ('workspace-2', 'Workspace Two', 'workspace-two', CURRENT_TIMESTAMP)`,
  );
  const store = createPostgresWorkspaceStore(database);
  await store.linkGuildToWorkspace({
    workspaceId: "workspace-1",
    guildId: "guild-workspace",
    linkedByUserId: "user-1",
    linkedAtMs: 100,
  });
  await assert.rejects(
    store.linkGuildToWorkspace({
      workspaceId: "workspace-2",
      guildId: "guild-workspace",
      linkedByUserId: "user-2",
      linkedAtMs: 200,
    }),
    WorkspaceGuildAlreadyLinkedError,
  );
  assert.deepEqual(await store.listGuildsForWorkspace("workspace-1"), [
    {
      workspaceId: "workspace-1",
      guildId: "guild-workspace",
      linkedByUserId: "user-1",
      linkedAtMs: 100,
    },
  ]);

  await store.upsertEntitlement({
    workspaceId: "workspace-1",
    plan: "paid",
    status: "active",
    enabledFlags: ["one"],
    updatedAtMs: 150,
  });
  assert.deepEqual(await store.readEntitlement("workspace-1"), {
    workspaceId: "workspace-1",
    plan: "paid",
    status: "active",
    enabledFlags: ["one"],
    updatedAtMs: 150,
  });

  await Promise.all([
    store.unlinkGuildFromWorkspace({
      workspaceId: "workspace-1",
      guildId: "guild-workspace",
      unlinkedByUserId: "user-3",
      unlinkedAtMs: 300,
    }),
    store.unlinkGuildFromWorkspace({
      workspaceId: "workspace-1",
      guildId: "guild-workspace",
      unlinkedByUserId: "user-4",
      unlinkedAtMs: 301,
    }),
  ]);
  const audit = await store.listWorkspaceGuildAuditEvents("workspace-1");
  assert.equal(audit.filter((event) => event.action === "unlinked").length, 1);
  assert.equal(audit.filter((event) => event.action === "linked").length, 1);
}

async function verifySuspensions(database: PostgresDatabaseCapability): Promise<void> {
  const store = createPostgresGuildServiceSuspensionStore(database);
  await store.suspendGuild({
    guildId: "guild-suspended",
    reason: "operator hold",
    actorUserId: "operator-1",
    occurredAtMs: 400,
  });
  assert.equal((await store.readActiveSuspension("guild-suspended"))?.reason, "operator hold");
  await store.restoreGuild({
    guildId: "guild-suspended",
    actorUserId: "operator-2",
    occurredAtMs: 500,
  });
  assert.equal(await store.readActiveSuspension("guild-suspended"), null);
  assert.deepEqual(
    (await store.listAuditEvents("guild-suspended")).map(({ id: _id, ...event }) => event),
    [
      {
        guildId: "guild-suspended",
        action: "suspended",
        reason: "operator hold",
        actorUserId: "operator-1",
        occurredAtMs: 400,
      },
      {
        guildId: "guild-suspended",
        action: "restored",
        reason: null,
        actorUserId: "operator-2",
        occurredAtMs: 500,
      },
    ],
  );
}

async function verifyAuthSchema(database: PostgresDatabaseCapability): Promise<void> {
  const now = new Date("2026-08-20T00:00:00.000Z");
  await database.drizzle.insert(user).values({
    id: "auth-user",
    name: "Auth User",
    email: "auth@example.test",
    emailVerified: true,
    image: null,
    discordUserId: "discord-auth-user",
    createdAt: now,
    updatedAt: now,
  });
  const rows = await database.drizzle.select().from(user);
  assert.equal(rows[0]?.emailVerified, true);
  assert.deepEqual(rows[0]?.createdAt, now);

  const secret = "test-secret-that-is-long-enough-for-better-auth";
  const auth = createPostgresCustomerAuth({
    database,
    betterAuthSecret: secret,
    betterAuthUrl: "https://auth.example.test",
    discordOAuthClientId: "discord-client",
    discordOAuthClientSecret: "discord-secret",
  });
  const response = await auth.handler(
    new Request("https://auth.example.test/api/auth/get-session"),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.json(), null);
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession("auth-user");
  const signature = createHmac("sha256", secret).update(session.token).digest("base64");
  const headers = new Headers({
    cookie: `__Secure-better-auth.session_token=${encodeURIComponent(session.token + "." + signature)}`,
  });
  assert.equal((await auth.api.getSession({ headers }))?.user.id, "auth-user");
  const organization = await auth.api.createOrganization({
    headers,
    body: { name: "Auth workspace", slug: "auth-workspace" },
  });
  assert.ok(organization);
  const invitation = await auth.api.createInvitation({
    headers,
    body: { organizationId: organization.id, email: "invitee@example.test", role: "member" },
  });
  const stored = await database.query<{ createdAt: Date; expiresAt: Date }>(
    'SELECT "createdAt", "expiresAt" FROM "Invitation" WHERE id = $1',
    [invitation.id],
  );
  assert.deepEqual(stored[0]?.createdAt, invitation.createdAt);
  assert.deepEqual(stored[0]?.expiresAt, invitation.expiresAt);
  await auth.api.signOut({ headers });
  assert.equal(await auth.api.getSession({ headers }), null);
}

async function resetTestDatabase(database: PostgresDatabaseCapability): Promise<void> {
  await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
}

function assertSafeTestDatabase(value: string): void {
  const url = new URL(value);
  const databaseName = url.pathname.slice(1);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || !databaseName.endsWith("_test")) {
    throw new Error("PostgreSQL integration tests require a local database ending in _test.");
  }
}
