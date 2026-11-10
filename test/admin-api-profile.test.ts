/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { createUserProfileAdminRoutes } from "../src/runtime/admin-routes/profile";
import { createCloudflareUserPreferencesStore } from "../src/runtime/cloudflare-user-preferences-store";
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from "../src/runtime/admin-types";
import { allowAllAdminAccess } from "./helpers/admin-api";
import { dispatchAdminRoute } from "../src/runtime/admin-route-registry";
import type { CustomerSession } from "../src/runtime/auth/customer-session";
import { SqliteD1Database } from "./support/sqlite-d1-database";

const SESSION_USER: CustomerSession = {
  user: {
    id: "user-1",
    discordUserId: "discord-1",
    name: "Alice",
    email: "alice@example.com",
    image: null,
  },
};
const NO_SESSION = null;

const BASE_PREFERENCES: UserPreferences = {
  hiddenGuildIds: ["guild-2"],
  defaultGuildId: "guild-1",
  emailNotifications: false,
  pushNotifications: true,
  theme: "dark",
  language: "es",
};

function createTestHarness(
  session: CustomerSession | null = SESSION_USER,
  options?: { seed?: UserPreferences },
) {
  const database = new SqliteD1Database();
  const store = createCloudflareUserPreferencesStore(database as unknown as D1Database);
  if (options?.seed) {
    void store.upsertUserPreferences(SESSION_USER.user.id, options.seed);
  }
  const routes = createUserProfileAdminRoutes({
    store,
    readCustomerSession: async () => session,
  });
  return { routes, store };
}

test("GET /admin/api/profile/preferences returns defaults for a first-time user", async () => {
  const { routes } = createTestHarness();
  const response = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/profile/preferences", { method: "GET" }),
    { adminAccess: allowAllAdminAccess, features: {} as never, stores: {} as never },
  );

  assert.ok(response);
  assert.equal(response.status, 200);
  const body = (await response.json()) as UserPreferences;
  assert.deepEqual(body, DEFAULT_USER_PREFERENCES);
});

test("GET /admin/api/profile/preferences is keyed by the session user id, not the request body", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareUserPreferencesStore(database as unknown as D1Database);
  await store.upsertUserPreferences("other-user", { ...DEFAULT_USER_PREFERENCES, theme: "dark" });
  await store.upsertUserPreferences(SESSION_USER.user.id, {
    ...DEFAULT_USER_PREFERENCES,
    theme: "light",
  });
  const routes = createUserProfileAdminRoutes({
    store,
    readCustomerSession: async () => SESSION_USER,
  });

  const response = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/profile/preferences", { method: "GET" }),
    { adminAccess: allowAllAdminAccess, features: {} as never, stores: {} as never },
  );

  assert.ok(response);
  assert.equal(response.status, 200);
  const body = (await response.json()) as UserPreferences;
  assert.equal(body.theme, "light");
});

test("PATCH /admin/api/profile/preferences writes the row under the session user id", async () => {
  const { routes, store } = createTestHarness();

  const response = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/profile/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "dark" }),
    }),
    { adminAccess: allowAllAdminAccess, features: {} as never, stores: {} as never },
  );

  assert.ok(response);
  assert.equal(response.status, 200);
  const stored = await store.readUserPreferences(SESSION_USER.user.id);
  assert.equal(stored?.theme, "dark");

  const otherUser = await store.readUserPreferences("other-user");
  assert.equal(otherUser, null);
});

test("GET /admin/api/profile/preferences returns stored preferences for a returning user", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareUserPreferencesStore(database as unknown as D1Database);
  await store.upsertUserPreferences("user-1", BASE_PREFERENCES);
  const routes = createUserProfileAdminRoutes({
    store,
    readCustomerSession: async () => SESSION_USER,
  });

  const response = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/profile/preferences"),
    { adminAccess: allowAllAdminAccess, features: {} as never, stores: {} as never },
  );

  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), BASE_PREFERENCES);
});

test("GET /admin/api/profile/preferences returns 401 when no customer session is present", async () => {
  const { routes } = createTestHarness(NO_SESSION);

  const response = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/profile/preferences"),
    { adminAccess: allowAllAdminAccess, features: {} as never, stores: {} as never },
  );

  assert.equal(response?.status, 401);
});

test("PATCH /admin/api/profile/preferences merges the patch into stored preferences and persists", async () => {
  const { routes, store } = createTestHarness();
  await store.upsertUserPreferences("user-1", BASE_PREFERENCES);

  const response = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/profile/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "light", pushNotifications: false }),
    }),
    { adminAccess: allowAllAdminAccess, features: {} as never, stores: {} as never },
  );

  assert.equal(response?.status, 200);
  const expected: UserPreferences = {
    ...BASE_PREFERENCES,
    theme: "light",
    pushNotifications: false,
  };
  assert.deepEqual(await response?.json(), expected);
  assert.deepEqual(await store.readUserPreferences("user-1"), expected);
});

