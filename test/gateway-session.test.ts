/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import { buildHeartbeatPayload, buildIdentifyPayload, buildResumePayload } from "../src/gateway";
import { getSlashCommandDefinitions } from "../src/discord-commands";
import { GatewaySessionSqliteDO } from "../src/durable-objects/gateway-session";
import { parseFeatureFlags } from "../src/runtime/features";

import { createLegacyCommunityStoreDatabase } from "./helpers/legacy-community-store-d1";

test("GatewaySessionDO reports idle status before startup", async () => {
  const { state } = createGatewayState();
  const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);

  const response = await gateway.fetch(new Request("https://gateway-session/status"));
  const status = (await response.json()) as Record<string, unknown>;

  assert.equal(status.status, "idle");
  assert.equal(status.sessionId, null);
  assert.equal(status.resumeGatewayUrl, null);
  assert.equal(status.lastSequence, null);
  assert.equal(status.backoffAttempt, 0);
  assert.equal(status.lastError, null);
});

test("GatewaySessionDO starts a fresh websocket session from the default gateway URL", async () => {
  const { state } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);

    const response = await gateway.fetch(
      new Request("https://gateway-session/start", { method: "POST" }),
    );
    const status = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0]?.url, "wss://gateway.discord.gg/?v=10&encoding=json");
    assert.equal(status.status, "connecting");
  } finally {
    restore();
  }
});

test("GatewaySessionDO stop closes the socket, clears resume state, and cancels alarms", async () => {
  const { state, alarmDeletions } = createGatewayState({
    status: "ready",
    session_id: "session-1",
    resume_gateway_url: "wss://resume.example",
    last_sequence: "42",
    heartbeat_interval_ms: "45000",
    backoff_attempt: "2",
    last_error: "previous error",
  });
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    const response = await gateway.fetch(
      new Request("https://gateway-session/stop", { method: "POST" }),
    );
    const status = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(sockets[0]?.readyState, WebSocket.CLOSED);
    assert.equal(status.status, "idle");
    assert.equal(status.sessionId, null);
    assert.equal(status.resumeGatewayUrl, null);
    assert.equal(status.lastSequence, null);
    assert.equal(status.heartbeatIntervalMs, null);
    assert.equal(status.backoffAttempt, 0);
    assert.equal(status.lastError, null);
    assert.equal(alarmDeletions.length, 1);

    await gateway.alarm();
    assert.equal(sockets.length, 1, "an idle stopped gateway must not reconnect from an alarm");
  } finally {
    restore();
  }
});

test("GatewaySessionDO stop cancels a stale alarm when the session is already idle", async () => {
  const { state, alarmDeletions } = createGatewayState({ status: "idle" });
  const gateway = new GatewaySessionSqliteDO(state, {
    DISCORD_BOT_TOKEN: "bot-token",
  } as never);

  const response = await gateway.fetch(
    new Request("https://gateway-session/stop", { method: "POST" }),
  );

  assert.equal(response.status, 200);
  assert.equal(alarmDeletions.length, 1);
});

test("GatewaySessionDO refuses startup when the gateway is disabled", async () => {
  const { state, alarmDeletions } = createGatewayState({ status: "backoff" });
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, {
      DISCORD_BOT_TOKEN: "bot-token",
      GATEWAY_ENABLED: "false",
    } as never);

    const response = await gateway.fetch(
      new Request("https://gateway-session/start", { method: "POST" }),
    );
    const status = (await response.json()) as Record<string, unknown>;

    assert.equal(status.status, "idle");
    assert.equal(sockets.length, 0);
    assert.ok(alarmDeletions.length >= 1);
  } finally {
    restore();
  }
});

test("GatewaySessionDO cleans stale gateway caches when an idle identity is restarted", async () => {
  const { state, messageAuditCleanupQueries } = createGatewayState({ status: "idle" });
  const { restore } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);

    assert.deepEqual(messageAuditCleanupQueries, []);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));
    assert.ok(messageAuditCleanupQueries.length > 0);
  } finally {
    restore();
  }
});

test("GatewaySessionDO sends identify and schedules heartbeat after HELLO", async () => {
  const clock = mockDateNow(1_000);
  const { state, alarms } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitMessage({
      op: 10,
      t: null,
      s: null,
      d: { heartbeat_interval: 45_000 },
    });

    assert.deepEqual(sockets[0]?.sent, [JSON.stringify(buildIdentifyPayload("bot-token"))]);
    assert.deepEqual(alarms, [46_000]);
  } finally {
    restore();
    clock.restore();
  }
});

