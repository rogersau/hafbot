/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareUserPreferencesStore } from "../src/runtime/cloudflare-user-preferences-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";
import type { UserPreferences } from "../src/runtime/admin-types";

const BASE_PREFERENCES: UserPreferences = {
  hiddenGuildIds: [],
  defaultGuildId: null,
  emailNotifications: true,
  pushNotifications: false,
  theme: "system",
  language: "en",
};

test("createCloudflareUserPreferencesStore returns null for a first-time user", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareUserPreferencesStore(database as unknown as D1Database);

  assert.equal(await store.readUserPreferences("user-1"), null);
});

test("createCloudflareUserPreferencesStore persists a user row and reads it back", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareUserPreferencesStore(database as unknown as D1Database);

  const stored: UserPreferences = {
    ...BASE_PREFERENCES,
    hiddenGuildIds: ["guild-2"],
    defaultGuildId: "guild-1",
    emailNotifications: false,
    pushNotifications: true,
    theme: "dark",
    language: "es",
  };

  await store.upsertUserPreferences("user-1", stored);

  assert.deepEqual(await store.readUserPreferences("user-1"), stored);
});

test("createCloudflareUserPreferencesStore upserts preserve all fields on the same user", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareUserPreferencesStore(database as unknown as D1Database);

  const initial: UserPreferences = {
    ...BASE_PREFERENCES,
    theme: "light",
    language: "de",
  };
  await store.upsertUserPreferences("user-1", initial);

  const updated: UserPreferences = {
    ...initial,
    hiddenGuildIds: ["guild-9"],
    pushNotifications: true,
  };
  await store.upsertUserPreferences("user-1", updated);

  assert.deepEqual(await store.readUserPreferences("user-1"), updated);
});

test("createCloudflareUserPreferencesStore isolates preferences per user", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareUserPreferencesStore(database as unknown as D1Database);

  const alice: UserPreferences = { ...BASE_PREFERENCES, theme: "dark", language: "fr" };
  const bob: UserPreferences = { ...BASE_PREFERENCES, theme: "light", language: "es" };

  await store.upsertUserPreferences("user-alice", alice);
  await store.upsertUserPreferences("user-bob", bob);

  assert.deepEqual(await store.readUserPreferences("user-alice"), alice);
  assert.deepEqual(await store.readUserPreferences("user-bob"), bob);
});
