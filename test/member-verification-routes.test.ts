/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { createMemberVerificationRoutes } from "../src/routes/member-verification-routes";
import {
  MemberVerificationService,
  type MemberVerificationServiceOptions,
} from "../src/services/member-verification-service";
import { DiscordApiError } from "../src/discord/client";
import { signAttemptToken } from "../src/services/member-verification-token";
import type { GuildEntitlementStore, MemberVerificationStore } from "../src/runtime/contracts";
import {
  afterStoreSeed,
  createProductionRuntimeStores,
  type ProductionRuntimeStoresFixture,
  withStoreOverrides,
} from "./support/production-runtime-stores";
import type { MemberVerificationConfig } from "../src/types";
import { createPermissiveGuildResourceValidator } from "./helpers/guild-resource-validator";

const routeFixtures = new Set<ProductionRuntimeStoresFixture>();

test.after(() => {
  for (const fixture of routeFixtures) fixture.close();
  routeFixtures.clear();
});

function createVerificationStore(
  initial: {
    config?: MemberVerificationConfig;
    attempts?: Array<{
      id: string;
      guildId: string;
      userId: string;
      messageId: string | null;
      channelId: string | null;
      createdAtMs: number;
      expiresAtMs: number;
      usedAtMs: number | null;
    }>;
  } = {},
): MemberVerificationStore {
  const fixture = createProductionRuntimeStores();
  routeFixtures.add(fixture);
  const store = fixture.stores.memberVerification;
  const ready = (async () => {
    if (initial.config) await store.upsertConfig(initial.config);
    for (const attempt of initial.attempts ?? []) await store.createVerificationAttempt(attempt);
  })();
  return afterStoreSeed(store, ready);
}

function createEntitlementStore(): GuildEntitlementStore {
  const fixture = createProductionRuntimeStores();
  routeFixtures.add(fixture);
  const ready = fixture.database.d1
    .prepare("INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES (?, ?, ?)")
    .bind("guild-1", "premium", 1)
    .run();
  return afterStoreSeed(fixture.stores.guildEntitlements, ready);
}

function createAuditLogStore() {
  const fixture = createProductionRuntimeStores();
  routeFixtures.add(fixture);
  return fixture.stores.guildAuditLog;
}

function defaultConfig(): MemberVerificationConfig {
  return {
    guildId: "guild-1",
    enabled: true,
    verifiedRoleId: "role-1",
    title: "Welcome",
    description: "Please verify.",
    color: 0x5865f2,
    imageUrl: null,
    thumbnailUrl: null,
    rulesUrl: null,
    verifyButtonEmoji: null,
    deliveryMode: "dm",
    verificationMethod: "turnstile",
    welcomeChannelId: null,
    panelMessageId: null,
    updatedAtMs: Date.now(),
  };
}

async function signedVerifyUrl(
  attempt: { id: string; guildId: string; userId: string; expiresAtMs: number },
  secretKey = "secret-key",
  origin = "https://example.com",
): Promise<string> {
  const signature = await signAttemptToken(attempt, secretKey);
  return `${origin}/verify/${encodeURIComponent(attempt.id)}?sig=${encodeURIComponent(signature)}`;
}