test("GatewaySessionDO identifies with the token provided on gateway start", async () => {
  const clock = mockDateNow(1_000);
  const { state, alarms } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, {
      DISCORD_BOT_TOKEN: "standard-token",
    } as never);
    await gateway.fetch(
      new Request("https://gateway-session/start", {
        method: "POST",
        headers: { "X-Discord-Bot-Token": "white-label-token" },
      }),
    );

    await sockets[0]?.emitMessage({
      op: 10,
      t: null,
      s: null,
      d: { heartbeat_interval: 45_000 },
    });

    assert.deepEqual(sockets[0]?.sent, [JSON.stringify(buildIdentifyPayload("white-label-token"))]);
    assert.deepEqual(alarms, [46_000]);
  } finally {
    restore();
    clock.restore();
  }
});

test("GatewaySessionDO reports heartbeat interval in its public status snapshot", async () => {
  const { state } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitMessage({
      op: 10,
      t: null,
      s: null,
      d: { heartbeat_interval: 45_000 },
    });

    const response = await gateway.fetch(new Request("https://gateway-session/status"));
    const status = (await response.json()) as Record<string, unknown>;

    assert.equal(status.heartbeatIntervalMs, 45_000);
  } finally {
    restore();
  }
});

test("GatewaySessionDO ignores HELLO frames when the socket is no longer open", async () => {
  const { state, alarms } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    if (sockets[0]) {
      sockets[0].readyState = 2;
    }

    await sockets[0]?.emitMessage({
      op: 10,
      t: null,
      s: null,
      d: { heartbeat_interval: 45_000 },
    });

    assert.deepEqual(sockets[0]?.sent, []);
    assert.deepEqual(alarms, []);
  } finally {
    restore();
  }
});

test("GatewaySessionDO records malformed gateway messages instead of crashing", async () => {
  const { state } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitRawMessage("{");

    const response = await gateway.fetch(new Request("https://gateway-session/status"));
    const status = (await response.json()) as Record<string, unknown>;

    assert.equal(status.lastError, "Failed to parse gateway message");
  } finally {
    restore();
  }
});

