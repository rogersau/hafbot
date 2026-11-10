/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { createCloudflareMemberVerificationStore } from "../src/runtime/cloudflare-member-verification-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";
import type { MemberVerificationConfig } from "../src/types";

test("MemberVerificationStore persists and reads verification attempts", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMemberVerificationStore(database as unknown as D1Database);
  await store.upsertConfig({
    guildId: "guild-1",
    enabled: true,
    verifiedRoleId: "role-1",
    title: "Welcome",
    description: "Verify",
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
  } as MemberVerificationConfig);

  const attempt = {
    id: "11111111-1111-1111-1111-111111111111",
    guildId: "guild-1",
    userId: "user-1",
    messageId: null,
    channelId: null,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 15 * 60 * 1000,
    usedAtMs: null,
  };
  await store.createVerificationAttempt(attempt);

  const read = await store.readVerificationAttempt(attempt.id);
  assert.deepEqual(read, attempt);

  const active = await store.listActiveVerificationAttempts("guild-1", "user-1");
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, attempt.id);
});

test("MemberVerificationStore updateVerificationAttempt records usedAtMs", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMemberVerificationStore(database as unknown as D1Database);

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
  await store.createVerificationAttempt(attempt);

  await store.updateVerificationAttempt({ ...attempt, usedAtMs: Date.now() });

  const active = await store.listActiveVerificationAttempts("guild-1", "user-1");
  assert.equal(active.length, 0);

  const read = await store.readVerificationAttempt(attempt.id);
  assert.notEqual(read?.usedAtMs, null);
});

test("MemberVerificationStore deleteVerificationAttempt removes the attempt", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMemberVerificationStore(database as unknown as D1Database);

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
  await store.createVerificationAttempt(attempt);
  await store.deleteVerificationAttempt(attempt.id);

  const read = await store.readVerificationAttempt(attempt.id);
  assert.equal(read, null);
});

test("MemberVerificationStore listActiveVerificationAttempts excludes expired attempts", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMemberVerificationStore(database as unknown as D1Database);

  const activeAttempt = {
    id: "44444444-4444-4444-4444-444444444444",
    guildId: "guild-1",
    userId: "user-1",
    messageId: null,
    channelId: null,
    createdAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 60 * 1000,
    usedAtMs: null,
  };
  const expiredAttempt = {
    id: "55555555-5555-5555-5555-555555555555",
    guildId: "guild-1",
    userId: "user-1",
    messageId: null,
    channelId: null,
    createdAtMs: Date.now() - 20 * 60 * 1000,
    expiresAtMs: Date.now() - 60 * 1000,
    usedAtMs: null,
  };
  await store.createVerificationAttempt(activeAttempt);
  await store.createVerificationAttempt(expiredAttempt);

  const active = await store.listActiveVerificationAttempts("guild-1", "user-1");
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, activeAttempt.id);
});

test("MemberVerificationStore reads verification_method from config", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMemberVerificationStore(database as unknown as D1Database);
  const config: MemberVerificationConfig = {
    guildId: "guild-1",
    enabled: true,
    verifiedRoleId: "role-1",
    title: "Welcome",
    description: "Verify",
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
  await store.upsertConfig(config);

  const read = await store.readConfig("guild-1");
  assert.equal(read?.verificationMethod, "turnstile");
});

test("MemberVerificationStore normalizes unknown verification_method to discord-button", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMemberVerificationStore(database as unknown as D1Database);

  await (database as unknown as { exec: (sql: string) => Promise<void> }).exec(
    `INSERT INTO member_verification_configs (
      guild_id, enabled, verified_role_id, title, description, color,
      delivery_mode, verification_method, updated_at_ms
    ) VALUES ('guild-bad', 1, 'role-1', 'Welcome', 'Verify', 0, 'dm', 'unknown-method', 1)`,
  );

  const read = await store.readConfig("guild-bad");
  assert.equal(read?.verificationMethod, "discord-button");
});

test("MemberVerificationStore tryClaimVerificationAttempt is atomic and one-use", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMemberVerificationStore(database as unknown as D1Database);

  const attempt = {
    id: "66666666-6666-6666-6666-666666666666",
    guildId: "guild-1",
    userId: "user-1",
    messageId: null,
    channelId: null,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 15 * 60 * 1000,
    usedAtMs: null,
  };
  await store.createVerificationAttempt(attempt);

  const firstClaim = await store.tryClaimVerificationAttempt(attempt.id, Date.now());
  assert.equal(firstClaim, true);

  const secondClaim = await store.tryClaimVerificationAttempt(attempt.id, Date.now());
  assert.equal(secondClaim, false);

  const read = await store.readVerificationAttempt(attempt.id);
  assert.notEqual(read?.usedAtMs, null);
});

test("MemberVerificationStore durably limits manual DMs and resets the window", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMemberVerificationStore(database as unknown as D1Database);
  const input = {
    guildId: "guild-1",
    scopeType: "target" as const,
    scopeId: "member-1",
    nowMs: 1_000,
    windowMs: 300_000,
    limit: 1,
  };

  assert.deepEqual(await store.consumeManualDmRateLimit(input), {
    allowed: true,
    retryAfterMs: 300_000,
  });
  assert.deepEqual(await store.consumeManualDmRateLimit({ ...input, nowMs: 2_000 }), {
    allowed: false,
    retryAfterMs: 299_000,
  });
  assert.deepEqual(await store.consumeManualDmRateLimit({ ...input, nowMs: 301_000 }), {
    allowed: true,
    retryAfterMs: 300_000,
  });
});

test("MemberVerificationStore rejects expiry at the atomic claim boundary", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareMemberVerificationStore(database as unknown as D1Database);
  const attempt = {
    id: "77777777-7777-7777-7777-777777777777",
    guildId: "guild-1",
    userId: "user-1",
    messageId: null,
    channelId: null,
    createdAtMs: 100,
    expiresAtMs: 200,
    usedAtMs: null,
  };
  await store.createVerificationAttempt(attempt);
  assert.equal(await store.tryClaimVerificationAttempt(attempt.id, 200), false);
  assert.equal(await store.tryClaimVerificationAttempt(attempt.id, 201), false);
  assert.equal((await store.readVerificationAttempt(attempt.id))?.usedAtMs, null);
});