function createRoute(overrides: {
  store?: MemberVerificationStore;
  guildEntitlementStore?: GuildEntitlementStore;
  addGuildMemberRole?: MemberVerificationServiceOptions["addGuildMemberRole"];
  guildMemberHasRole?: MemberVerificationServiceOptions["guildMemberHasRole"];
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;
  verifyTurnstileToken?: (token: string, secretKey: string) => Promise<boolean>;
  customerAuth?: any;
}) {
  const store = overrides.store ?? createVerificationStore({ config: defaultConfig() });
  const service = new MemberVerificationService({
    store,
    guildEntitlementStore: overrides.guildEntitlementStore ?? createEntitlementStore(),
    guildAuditLogStore: createAuditLogStore(),
    guildResources: createPermissiveGuildResourceValidator(),
    discordBotToken: "bot-token",
    addGuildMemberRole: overrides.addGuildMemberRole ?? (async () => {}),
    guildMemberHasRole: overrides.guildMemberHasRole ?? (async () => false),
    resolveGuildName: async () => "Test Guild",
    sendUserDm: async () => ({ id: "dm-1", channel_id: "dm-channel-1", content: "" }),
    createChannelMessage: async () => ({ id: "msg-1", channel_id: "channel-1", content: "" }),
    editChannelMessage: async () => {},
    resolveFooterText: async () => "hafbot.xyz",
  });
  return createMemberVerificationRoutes({
    memberVerificationService: service,
    turnstileSiteKey: overrides.turnstileSiteKey,
    turnstileSecretKey: overrides.turnstileSecretKey ?? "secret-key",
    verifyTurnstileToken: overrides.verifyTurnstileToken,
    customerAuth: overrides.customerAuth as any,
  });
}

test("GET /verify/:id redirects to Discord sign-in when no session exists", async () => {
  const attemptId = "11111111-1111-1111-1111-111111111111";
  const attempt = {
    id: attemptId,
    guildId: "guild-1",
    userId: "user-1",
    messageId: null,
    channelId: null,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 15 * 60 * 1000,
    usedAtMs: null,
  };
  const store = createVerificationStore({
    config: defaultConfig(),
    attempts: [attempt],
  });
  const route = createRoute({ store, turnstileSiteKey: "site-key" });

  const response = await route(new Request(await signedVerifyUrl(attempt)));

  assert.equal(response?.status, 302);
  const location = response?.headers.get("location");
  assert.ok(location?.includes("/api/auth/sign-in/social"));
  assert.ok(location?.includes("provider=discord"));
  assert.ok(decodeURIComponent(location ?? "").includes("sig="));
});

test("GET /verify/:id renders the challenge page for a valid signed-in user", async () => {
  const attemptId = "11111111-1111-1111-1111-111111111111";
  const attempt = {
    id: attemptId,
    guildId: "guild-1",
    userId: "user-1",
    messageId: null,
    channelId: null,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 15 * 60 * 1000,
    usedAtMs: null,
  };
  const store = createVerificationStore({
    config: defaultConfig(),
    attempts: [attempt],
  });
  const customerAuth = {
    api: {
      getSession: async () => ({
        user: { id: "user-1", name: "Test", discordUserId: "user-1" },
      }),
    },
  };
  const route = createRoute({ store, turnstileSiteKey: "site-key", customerAuth });

  const response = await route(
    new Request(await signedVerifyUrl(attempt), {
      headers: { cookie: "session=user-1" },
    }),
  );

  assert.equal(response?.status, 200);
  const body = await response?.text();
  assert.ok(body?.includes("Welcome"));
  assert.ok(body?.includes('data-sitekey="site-key"'));
});