test("GatewaySessionDO enqueues handled dispatch events without inline Discord or D1 work", async () => {
  const { state } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();
  const queued: unknown[] = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error("GatewaySessionDO should not call fetch while handling dispatch events");
  };

  state.waitUntil = (promise: Promise<unknown>) => {
    waitUntilPromises.push(promise);
  };

  try {
    const gateway = new GatewaySessionSqliteDO(
      state,
      createGatewayEnv({
        queueSend(message) {
          queued.push(message);
          return Promise.resolve();
        },
      }),
    );
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitMessage({
      op: 0,
      t: "MESSAGE_REACTION_ADD",
      s: 5,
      d: {
        channel_id: "channel-1",
        message_id: "message-1",
        guild_id: "guild-1",
        emoji: { id: null, name: "✅", animated: false },
        user_id: "user-1",
      },
    });
    await Promise.all(waitUntilPromises);

    assert.deepEqual(queued.map(withoutGatewayDeliveryIdentity), [
      {
        type: "MESSAGE_REACTION_ADD",
        data: {
          channel_id: "channel-1",
          message_id: "message-1",
          guild_id: "guild-1",
          emoji: { id: null, name: "✅", animated: false },
          user_id: "user-1",
        },
        previousRoleIds: null,
        botIdentityId: "standard",
        botUserId: "bot-user-id",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("GatewaySessionDO stamps White-Label Bot identity on queued dispatch events", async () => {
  const { state } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();
  const queued: unknown[] = [];
  const waitUntilPromises: Promise<unknown>[] = [];

  state.waitUntil = (promise: Promise<unknown>) => {
    waitUntilPromises.push(promise);
  };

  try {
    const gateway = new GatewaySessionSqliteDO(
      state,
      createGatewayEnv({
        queueSend(message) {
          queued.push(message);
          return Promise.resolve();
        },
      }),
    );
    await gateway.fetch(
      new Request("https://gateway-session/start", {
        method: "POST",
        headers: {
          "X-Gateway-Bot-Identity": "white-label:guild-1",
          "X-Gateway-Bot-User-Id": "white-label-bot-user",
        },
      }),
    );

    await sockets[0]?.emitMessage({
      op: 0,
      t: "GUILD_CREATE",
      s: 5,
      d: { id: "guild-1", name: "Guild One" },
    });
    await Promise.all(waitUntilPromises);

    assert.deepEqual(queued.map(withoutGatewayDeliveryIdentity), [
      {
        type: "GUILD_CREATE",
        data: { id: "guild-1", name: "Guild One" },
        previousRoleIds: null,
        botIdentityId: "white-label:guild-1",
        botUserId: "white-label-bot-user",
      },
    ]);
  } finally {
    restore();
  }
});

test("GatewaySessionDO includes cached previous roles and nicknames when enqueuing member updates and removes", async () => {
  const { state } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();
  const queued: unknown[] = [];
  const waitUntilPromises: Promise<unknown>[] = [];

  state.waitUntil = (promise: Promise<unknown>) => {
    waitUntilPromises.push(promise);
  };

  try {
    const gateway = new GatewaySessionSqliteDO(
      state,
      createGatewayEnv({
        queueSend(message) {
          queued.push(message);
          return Promise.resolve();
        },
      }),
    );
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitMessage({
      op: 0,
      t: "GUILD_MEMBER_UPDATE",
      s: 5,
      d: {
        guild_id: "guild-1",
        user: { id: "user-1" },
        roles: ["role-before"],
        nick: "Before",
      },
    });
    await sockets[0]?.emitMessage({
      op: 0,
      t: "GUILD_MEMBER_UPDATE",
      s: 6,
      d: {
        guild_id: "guild-1",
        user: { id: "user-1" },
        roles: ["role-after"],
        nick: "After",
      },
    });
    await sockets[0]?.emitMessage({
      op: 0,
      t: "GUILD_MEMBER_REMOVE",
      s: 7,
      d: {
        guild_id: "guild-1",
        user: { id: "user-1" },
      },
    });
    await Promise.all(waitUntilPromises);

    assert.deepEqual(
      queued.map(
        (event) => (event as { type: string; previousRoleIds?: string[] | null }).previousRoleIds,
      ),
      [null, ["role-before"], ["role-after"]],
    );
    assert.deepEqual(
      queued.map((event) => (event as { previousNick?: string | null }).previousNick),
      [undefined, "Before", undefined],
    );
  } finally {
    restore();
  }
});

test("GatewaySessionDO retains member attribution for message deletion audit events", async () => {
  const { state } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();
  const queued: unknown[] = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  state.waitUntil = (promise: Promise<unknown>) => waitUntilPromises.push(promise);

  try {
    const gateway = new GatewaySessionSqliteDO(
      state,
      createGatewayEnv({
        queueSend(message) {
          queued.push(message);
          return Promise.resolve();
        },
      }),
    );
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));
    await sockets[0]?.emitMessage({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 5,
      d: {
        id: "message-1",
        guild_id: "guild-1",
        channel_id: "channel-1",
        author: { id: "member-1", username: "Member" },
        member: { roles: ["role-at-message-create"] },
      },
    });
    await sockets[0]?.emitMessage({
      op: 0,
      t: "MESSAGE_UPDATE",
      s: 6,
      d: { id: "message-1", guild_id: "guild-1", channel_id: "channel-1", content: "edited" },
    });
    await sockets[0]?.emitMessage({
      op: 0,
      t: "MESSAGE_DELETE",
      s: 7,
      d: { id: "message-1", guild_id: "guild-1", channel_id: "channel-1" },
    });
    await Promise.all(waitUntilPromises);

    const update = queued[1] as { data: { author?: { id?: string } } };
    const deletion = queued[2] as {
      data: { author?: { id?: string }; member?: { roles?: string[] } };
    };
    assert.equal(update.data.author?.id, "member-1");
    assert.equal(deletion.data.author?.id, "member-1");
    assert.equal(deletion.data.member, undefined);
  } finally {
    restore();
  }
});

test("GatewaySessionDO rate-limits message audit retention cleanup", async () => {
  const clock = mockDateNow(1_000);
  const { state, messageAuditCleanupQueries } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, createGatewayEnv());
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitMessage({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 1,
      d: { id: "message-1", guild_id: "guild-1", author: { id: "member-1" } },
    });
    await sockets[0]?.emitMessage({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 2,
      d: { id: "message-2", guild_id: "guild-1", author: { id: "member-2" } },
    });

    assert.equal(messageAuditCleanupQueries.length, 2, "constructor cleanup should not repeat");

    clock.set(60 * 60 * 1000 + 1_000);
    await sockets[0]?.emitMessage({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 3,
      d: { id: "message-3", guild_id: "guild-1", author: { id: "member-3" } },
    });

    assert.equal(messageAuditCleanupQueries.length, 4, "cleanup should run after one hour");
  } finally {
    restore();
    clock.restore();
  }
});

test('GatewaySessionDO treats DISABLE_BLOCKLIST="false" as enabled while enqueuing dispatch events', async () => {
  const { state } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();
  const queued: unknown[] = [];
  const waitUntilPromises: Promise<unknown>[] = [];

  state.waitUntil = (promise: Promise<unknown>) => {
    waitUntilPromises.push(promise);
  };

  try {
    const gateway = new GatewaySessionSqliteDO(
      state,
      createGatewayEnv({
        DISABLE_BLOCKLIST: "false",
        queueSend(message) {
          queued.push(message);
          return Promise.resolve();
        },
      }),
    );
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitMessage({
      op: 0,
      t: "MESSAGE_REACTION_ADD",
      s: 5,
      d: {
        channel_id: "channel-1",
        message_id: "message-1",
        guild_id: "guild-1",
        emoji: { id: null, name: "✅", animated: false },
        user_id: "user-1",
      },
    });
    await Promise.all(waitUntilPromises);

    assert.equal(queued.length, 1);
  } finally {
    restore();
  }
});

test("GatewaySessionDO includes the emptied voice channel when a user leaves", async () => {
  const { state } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();
  const queued: unknown[] = [];
  const waitUntilPromises: Promise<unknown>[] = [];

  state.waitUntil = (promise: Promise<unknown>) => {
    waitUntilPromises.push(promise);
  };

  try {
    const gateway = new GatewaySessionSqliteDO(
      state,
      createGatewayEnv({
        queueSend(message) {
          queued.push(message);
          return Promise.resolve();
        },
      }),
    );
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitMessage({
      op: 0,
      t: "VOICE_STATE_UPDATE",
      s: 5,
      d: { guild_id: "guild-1", user_id: "user-1", channel_id: "voice-channel-1" },
    });
    await sockets[0]?.emitMessage({
      op: 0,
      t: "VOICE_STATE_UPDATE",
      s: 6,
      d: { guild_id: "guild-1", user_id: "user-1", channel_id: null },
    });
    await Promise.all(waitUntilPromises);

    assert.equal(
      (queued[0] as { emptiedVoiceChannelId?: string | null }).emptiedVoiceChannelId,
      null,
    );
    assert.equal(
      (queued[1] as { emptiedVoiceChannelId?: string | null }).emptiedVoiceChannelId,
      "voice-channel-1",
    );
  } finally {
    restore();
  }
});

test("GatewaySessionDO enqueues guild lifecycle dispatch events", async () => {
  const { state } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();
  const queued: unknown[] = [];
  const waitUntilPromises: Promise<unknown>[] = [];

  state.waitUntil = (promise: Promise<unknown>) => {
    waitUntilPromises.push(promise);
  };

  try {
    const gateway = new GatewaySessionSqliteDO(
      state,
      createGatewayEnv({
        queueSend(message) {
          queued.push(message);
          return Promise.resolve();
        },
      }),
    );
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitMessage({
      op: 0,
      t: "GUILD_CREATE",
      s: 7,
      d: {
        id: "guild-1",
        name: "Guild One",
      },
    });
    await Promise.all(waitUntilPromises);

    assert.deepEqual(queued.map(withoutGatewayDeliveryIdentity), [
      {
        type: "GUILD_CREATE",
        data: {
          id: "guild-1",
          name: "Guild One",
        },
        botIdentityId: "standard",
        botUserId: "bot-user-id",
        previousRoleIds: null,
      },
    ]);
  } finally {
    restore();
  }
});

test("parseFeatureFlags only disables features for true-like values", () => {
  assert.deepEqual(
    parseFeatureFlags({
      DISABLE_LFG: "true",
      DISABLE_MARKETPLACE: "1",
      DISABLE_TICKETS: "yes",
      DISABLE_BLOCKLIST: "false",
      DISABLE_TIMED_ROLES: "0",
      DISABLE_ADMIN_UI: "no",
    }),
    {
      lfg: false,
      marketplace: false,
      tickets: false,
      blocklist: true,
      timedRoles: true,
      webhookProxy: true,
      adminUi: true,
      playerCount: true,
      steamLink: true,
      xboxLink: true,
      playstationLink: true,
      evidenceVault: true,
      imageRules: true,
      banCases: true,
      botDefense: true,
      mentionProtection: true,
      memberVerification: true,
      events: true,
      clans: true,
      suggestions: true,
      serverLevels: true,
      reactionRoles: true,
    },
  );
  assert.equal(parseFeatureFlags({ DISABLE_REACTION_ROLES: "true" }).reactionRoles, false);
});

test("getSlashCommandDefinitions filters disabled features out of slash sync", () => {
  const commands = getSlashCommandDefinitions({
    lfg: false,
    marketplace: true,
    tickets: false,
    blocklist: true,
    timedRoles: false,
    webhookProxy: true,
    adminUi: true,
    playerCount: false,
    steamLink: false,
    xboxLink: false,
    playstationLink: false,
    evidenceVault: false,
    imageRules: false,
    banCases: false,
    botDefense: false,
    mentionProtection: false,
    memberVerification: false,
    events: false,
    clans: false,
    serverLevels: false,
  });

  assert.deepEqual(
    commands.map((command) => command.name),
    ["custom", "Report Message", "rep", "mod", "help", "blocklist", "haf-admin"],
  );
});

test("GatewaySessionDO resumes persisted sessions after HELLO", async () => {
  const clock = mockDateNow(5_000);
  const { state, alarms } = createGatewayState({
    session_id: "session-1",
    resume_gateway_url: "wss://resume.discord.gg/?v=10&encoding=json",
    last_sequence: "42",
  });
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    assert.equal(sockets[0]?.url, "wss://resume.discord.gg/?v=10&encoding=json");

    await sockets[0]?.emitMessage({
      op: 10,
      t: null,
      s: null,
      d: { heartbeat_interval: 30_000 },
    });

    assert.deepEqual(sockets[0]?.sent, [
      JSON.stringify(buildResumePayload("bot-token", "session-1", 42)),
    ]);
    assert.deepEqual(alarms, [35_000]);
  } finally {
    restore();
    clock.restore();
  }
});

