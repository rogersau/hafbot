/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";
import { getTableColumns } from "drizzle-orm";
import { createHmac } from "node:crypto";

import { session } from "./support/sqlite/db/auth-schema";
import {
  customerAuthUserOptions,
  createCustomerAuth,
  createDiscordSocialProviderConfig,
  mapDiscordProfileToUser,
  rejectDiscordUserIdUpdate,
} from "./support/sqlite/runtime/auth/auth";
import { getCustomerAuthCookieSettings } from "../src/contracts/auth-session-cookie";
import { parseAdditionalUserInputFromProviderProfile } from "better-auth/db";
import { createPostgresCustomerAuth } from "../src/runtime/postgres/postgres-customer-auth";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("SQLite Better Auth initializes and persists invitation creation times", async () => {
  const database = new SqliteD1Database();
  const secret = "sqlite-auth-test-secret-at-least-32-characters";
  try {
    const auth = createCustomerAuth({
      database: database.d1,
      betterAuthSecret: secret,
      betterAuthUrl: "http://localhost:8787",
      discordOAuthClientId: "test-client",
      discordOAuthClientSecret: "test-secret",
    });
    const context = await auth.$context;
    const user = await context.internalAdapter.createUser(
      {
        name: "Invitation owner",
        email: "owner@example.test",
        emailVerified: true,
        discordUserId: "invitation-owner",
      },
      { method: "admin" },
    );
    const session = await context.internalAdapter.createSession(user.id);
    const signature = createHmac("sha256", secret).update(session.token).digest("base64");
    const headers = new Headers({
      cookie: `better-auth.session_token=${encodeURIComponent(session.token + "." + signature)}`,
    });
    const organization = await auth.api.createOrganization({
      headers,
      body: { name: "Invitation workspace", slug: "invitation-workspace" },
    });
    assert.ok(organization);
    const before = Date.now();
    const invitation = await auth.api.createInvitation({
      headers,
      body: { organizationId: organization.id, email: "invitee@example.test", role: "member" },
    });
    assert.ok(
      invitation.createdAt.getTime() >= before && invitation.createdAt.getTime() <= Date.now(),
    );
    const stored = database.query<{ createdAt: string; expiresAt: string }>(
      'SELECT "createdAt", "expiresAt" FROM "Invitation" WHERE id = ?',
      invitation.id,
    )[0];
    assert.ok(stored);
    assert.equal(stored.createdAt, invitation.createdAt.toISOString());
    assert.equal(stored.expiresAt, invitation.expiresAt.toISOString());
  } finally {
    database.close();
  }
});

test("Better Auth sessions include a nullable active organization", () => {
  const activeOrganizationId = getTableColumns(session).activeOrganizationId;

  assert.ok(activeOrganizationId);
  assert.equal(activeOrganizationId.notNull, false);
});

test("customer auth cookie settings match Better Auth secure Set-Cookie naming", () => {
  const secure = getCustomerAuthCookieSettings("https://hafbot.xyz").sessionToken;
  const local = getCustomerAuthCookieSettings("http://localhost:8787").sessionToken;

  assert.equal(secure.name, "__Secure-better-auth.session_token");
  assert.equal(secure.attributes.secure, true);
  assert.equal(local.name, "better-auth.session_token");
  assert.equal(local.attributes.secure, false);
});

test("Discord profile mapping preserves provider fields", () => {
  assert.deepEqual(
    mapDiscordProfileToUser({
      id: "discord-user-1",
      global_name: "Global Name",
      username: "username-one",
      email: "user@example.com",
      verified: true,
      avatar: "avatar-hash",
    }),
    {
      name: "Global Name",
      email: "user@example.com",
      emailVerified: true,
      discordUserId: "discord-user-1",
      image: "https://cdn.discordapp.com/avatars/discord-user-1/avatar-hash.png",
    },
  );
});