test("POST /verify/:id grants the verified role after a successful Turnstile challenge", async () => {
  const attemptId = "11111111-1111-1111-1111-111111111111";
  const attempt = {
    id: attemptId,
    guildId: "guild-1",
    userId: "user-1",
    messageId: null,
    channelId: null,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 15 * 60 * 1000,
    usedAtMs: null,
  };
  const store = createVerificationStore({
    config: defaultConfig(),
    attempts: [attempt],
  });
  const roleCalls: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const service = new MemberVerificationService({
    store,
    guildEntitlementStore: createEntitlementStore(),
    guildAuditLogStore: createAuditLogStore(),
    guildResources: createPermissiveGuildResourceValidator(),
    discordBotToken: "bot-token",
    addGuildMemberRole: async (guildId, userId, roleId) => {
      roleCalls.push({ guildId, userId, roleId });
    },
    guildMemberHasRole: async () => false,
    resolveGuildName: async () => "Test Guild",
    sendUserDm: async () => ({ id: "dm-1", channel_id: "dm-channel-1", content: "" }),
    createChannelMessage: async () => ({ id: "msg-1", channel_id: "channel-1", content: "" }),
    editChannelMessage: async () => {},
    resolveFooterText: async () => "hafbot.xyz",
  });
  const customerAuth = {
    api: {
      getSession: async () => ({
        user: { id: "user-1", name: "Test", discordUserId: "user-1" },
      }),
    },
  };
  const route = createMemberVerificationRoutes({
    memberVerificationService: service,
    turnstileSiteKey: "site-key",
    turnstileSecretKey: "secret-key",
    verifyTurnstileToken: async () => true,
    customerAuth: customerAuth as any,
  });

  const response = await route(
    new Request(await signedVerifyUrl(attempt), {
      method: "POST",
      body: new URLSearchParams({ "cf-turnstile-response": "token" }),
      headers: { cookie: "session=user-1" },
    }),
  );

  assert.equal(response?.status, 200);
  assert.equal(roleCalls.length, 1);
  assert.deepEqual(roleCalls[0], { guildId: "guild-1", userId: "user-1", roleId: "role-1" });
  assert.match(await response!.text(), /<h1>Verification Complete<\/h1>/);
  assert.ok(await store.readVerificationState("guild-1", "user-1"));

  const updatedAttempt = await store.readVerificationAttempt(attemptId);
  assert.notEqual(updatedAttempt?.usedAtMs, null);
});

for (const scenario of [
  {
    name: "role grant is rejected",
    roleRejected: true,
    expected: /Couldn&#39;t grant your verified role/,
  },
  { name: "verification is disabled", config: { enabled: false }, expected: /not configured/ },
  {
    name: "verified role is removed",
    config: { verifiedRoleId: null },
    expected: /not configured/,
  },
  { name: "paid entitlement is removed", freePlan: true, expected: /requires a paid plan/ },
]) {
  test(`POST /verify/:id reports failure and requires a fresh attempt when ${scenario.name}`, async () => {
    const attempt = {
      id: "22222222-2222-2222-2222-222222222222",
      guildId: "guild-1",
      userId: "user-1",
      messageId: null,
      channelId: null,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 15 * 60 * 1000,
      usedAtMs: null,
    };
    const store = createVerificationStore({ config: defaultConfig(), attempts: [attempt] });
    const entitlementFixture = createProductionRuntimeStores();
    routeFixtures.add(entitlementFixture);
    entitlementFixture.database.execRaw(
      "INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ('guild-1', 'premium', 1)",
    );
    let roleCalls = 0;
    let challengeCalls = 0;
    const route = createRoute({
      store,
      guildEntitlementStore: entitlementFixture.stores.guildEntitlements,
      turnstileSiteKey: "site-key",
      customerAuth: {
        api: { getSession: async () => ({ user: { id: "user-1", discordUserId: "user-1" } }) },
      },
      verifyTurnstileToken: async () => {
        challengeCalls += 1;
        if (scenario.config) await store.upsertConfig({ ...defaultConfig(), ...scenario.config });
        if (scenario.freePlan) {
          entitlementFixture.database.execRaw(
            "UPDATE guild_entitlements SET plan = 'free' WHERE guild_id = 'guild-1'",
          );
        }
        return true;
      },
      addGuildMemberRole: async () => {
        roleCalls += 1;
        if (scenario.roleRejected) throw new DiscordApiError("Missing permissions", 403, "");
      },
    });
    const url = await signedVerifyUrl(attempt);
    assert.equal((await route(new Request(url)))?.status, 200);
    const submit = () =>
      route(
        new Request(url, {
          method: "POST",
          body: new URLSearchParams({ "cf-turnstile-response": "token" }),
        }),
      );

    const response = await submit();
    assert.equal(response?.status, 400);
    const body = await response!.text();
    assert.match(body, /<h1>Verification Failed<\/h1>/);
    assert.match(body, scenario.expected);
    assert.match(body, /Return to Discord and click Verify again to start a new attempt/);
    assert.doesNotMatch(body, /Verification Complete|Try Again|<form|href=/);
    assert.equal(await store.readVerificationState("guild-1", "user-1"), null);
    assert.ok((await store.readVerificationAttempt(attempt.id))?.usedAtMs);
    assert.equal(roleCalls, scenario.roleRejected ? 1 : 0);

    const replay = await submit();
    assert.equal(replay?.status, 400);
    assert.match(await replay!.text(), /already been used/);
    assert.equal(challengeCalls, 1);
    assert.equal(roleCalls, scenario.roleRejected ? 1 : 0);
  });
}