test("GatewaySessionDO schedules an immediate resume after restoring a ready session without a socket", async () => {
  const clock = mockDateNow(5_000);
  const { state, alarms } = createGatewayState({
    status: "ready",
    session_id: "session-1",
    resume_gateway_url: "wss://resume.discord.gg/?v=10&encoding=json",
    last_sequence: "42",
  });
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);

    assert.deepEqual(alarms, [6_000]);

    clock.set(6_000);
    await gateway.alarm();

    assert.equal(sockets.length, 1);
    assert.equal(sockets[0]?.url, "wss://resume.discord.gg/?v=10&encoding=json");
  } finally {
    restore();
    clock.restore();
  }
});

test("GatewaySessionDO persists READY metadata and reports ready status", async () => {
  const { state } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitMessage({
      op: 0,
      t: "READY",
      s: 99,
      d: {
        session_id: "session-99",
        resume_gateway_url: "wss://resume.discord.gg/?v=10&encoding=json",
      },
    });

    const response = await gateway.fetch(new Request("https://gateway-session/status"));
    const status = (await response.json()) as Record<string, unknown>;

    assert.equal(status.status, "ready");
    assert.equal(status.sessionId, "session-99");
    assert.equal(status.resumeGatewayUrl, "wss://resume.discord.gg/?v=10&encoding=json");
    assert.equal(status.lastSequence, 99);
    assert.equal(status.backoffAttempt, 0);
  } finally {
    restore();
  }
});