test("PATCH /admin/api/profile/preferences seeds defaults for a first-time user", async () => {
  const { routes, store } = createTestHarness();

  const response = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/profile/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "fr" }),
    }),
    { adminAccess: allowAllAdminAccess, features: {} as never, stores: {} as never },
  );

  assert.equal(response?.status, 200);
  const expected: UserPreferences = {
    ...DEFAULT_USER_PREFERENCES,
    language: "fr",
  };
  assert.deepEqual(await response?.json(), expected);
  assert.deepEqual(await store.readUserPreferences("user-1"), expected);
});

test("PATCH /admin/api/profile/preferences returns 400 when compactMode is included", async () => {
  const { routes, store } = createTestHarness();

  const response = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/profile/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ compactMode: true, language: "fr" }),
    }),
    { adminAccess: allowAllAdminAccess, features: {} as never, stores: {} as never },
  );

  assert.equal(response?.status, 400);
  assert.deepEqual(await store.readUserPreferences("user-1"), null);
});

test("PATCH /admin/api/profile/preferences returns 400 when theme is invalid", async () => {
  const { routes } = createTestHarness();

  const response = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/profile/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "midnight" }),
    }),
    { adminAccess: allowAllAdminAccess, features: {} as never, stores: {} as never },
  );

  assert.equal(response?.status, 400);
});

test("PATCH /admin/api/profile/preferences returns 400 when language is invalid", async () => {
  const { routes } = createTestHarness();

  const response = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/profile/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "jp" }),
    }),
    { adminAccess: allowAllAdminAccess, features: {} as never, stores: {} as never },
  );

  assert.equal(response?.status, 400);
});

test("PATCH /admin/api/profile/preferences returns 400 when an unknown field is included", async () => {
  const { routes } = createTestHarness();

  const response = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/profile/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isAdmin: true }),
    }),
    { adminAccess: allowAllAdminAccess, features: {} as never, stores: {} as never },
  );

  assert.equal(response?.status, 400);
});

test("PATCH /admin/api/profile/preferences returns 401 when no customer session is present", async () => {
  const { routes } = createTestHarness(NO_SESSION);

  const response = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/profile/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "light" }),
    }),
    { adminAccess: allowAllAdminAccess, features: {} as never, stores: {} as never },
  );

  assert.equal(response?.status, 401);
});

test("PATCH /admin/api/profile/preferences hides and un-hides guilds via hiddenGuildIds", async () => {
  const { routes, store } = createTestHarness();

  const hideResponse = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/profile/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hiddenGuildIds: ["guild-1", "guild-2", "guild-1"] }),
    }),
    { adminAccess: allowAllAdminAccess, features: {} as never, stores: {} as never },
  );

  assert.equal(hideResponse?.status, 200);
  const hidden = (await hideResponse?.json()) as UserPreferences;
  assert.deepEqual(hidden.hiddenGuildIds, ["guild-1", "guild-2"]);

  const restoreResponse = await dispatchAdminRoute(
    routes,
    new Request("https://example.com/admin/api/profile/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hiddenGuildIds: [] }),
    }),
    { adminAccess: allowAllAdminAccess, features: {} as never, stores: {} as never },
  );

  assert.equal(restoreResponse?.status, 200);
  assert.deepEqual((await restoreResponse?.json()) as UserPreferences, {
    ...DEFAULT_USER_PREFERENCES,
    hiddenGuildIds: [],
  });
  assert.deepEqual((await store.readUserPreferences("user-1"))?.hiddenGuildIds, []);
});

test("createAdminRoutes registers GET and PATCH /admin/api/profile/preferences when a customer session reader is provided", async () => {
  const { createAdminRoutes } = await import("../src/runtime/admin-routes");
  const database = new SqliteD1Database();
  const store = createCloudflareUserPreferencesStore(database as unknown as D1Database);
  const routes = createAdminRoutes({
    stores: { userPreferences: store } as never,
    adminAccess: allowAllAdminAccess,
    discordBotToken: "bot-token",
    readCustomerAdminSession: async () => SESSION_USER,
  });

  const get = routes.find(
    (route) => route.method === "GET" && route.path === "/admin/api/profile/preferences",
  );
  const patch = routes.find(
    (route) => route.method === "PATCH" && route.path === "/admin/api/profile/preferences",
  );

  assert.ok(get, "expected GET /admin/api/profile/preferences to be registered");
  assert.ok(patch, "expected PATCH /admin/api/profile/preferences to be registered");
});
