/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import {
  resolveDisplayName,
  resolveInteractionDisplayName,
  resolveMemberDisplayName,
  resolveResolvedDisplayName,
} from "../src/runtime/discord-user";

test("resolveDisplayName full chain: nick takes priority", () => {
  const result = resolveDisplayName({
    nick: "Nickname",
    global_name: "GlobalName",
    username: "Username",
    id: "12345",
  });
  assert.equal(result, "Nickname");
});

test("resolveDisplayName nick null -> global_name used", () => {
  const result = resolveDisplayName({
    nick: null,
    global_name: "GlobalName",
    username: "Username",
    id: "12345",
  });
  assert.equal(result, "GlobalName");
});

test("resolveDisplayName nick null, global_name null -> username used", () => {
  const result = resolveDisplayName({
    nick: null,
    global_name: null,
    username: "Username",
    id: "12345",
  });
  assert.equal(result, "Username");
});

test("resolveDisplayName nick null, global_name null, username null -> id used", () => {
  const result = resolveDisplayName({
    nick: null,
    global_name: null,
    username: null,
    id: "12345",
  });
  assert.equal(result, "12345");
});

test("resolveDisplayName all null -> returns null", () => {
  const result = resolveDisplayName({
    nick: null,
    global_name: null,
    username: null,
    id: null,
  });
  assert.equal(result, null);
});

test("resolveDisplayName all null with terminalFallback -> returns terminalFallback", () => {
  const result = resolveDisplayName(
    {
      nick: null,
      global_name: null,
      username: null,
      id: null,
    },
    { terminalFallback: "Unknown User" },
  );
  assert.equal(result, "Unknown User");
});

test("resolveDisplayName empty string fields are returned as-is (?? operator)", () => {
  const result = resolveDisplayName({
    nick: "",
    global_name: "GlobalName",
    username: "Username",
    id: "12345",
  });
  assert.equal(result, "");
});

test("resolveDisplayName terminalFallback: null treated as null", () => {
  const result = resolveDisplayName(
    { nick: null, global_name: null, username: null, id: null },
    // @ts-expect-error - testing explicit null terminalFallback
    { terminalFallback: null },
  );
  assert.equal(result, null);
});

test("resolveDisplayName undefined fields treated same as null", () => {
  const result = resolveDisplayName({});
  assert.equal(result, null);
});

test("resolveDisplayName OAuth scenario: global_name present, no nick -> global_name used", () => {
  const result = resolveDisplayName({
    global_name: "GlobalName",
    username: "Username",
    id: "12345",
  });
  assert.equal(result, "GlobalName");
});

test("resolveDisplayName OAuth scenario: only username (no nick, no global_name) -> username used", () => {
  const result = resolveDisplayName({
    username: "Username",
    id: "12345",
  });
  assert.equal(result, "Username");
});

test("resolveDisplayName OAuth scenario: only id (no name fields) -> id used", () => {
  const result = resolveDisplayName({
    id: "12345",
  });
  assert.equal(result, "12345");
});

test("resolveDisplayName OAuth scenario: nothing + terminalFallback 'Discord user' -> returns 'Discord user'", () => {
  const result = resolveDisplayName(
    {
      id: null,
      global_name: null,
      username: null,
    },
    { terminalFallback: "Discord user" },
  );
  assert.equal(result, "Discord user");
});

test("resolveMemberDisplayName uses member nick and user fallback chain", () => {
  assert.equal(
    resolveMemberDisplayName({
      nick: "Nickname",
      user: { global_name: "GlobalName", username: "Username", id: "12345" },
    }),
    "Nickname",
  );
  assert.equal(
    resolveMemberDisplayName({
      nick: null,
      user: { global_name: "GlobalName", username: "Username", id: "12345" },
    }),
    "GlobalName",
  );
});

test("resolveResolvedDisplayName uses resolved member and user data", () => {
  assert.equal(
    resolveResolvedDisplayName(
      {
        users: { "12345": { id: "12345", username: "Username", global_name: "GlobalName" } },
        members: { "12345": { nick: "Nickname" } },
      },
      "12345",
    ),
    "Nickname",
  );
  assert.equal(
    resolveResolvedDisplayName(
      {
        users: { "12345": { id: "12345", username: "Username", global_name: "GlobalName" } },
        members: {},
      },
      "12345",
    ),
    "GlobalName",
  );
});

test("resolveInteractionDisplayName uses member first then interaction user fallback", () => {
  assert.equal(
    resolveInteractionDisplayName({
      member: {
        nick: "Nickname",
        user: { id: "12345", global_name: "GlobalName", username: "Username" },
      },
      user: { id: "12345", global_name: "Fallback", username: "Fallback" },
    }),
    "Nickname",
  );
  assert.equal(
    resolveInteractionDisplayName({
      user: { id: "12345", global_name: "Fallback", username: "Fallback" },
    }),
    "Fallback",
  );
});

function createMockKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string, _options?: { expirationTtl?: number }) => {
      store.set(key, value);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
}

import { resolveDisplayNameCached } from "../src/runtime/discord-user";

test("resolveDisplayNameCached with user data -> returns display name and caches it", async () => {
  const kv = createMockKv();
  const result = await resolveDisplayNameCached(kv, {
    nick: "Nickname",
    global_name: "GlobalName",
    username: "Username",
    id: "12345",
  });
  assert.equal(result, "Nickname");
  const cached = await kv.get("discord_user:12345");
  assert.equal(cached, "Nickname");
});

test("resolveDisplayNameCached all null + cached value -> returns stale cached value", async () => {
  const kv = createMockKv();
  await kv.put("discord_user:12345", "CachedName", { expirationTtl: 3600 });
  const result = await resolveDisplayNameCached(kv, {
    nick: null,
    global_name: null,
    username: null,
    id: "12345",
  });
  assert.equal(result, "CachedName");
});

test("resolveDisplayNameCached all null + no cache -> returns null", async () => {
  const kv = createMockKv();
  const result = await resolveDisplayNameCached(kv, {
    nick: null,
    global_name: null,
    username: null,
    id: "12345",
  });
  assert.equal(result, null);
});

test("resolveDisplayNameCached all null + no cache + terminalFallback -> returns terminalFallback", async () => {
  const kv = createMockKv();
  const result = await resolveDisplayNameCached(
    kv,
    {
      nick: null,
      global_name: null,
      username: null,
      id: "12345",
    },
    { terminalFallback: "Unknown User" },
  );
  assert.equal(result, "Unknown User");
});

test("resolveDisplayNameCached with user data + no id -> returns display name (does not cache)", async () => {
  const kv = createMockKv();
  const result = await resolveDisplayNameCached(kv, {
    nick: null,
    global_name: "GlobalName",
    username: "Username",
  });
  assert.equal(result, "GlobalName");
  const cached = await kv.get("discord_user:undefined");
  assert.equal(cached, null);
});