test("GatewaySessionDO alarm sends a heartbeat with the last known sequence", async () => {
  const clock = mockDateNow(10_000);
  const { state } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitMessage({
      op: 10,
      t: null,
      s: null,
      d: { heartbeat_interval: 45_000 },
    });
    await sockets[0]?.emitMessage({
      op: 0,
      t: "READY",
      s: 12,
      d: {
        session_id: "session-12",
        resume_gateway_url: "wss://resume.discord.gg/?v=10&encoding=json",
      },
    });

    await gateway.alarm();

    assert.equal(sockets[0]?.sent.at(-1), JSON.stringify(buildHeartbeatPayload(12)));
  } finally {
    restore();
    clock.restore();
  }
});

test("GatewaySessionDO heartbeat send failures update status and reschedule alarms", async () => {
  const clock = mockDateNow(1_000);
  const { state, alarms } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitMessage({
      op: 10,
      t: null,
      s: null,
      d: { heartbeat_interval: 45_000 },
    });
    clock.set(46_000);
    if (sockets[0]) {
      sockets[0].readyState = 2;
    }

    await gateway.alarm();

    const response = await gateway.fetch(new Request("https://gateway-session/status"));
    const status = (await response.json()) as Record<string, unknown>;

    assert.equal(status.lastError, "Failed to send heartbeat");
    assert.deepEqual(alarms, [46_000, 91_000]);
  } finally {
    restore();
    clock.restore();
  }
});

test("GatewaySessionDO clears non-resumable sessions and schedules reconnect on invalid session", async () => {
  const clock = mockDateNow(20_000);
  const { state, alarms } = createGatewayState({
    session_id: "session-1",
    resume_gateway_url: "wss://resume.discord.gg/?v=10&encoding=json",
    last_sequence: "9",
  });
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitMessage({
      op: 9,
      t: null,
      s: null,
      d: false,
    });

    const response = await gateway.fetch(new Request("https://gateway-session/status"));
    const status = (await response.json()) as Record<string, unknown>;

    assert.equal(status.status, "backoff");
    assert.equal(status.sessionId, null);
    assert.equal(status.resumeGatewayUrl, null);
    assert.equal(status.lastSequence, null);
    assert.equal(status.backoffAttempt, 1);
    assert.deepEqual(alarms, [21_000]);
  } finally {
    restore();
    clock.restore();
  }
});

test("GatewaySessionDO reconnects after invalid sessions close the current socket", async () => {
  const clock = mockDateNow(20_000);
  const { state } = createGatewayState({
    session_id: "session-1",
    resume_gateway_url: "wss://resume.discord.gg/?v=10&encoding=json",
    last_sequence: "9",
  });
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));
    await sockets[0]?.emitMessage({
      op: 9,
      t: null,
      s: null,
      d: false,
    });

    assert.equal(sockets[0]?.readyState, 3);

    clock.set(21_000);
    await gateway.alarm();

    assert.equal(sockets.length, 2);
  } finally {
    restore();
    clock.restore();
  }
});