test("POST /verify/:id treats an already-verified member as success without re-granting the role", async () => {
  const attempt = {
    id: "33333333-3333-3333-3333-333333333333",
    guildId: "guild-1",
    userId: "user-1",
    messageId: null,
    channelId: null,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 15 * 60 * 1000,
    usedAtMs: null,
  };
  const store = createVerificationStore({ config: defaultConfig(), attempts: [attempt] });
  const route = createRoute({
    store,
    customerAuth: {
      api: { getSession: async () => ({ user: { id: "user-1", discordUserId: "user-1" } }) },
    },
    verifyTurnstileToken: async () => true,
    guildMemberHasRole: async () => true,
    addGuildMemberRole: async () => assert.fail("must not re-grant the verified role"),
  });
  const response = await route(
    new Request(await signedVerifyUrl(attempt), {
      method: "POST",
      body: new URLSearchParams({ "cf-turnstile-response": "token" }),
    }),
  );

  assert.equal(response?.status, 200);
  const body = await response!.text();
  assert.match(body, /<h1>Verification Complete<\/h1>/);
  assert.match(body, /already verified/);
  assert.ok(await store.readVerificationState("guild-1", "user-1"));
  assert.ok((await store.readVerificationAttempt(attempt.id))?.usedAtMs);
});

test("POST /verify/:id rejects a used attempt", async () => {
  const attemptId = "11111111-1111-1111-1111-111111111111";
  const attempt = {
    id: attemptId,
    guildId: "guild-1",
    userId: "user-1",
    messageId: null,
    channelId: null,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 15 * 60 * 1000,
    usedAtMs: Date.now(),
  };
  const store = createVerificationStore({
    config: defaultConfig(),
    attempts: [attempt],
  });
  const customerAuth = {
    api: {
      getSession: async () => ({
        user: { id: "user-1", name: "Test", discordUserId: "user-1" },
      }),
    },
  };
  const route = createRoute({ store, turnstileSiteKey: "site-key", customerAuth });

  const response = await route(
    new Request(await signedVerifyUrl(attempt), {
      method: "POST",
      body: new URLSearchParams({ "cf-turnstile-response": "token" }),
      headers: { cookie: "session=user-1" },
    }),
  );

  assert.equal(response?.status, 400);
  const body = await response?.text();
  assert.ok(body?.includes("already been used"));
});

test("POST /verify/:id rejects an expired attempt", async () => {
  const attemptId = "11111111-1111-1111-1111-111111111111";
  const attempt = {
    id: attemptId,
    guildId: "guild-1",
    userId: "user-1",
    messageId: null,
    channelId: null,
    createdAtMs: Date.now() - 20 * 60 * 1000,
    expiresAtMs: Date.now() - 60 * 1000,
    usedAtMs: null,
  };
  const store = createVerificationStore({
    config: defaultConfig(),
    attempts: [attempt],
  });
  const customerAuth = {
    api: {
      getSession: async () => ({
        user: { id: "user-1", name: "Test", discordUserId: "user-1" },
      }),
    },
  };
  const route = createRoute({ store, turnstileSiteKey: "site-key", customerAuth });

  const response = await route(
    new Request(await signedVerifyUrl(attempt), {
      method: "POST",
      body: new URLSearchParams({ "cf-turnstile-response": "token" }),
      headers: { cookie: "session=user-1" },
    }),
  );

  assert.equal(response?.status, 400);
  const body = await response?.text();
  assert.ok(body?.includes("expired"));
});

