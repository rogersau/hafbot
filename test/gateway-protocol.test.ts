/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import {
  buildHeartbeatPayload,
  buildIdentifyPayload,
  buildResumePayload,
  nextBackoffMillis,
  shouldHandleDispatch,
} from "../src/gateway";

test("buildIdentifyPayload includes the MESSAGE_CONTENT intent", () => {
  const intents = buildIdentifyPayload("bot-token").d.intents;
  const MESSAGE_CONTENT_INTENT = 1 << 15;
  assert.ok(intents & MESSAGE_CONTENT_INTENT);
});

test("buildIdentifyPayload creates the expected gateway identify frame", () => {
  assert.deepEqual(buildIdentifyPayload("bot-token"), {
    op: 2,
    d: {
      token: "bot-token",
      intents: 34435,
      properties: {
        os: "cloudflare",
        browser: "haf-bot",
        device: "haf-bot",
      },
    },
  });
});

test("buildResumePayload creates the expected gateway resume frame", () => {
  assert.deepEqual(buildResumePayload("bot-token", "session-1", 42), {
    op: 6,
    d: {
      token: "bot-token",
      session_id: "session-1",
      seq: 42,
    },
  });
});

test("buildHeartbeatPayload includes the last known sequence", () => {
  assert.deepEqual(buildHeartbeatPayload(42), {
    op: 1,
    d: 42,
  });
});

test("buildHeartbeatPayload uses null when no sequence is known", () => {
  assert.deepEqual(buildHeartbeatPayload(null), {
    op: 1,
    d: null,
  });
});

test("shouldHandleDispatch returns true for message reaction add events", () => {
  assert.equal(
    shouldHandleDispatch({
      op: 0,
      t: "MESSAGE_REACTION_ADD",
      s: 101,
      d: { message_id: "message-1" },
    }),
    true,
  );
});

test("shouldHandleDispatch forwards reaction removals for reaction-role revocation", () => {
  assert.equal(
    shouldHandleDispatch({
      op: 0,
      t: "MESSAGE_REACTION_REMOVE",
      s: 102,
      d: { message_id: "message-1" },
    }),
    true,
  );
});

test("shouldHandleDispatch returns true for message create events", () => {
  assert.equal(
    shouldHandleDispatch({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 202,
      d: { id: "message-2", content: "hello" },
    }),
    true,
  );
});

test("shouldHandleDispatch returns true for message update and delete events", () => {
  assert.equal(
    shouldHandleDispatch({
      op: 0,
      t: "MESSAGE_UPDATE",
      s: 203,
      d: { id: "message-2", content: "updated" },
    }),
    true,
  );
  assert.equal(
    shouldHandleDispatch({
      op: 0,
      t: "MESSAGE_DELETE",
      s: 204,
      d: { id: "message-2" },
    }),
    true,
  );
});

test("shouldHandleDispatch returns true for guild member add events", () => {
  assert.equal(
    shouldHandleDispatch({
      op: 0,
      t: "GUILD_MEMBER_ADD",
      s: 102,
      d: { guild_id: "guild-1", user: { id: "user-1" } },
    }),
    true,
  );
});

test("shouldHandleDispatch returns true for configured membership automation events", () => {
  assert.equal(
    shouldHandleDispatch({
      op: 0,
      t: "GUILD_MEMBER_UPDATE",
      s: 105,
      d: { guild_id: "guild-1", user: { id: "user-1" }, roles: ["role-1"] },
    }),
    true,
  );
  assert.equal(
    shouldHandleDispatch({
      op: 0,
      t: "GUILD_MEMBER_REMOVE",
      s: 106,
      d: { guild_id: "guild-1", user: { id: "user-1" } },
    }),
    true,
  );
});

test("shouldHandleDispatch returns true for guild lifecycle events", () => {
  assert.equal(
    shouldHandleDispatch({
      op: 0,
      t: "GUILD_CREATE",
      s: 103,
      d: { id: "guild-1", name: "Guild One" },
    }),
    true,
  );
  assert.equal(
    shouldHandleDispatch({
      op: 0,
      t: "GUILD_DELETE",
      s: 104,
      d: { id: "guild-1", name: "Guild One" },
    }),
    true,
  );
});

test("shouldHandleDispatch returns true for voice state updates", () => {
  assert.equal(
    shouldHandleDispatch({
      op: 0,
      t: "VOICE_STATE_UPDATE",
      s: 205,
      d: { guild_id: "guild-1", user_id: "user-1", channel_id: null },
    }),
    true,
  );
});

test("shouldHandleDispatch ignores non-dispatch and unrelated events", () => {
  assert.equal(
    shouldHandleDispatch({
      op: 10,
      t: "HELLO",
      s: null,
      d: { heartbeat_interval: 45000 },
    }),
    false,
  );
  assert.equal(
    shouldHandleDispatch({
      op: 0,
      t: "READY",
      s: 1,
      d: { session_id: "session-1" },
    }),
    false,
  );
});

test("nextBackoffMillis grows exponentially from the base delay", () => {
  assert.equal(nextBackoffMillis(0), 1000);
  assert.equal(nextBackoffMillis(1), 2000);
  assert.equal(nextBackoffMillis(2), 4000);
});

test("nextBackoffMillis caps at the max delay", () => {
  assert.equal(nextBackoffMillis(10), 30000);
});

test("nextBackoffMillis falls back to the base delay for non-finite attempts", () => {
  assert.equal(nextBackoffMillis(Number.NaN), 1000);
});

test("nextBackoffMillis floors fractional attempt counts", () => {
  assert.equal(nextBackoffMillis(1.5), 2000);
});