test("GatewaySessionDO unexpected close events enter backoff and reconnect on alarm", async () => {
  const clock = mockDateNow(30_000);
  const { state, alarms } = createGatewayState();
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitClose();

    const statusResponse = await gateway.fetch(new Request("https://gateway-session/status"));
    const status = (await statusResponse.json()) as Record<string, unknown>;

    assert.equal(status.status, "backoff");
    assert.equal(status.backoffAttempt, 1);
    assert.deepEqual(alarms, [31_000]);

    clock.set(31_000);
    await gateway.alarm();

    assert.equal(sockets.length, 2);
  } finally {
    restore();
    clock.restore();
  }
});

test("GatewaySessionDO websocket errors enter backoff and reconnect on alarm", async () => {
  const clock = mockDateNow(35_000);
  const { state, alarms } = createGatewayState({
    session_id: "session-1",
    resume_gateway_url: "wss://resume.discord.gg/?v=10&encoding=json",
    last_sequence: "9",
  });
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));

    await sockets[0]?.emitError();

    const statusResponse = await gateway.fetch(new Request("https://gateway-session/status"));
    const status = (await statusResponse.json()) as Record<string, unknown>;

    assert.equal(status.status, "backoff");
    assert.equal(status.lastError, "Gateway websocket error");
    assert.equal(status.backoffAttempt, 1);
    assert.deepEqual(alarms, [36_000]);

    clock.set(36_000);
    await gateway.alarm();

    assert.equal(sockets.length, 2);
    assert.equal(sockets[1]?.url, "wss://resume.discord.gg/?v=10&encoding=json");
  } finally {
    restore();
    clock.restore();
  }
});

test("GatewaySessionDO ignores stale close events from an old socket", async () => {
  const clock = mockDateNow(40_000);
  const { state, alarms } = createGatewayState({
    session_id: "session-1",
    resume_gateway_url: "wss://resume.discord.gg/?v=10&encoding=json",
    last_sequence: "9",
  });
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));
    await sockets[0]?.emitMessage({
      op: 9,
      t: null,
      s: null,
      d: true,
    });

    assert.deepEqual(alarms, [41_000]);

    clock.set(41_000);
    await gateway.alarm();
    assert.equal(sockets.length, 2, "alarm should open a replacement websocket");

    await sockets[0]?.emitClose();

    const response = await gateway.fetch(new Request("https://gateway-session/status"));
    const status = (await response.json()) as Record<string, unknown>;

    assert.equal(status.status, "resuming");
    assert.equal(status.backoffAttempt, 1);
    assert.deepEqual(alarms, [41_000]);
  } finally {
    restore();
    clock.restore();
  }
});

test("GatewaySessionDO ignores stale HELLO messages from an old socket after reconnect", async () => {
  const clock = mockDateNow(50_000);
  const { state, alarms } = createGatewayState({
    session_id: "session-1",
    resume_gateway_url: "wss://resume.discord.gg/?v=10&encoding=json",
    last_sequence: "9",
  });
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));
    await sockets[0]?.emitMessage({
      op: 9,
      t: null,
      s: null,
      d: true,
    });

    clock.set(51_000);
    await gateway.alarm();
    assert.equal(sockets.length, 2, "alarm should open a replacement websocket");

    await sockets[0]?.emitMessage({
      op: 10,
      t: null,
      s: null,
      d: { heartbeat_interval: 45_000 },
    });

    assert.deepEqual(
      sockets[1]?.sent,
      [],
      "stale HELLO from the old socket should not drive the active websocket",
    );
    assert.deepEqual(alarms, [51_000]);
  } finally {
    restore();
    clock.restore();
  }
});

test("GatewaySessionDO ignores stale error events from an old socket after reconnect", async () => {
  const clock = mockDateNow(60_000);
  const { state } = createGatewayState({
    session_id: "session-1",
    resume_gateway_url: "wss://resume.discord.gg/?v=10&encoding=json",
    last_sequence: "9",
  });
  const { restore, sockets } = installFakeWebSocket();

  try {
    const gateway = new GatewaySessionSqliteDO(state, { DISCORD_BOT_TOKEN: "bot-token" } as never);
    await gateway.fetch(new Request("https://gateway-session/start", { method: "POST" }));
    await sockets[0]?.emitMessage({
      op: 9,
      t: null,
      s: null,
      d: true,
    });

    clock.set(61_000);
    await gateway.alarm();
    const statusBeforeError = await gateway.fetch(new Request("https://gateway-session/status"));
    const previous = (await statusBeforeError.json()) as Record<string, unknown>;

    await sockets[0]?.emitError();

    const statusAfterError = await gateway.fetch(new Request("https://gateway-session/status"));
    const current = (await statusAfterError.json()) as Record<string, unknown>;

    assert.equal(current.lastError, previous.lastError);
  } finally {
    restore();
    clock.restore();
  }
});