test("Discord profile mapping requires provider verification before trusting an email", () => {
  for (const verified of [false, undefined]) {
    const user = mapDiscordProfileToUser({
      id: "discord-user-1",
      email: "unverified@example.com",
      verified,
    });
    assert.equal(user.email, "unverified@example.com");
    assert.equal(user.emailVerified, false);
  }
  assert.equal(
    mapDiscordProfileToUser({ id: "discord-user-1", email: " ", verified: true }).emailVerified,
    false,
  );
});

test("Discord social provider config requests guild discovery scope", () => {
  const provider = createDiscordSocialProviderConfig({
    discordOAuthClientId: "client-id",
    discordOAuthClientSecret: "client-secret",
  });

  assert.deepEqual(provider.scope, ["identify", "email", "guilds"]);
});

test("both customer auth runtimes prevent email matches from merging Discord identities", () => {
  const config = {
    betterAuthSecret: "customer-auth-test-secret-at-least-32-characters",
    betterAuthUrl: "https://hafbot.example",
    discordOAuthClientId: "client-id",
    discordOAuthClientSecret: "client-secret",
  };
  const d1Auth = createCustomerAuth({ ...config, database: {} as D1Database });
  const postgresAuth = createPostgresCustomerAuth({
    ...config,
    database: { drizzle: {} } as never,
  });

  for (const auth of [d1Auth, postgresAuth]) {
    assert.equal(auth.options.account?.accountLinking?.disableImplicitLinking, true);
  }
});

test("Better Auth accepts the mapped Discord user ID during OAuth signup", () => {
  const parsed = parseAdditionalUserInputFromProviderProfile(
    { user: customerAuthUserOptions } as never,
    { discordUserId: "discord-user-1" },
    "create",
  );

  assert.deepEqual({ ...parsed }, { discordUserId: "discord-user-1" });
});

test("customer auth rejects attempts to change the Discord user ID", async () => {
  await assert.rejects(
    () => rejectDiscordUserIdUpdate({ name: "Changed", discordUserId: "attacker-id" }),
    /Discord user ID cannot be updated/,
  );
  await assert.doesNotReject(() => rejectDiscordUserIdUpdate({ name: "Changed" }));
});

test("Discord profile mapping falls back when optional fields are missing", () => {
  assert.deepEqual(
    mapDiscordProfileToUser({
      id: "discord-user-2",
    }),
    {
      name: "Discord user",
      email: "discord-user-2@discord.local",
      emailVerified: false,
      discordUserId: "discord-user-2",
      image: undefined,
    },
  );
});

test("Discord profile mapping rejects missing provider IDs", () => {
  assert.throws(
    () => mapDiscordProfileToUser({ username: "missing-id" }),
    /Discord OAuth profile missing required id field/,
  );
  assert.throws(
    () => mapDiscordProfileToUser({ id: "" }),
    /Discord OAuth profile missing required id field/,
  );
  assert.throws(
    () => mapDiscordProfileToUser({ id: "   " }),
    /Discord OAuth profile missing required id field/,
  );
});

test("Discord profile mapping treats empty optional fields as missing", () => {
  assert.deepEqual(
    mapDiscordProfileToUser({
      id: "discord-user-3",
      global_name: "",
      username: "",
      email: "",
      avatar: "",
    }),
    {
      name: "Discord user",
      email: "discord-user-3@discord.local",
      emailVerified: false,
      discordUserId: "discord-user-3",
      image: undefined,
    },
  );
});

test("Discord profile mapping treats whitespace-only email as missing", () => {
  assert.deepEqual(
    mapDiscordProfileToUser({
      id: "discord-user-4",
      email: "   ",
    }),
    {
      name: "Discord user",
      email: "discord-user-4@discord.local",
      emailVerified: false,
      discordUserId: "discord-user-4",
      image: undefined,
    },
  );
});

test("Discord profile mapping treats whitespace-only avatars as missing", () => {
  assert.deepEqual(
    mapDiscordProfileToUser({
      id: "discord-user-5",
      avatar: "   ",
    }),
    {
      name: "Discord user",
      email: "discord-user-5@discord.local",
      emailVerified: false,
      discordUserId: "discord-user-5",
      image: undefined,
    },
  );
});