test("POST /verify/:id rejects a concurrent second submission via atomic claim", async () => {
  const attemptId = "77777777-7777-7777-7777-777777777777";
  const attempt = {
    id: attemptId,
    guildId: "guild-1",
    userId: "user-1",
    messageId: null,
    channelId: null,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 15 * 60 * 1000,
    usedAtMs: null,
  };
  const baseStore = createVerificationStore({
    config: defaultConfig(),
    attempts: [attempt],
  });
  const store = withStoreOverrides(baseStore, {
    async tryClaimVerificationAttempt() {
      // Narrow fault injection: simulate a concurrent winner at the atomic claim boundary.
      return false;
    },
  });
  const roleCalls: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const service = new MemberVerificationService({
    store,
    guildEntitlementStore: createEntitlementStore(),
    guildAuditLogStore: createAuditLogStore(),
    guildResources: createPermissiveGuildResourceValidator(),
    discordBotToken: "bot-token",
    addGuildMemberRole: async (guildId, userId, roleId) => {
      roleCalls.push({ guildId, userId, roleId });
    },
    guildMemberHasRole: async () => false,
    resolveGuildName: async () => "Test Guild",
    sendUserDm: async () => ({ id: "dm-1", channel_id: "dm-channel-1", content: "" }),
    createChannelMessage: async () => ({ id: "msg-1", channel_id: "channel-1", content: "" }),
    editChannelMessage: async () => {},
    resolveFooterText: async () => "hafbot.xyz",
  });
  const customerAuth = {
    api: {
      getSession: async () => ({
        user: { id: "user-1", name: "Test", discordUserId: "user-1" },
      }),
    },
  };
  const route = createMemberVerificationRoutes({
    memberVerificationService: service,
    turnstileSiteKey: "site-key",
    turnstileSecretKey: "secret-key",
    verifyTurnstileToken: async () => true,
    customerAuth: customerAuth as any,
  });

  const response = await route(
    new Request(await signedVerifyUrl(attempt), {
      method: "POST",
      body: new URLSearchParams({ "cf-turnstile-response": "token" }),
      headers: { cookie: "session=user-1" },
    }),
  );

  assert.equal(response?.status, 400);
  const body = await response?.text();
  assert.ok(body?.includes("already been used"));
  assert.equal(roleCalls.length, 0);
});

test("POST rejects an attempt expiring during the challenge without delivering a role", async (t) => {
  let nowMs = Date.now();
  const attempt = {
    id: "88888888-8888-8888-8888-888888888888",
    guildId: "guild-1",
    userId: "user-1",
    messageId: null,
    channelId: null,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 900000,
    usedAtMs: null,
  };
  t.mock.method(Date, "now", () => nowMs);
  const store = createVerificationStore({ config: defaultConfig(), attempts: [attempt] });
  const route = createRoute({
    store,
    customerAuth: {
      api: { getSession: async () => ({ user: { id: "user-1", discordUserId: "user-1" } }) },
    },
    verifyTurnstileToken: async () => {
      nowMs = attempt.expiresAtMs;
      return true;
    },
    addGuildMemberRole: async () => assert.fail("expired attempts cannot grant roles"),
  });
  const response = await route(
    new Request(await signedVerifyUrl(attempt), {
      method: "POST",
      body: new URLSearchParams({ "cf-turnstile-response": "token" }),
    }),
  );
  assert.equal(response?.status, 400);
  assert.match(await response!.text(), /expired/);
  assert.equal((await store.readVerificationAttempt(attempt.id))?.usedAtMs, null);
  assert.equal(await store.readVerificationState("guild-1", "user-1"), null);
});