function createGatewayState(initialValues?: Record<string, string>) {
  const stateMap = new Map<string, string>(Object.entries(initialValues ?? {}));
  const memberRoles = new Map<string, string>();
  const memberNicks = new Map<string, string>();
  const messageAuditContexts = new Map<string, { guild_id: string; author_json: string }>();
  const voiceStates = new Map<string, string>();
  const alarms: number[] = [];
  const alarmDeletions: true[] = [];
  const messageAuditCleanupQueries: string[] = [];

  return {
    alarms,
    alarmDeletions,
    messageAuditCleanupQueries,
    state: {
      storage: {
        sql: {
          exec(query: string, ...params: unknown[]) {
            if (query.includes("CREATE TABLE IF NOT EXISTS gateway_state")) {
              return [];
            }

            if (
              query ===
              "SELECT channel_id FROM gateway_voice_states WHERE guild_id = ? AND user_id = ? LIMIT 1"
            ) {
              const channel_id = voiceStates.get(`${params[0]}:${params[1]}`);
              return (channel_id ? [{ channel_id }] : [])[Symbol.iterator]();
            }

            if (
              query ===
              "INSERT INTO gateway_voice_states(guild_id, user_id, channel_id) VALUES(?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET channel_id = excluded.channel_id"
            ) {
              voiceStates.set(`${params[0]}:${params[1]}`, params[2] as string);
              return [];
            }

            if (query === "DELETE FROM gateway_voice_states WHERE guild_id = ? AND user_id = ?") {
              voiceStates.delete(`${params[0]}:${params[1]}`);
              return [];
            }

            if (
              query ===
              "SELECT COUNT(*) AS count FROM gateway_voice_states WHERE guild_id = ? AND channel_id = ?"
            ) {
              const count = [...voiceStates.entries()].filter(
                ([key, channelId]) => key.startsWith(`${params[0]}:`) && channelId === params[1],
              ).length;
              return [{ count }][Symbol.iterator]();
            }

            if (
              query ===
              "SELECT guild_id, author_json FROM gateway_message_audit_context WHERE message_id = ? LIMIT 1"
            ) {
              const context = messageAuditContexts.get(params[0] as string);
              return (context ? [context] : [])[Symbol.iterator]();
            }

            if (
              query ===
              "INSERT INTO gateway_message_audit_context(message_id, guild_id, author_json, updated_at_ms) VALUES(?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET guild_id = excluded.guild_id, author_json = excluded.author_json, updated_at_ms = excluded.updated_at_ms"
            ) {
              messageAuditContexts.set(params[0] as string, {
                guild_id: params[1] as string,
                author_json: params[2] as string,
              });
              return [];
            }

            if (query === "DELETE FROM gateway_message_audit_context WHERE message_id = ?") {
              messageAuditContexts.delete(params[0] as string);
              return [];
            }

            if (query.startsWith("DELETE FROM gateway_message_audit_context WHERE updated_at_ms")) {
              messageAuditCleanupQueries.push(query);
              return [];
            }

            if (
              query.startsWith(
                "DELETE FROM gateway_message_audit_context WHERE message_id IN (SELECT",
              )
            ) {
              messageAuditCleanupQueries.push(query);
              return [];
            }

            if (
              query ===
              "SELECT nick_json FROM gateway_member_nicks WHERE guild_id = ? AND user_id = ? LIMIT 1"
            ) {
              const nick_json = memberNicks.get(`${params[0]}:${params[1]}`);
              return (nick_json ? [{ nick_json }] : [])[Symbol.iterator]();
            }

            if (
              query ===
              "INSERT INTO gateway_member_nicks(guild_id, user_id, nick_json) VALUES(?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET nick_json = excluded.nick_json"
            ) {
              memberNicks.set(`${params[0]}:${params[1]}`, params[2] as string);
              return [];
            }

            if (query === "DELETE FROM gateway_member_nicks WHERE guild_id = ? AND user_id = ?") {
              memberNicks.delete(`${params[0]}:${params[1]}`);
              return [];
            }

            if (
              query ===
              "SELECT role_ids_json FROM gateway_member_roles WHERE guild_id = ? AND user_id = ? LIMIT 1"
            ) {
              const role_ids_json = memberRoles.get(`${params[0]}:${params[1]}`);
              return (role_ids_json ? [{ role_ids_json }] : [])[Symbol.iterator]();
            }

            if (
              query ===
              "INSERT INTO gateway_member_roles(guild_id, user_id, role_ids_json) VALUES(?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET role_ids_json = excluded.role_ids_json"
            ) {
              memberRoles.set(`${params[0]}:${params[1]}`, params[2] as string);
              return [];
            }

            if (query === "DELETE FROM gateway_member_roles WHERE guild_id = ? AND user_id = ?") {
              memberRoles.delete(`${params[0]}:${params[1]}`);
              return [];
            }

            if (
              query ===
              "INSERT INTO gateway_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            ) {
              stateMap.set(params[0] as string, params[1] as string);
              return [];
            }

            if (query === "DELETE FROM gateway_state WHERE key = ?") {
              stateMap.delete(params[0] as string);
              return [];
            }

            if (query === "SELECT key, value FROM gateway_state") {
              return [...stateMap.entries()].map(([key, value]) => ({ key, value }));
            }

            throw new Error(`Unexpected SQL: ${query}`);
          },
        },
        setAlarm(time: number) {
          alarms.push(time);
          return Promise.resolve();
        },
        deleteAlarm() {
          alarmDeletions.push(true);
          return Promise.resolve();
        },
      },
      blockConcurrencyWhile<T>(callback: () => Promise<T>) {
        return callback();
      },
    } as unknown as DurableObjectState,
  };
}

function createGatewayEnv(options?: {
  DISABLE_BLOCKLIST?: string;
  GLOBAL_ADMIN_LOG_CHANNEL_ID?: string;
  queueSend?: (message: unknown) => Promise<void>;
  moderationStoreFetch?: (input: Request | string | URL, init?: RequestInit) => Response;
}) {
  return {
    DISCORD_BOT_TOKEN: "bot-token",
    BOT_USER_ID: "bot-user-id",
    DISABLE_BLOCKLIST: options?.DISABLE_BLOCKLIST,
    GLOBAL_ADMIN_LOG_CHANNEL_ID: options?.GLOBAL_ADMIN_LOG_CHANNEL_ID,
    GATEWAY_EVENT_QUEUE: {
      send(message: unknown) {
        return options?.queueSend ? options.queueSend(message) : Promise.resolve();
      },
    },
    HAF_DB: createLegacyCommunityStoreDatabase({
      moderationFetch: options?.moderationStoreFetch,
    }),

    GATEWAY_SESSION_DO: {
      idFromName() {
        return "gateway-id" as never;
      },
      get() {
        return {
          fetch: async () => Response.json({ status: "idle" }),
        };
      },
    } as never,
  } as never;
}

function installFakeWebSocket() {
  const originalWebSocket = globalThis.WebSocket;
  const sockets: FakeWebSocket[] = [];

  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly url: string;
    readonly sent: string[] = [];
    readonly listeners = new Map<string, Array<(event: unknown) => void>>();
    accepted = false;
    readyState = FakeWebSocket.CONNECTING;

    constructor(url: string) {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      sockets.push(this);
    }

    accept() {
      this.accepted = true;
      this.readyState = FakeWebSocket.OPEN;
    }

    addEventListener(type: string, listener: (event: unknown) => void) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    send(message: string) {
      if (this.readyState !== FakeWebSocket.OPEN) {
        throw new Error("WebSocket is not open");
      }
      this.sent.push(message);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }

    async emitMessage(data: unknown) {
      for (const listener of this.listeners.get("message") ?? []) {
        await listener({ data: JSON.stringify(data) });
      }
    }

    async emitRawMessage(data: string) {
      for (const listener of this.listeners.get("message") ?? []) {
        await listener({ data });
      }
    }

    async emitClose() {
      this.readyState = FakeWebSocket.CLOSED;
      for (const listener of this.listeners.get("close") ?? []) {
        await listener({});
      }
    }

    async emitError() {
      for (const listener of this.listeners.get("error") ?? []) {
        await listener({});
      }
    }
  }

  globalThis.WebSocket = FakeWebSocket as never;

  return {
    sockets,
    restore() {
      globalThis.WebSocket = originalWebSocket;
    },
  };
}

function mockDateNow(now: number) {
  const originalNow = Date.now;
  let current = now;
  Date.now = () => current;

  return {
    set(nextNow: number) {
      current = nextNow;
    },
    restore() {
      Date.now = originalNow;
    },
  };
}

function withoutGatewayDeliveryIdentity(value: unknown): Record<string, unknown> {
  const envelope = value as {
    version?: unknown;
    eventKey?: unknown;
    receivedAtMs?: unknown;
    sessionId?: unknown;
    sequence?: unknown;
  } & Record<string, unknown>;
  assert.equal(envelope.version, 2);
  assert.match(
    String(envelope.eventKey),
    /^v2:[A-Za-z0-9_.:-]+:[A-Z_]+:(?:[A-Za-z0-9_.:-]+:\d+|[a-f0-9]{64})$/,
  );
  assert.equal(envelope.sessionId === null || typeof envelope.sessionId === "string", true);
  assert.equal(envelope.sequence === null || typeof envelope.sequence === "number", true);
  assert.equal(typeof envelope.receivedAtMs, "number");
  const {
    version: _version,
    eventKey: _eventKey,
    receivedAtMs: _receivedAtMs,
    sessionId: _sessionId,
    sequence: _sequence,
    ...rest
  } = envelope;
  return rest;
}
