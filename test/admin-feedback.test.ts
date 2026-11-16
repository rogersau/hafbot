import assert from "node:assert/strict";
import test from "node:test";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import { allowAllAdminAccess } from "./helpers/admin-api";
import { dispatchAdminRoute, type Route } from "../src/runtime/admin-route-registry";
import {
  createAdminFeedbackRoute,
  deliverAdminFeedbackNotification,
} from "../src/runtime/admin-routes/feedback";
import type { RuntimeStores } from "../src/runtime/app-types";
import type {
  AdminFeedbackRecord,
  AdminFeedbackStore,
} from "../src/runtime/contracts/admin-feedback-store";

import { createSqliteAdminFeedbackStore } from "./support/sqlite/runtime/sqlite-admin-feedback-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

function harness(
  overrides: Partial<AdminFeedbackStore> = {},
  extras: Record<string, unknown> = {},
) {
  const rows: AdminFeedbackRecord[] = [];
  const backgroundTasks: Promise<unknown>[] = [];
  const store: AdminFeedbackStore = {
    countRecentByReporter: async (userId, since) =>
      rows.filter((row) => row.reporterUserId === userId && row.createdAtMs >= since).length,
    readOldestRecentCreatedAtMs: async (userId, since) =>
      rows
        .filter((row) => row.reporterUserId === userId && row.createdAtMs >= since)
        .sort((left, right) => left.createdAtMs - right.createdAtMs)[0]?.createdAtMs ?? null,
    insert: async (row) => {
      rows.push(row);
    },
    updateNotification: async (id, state, errorCode) => {
      const row = rows.find((item) => item.id === id);
      if (row) {
        row.notificationState = state;
        row.notificationErrorCode = errorCode ?? null;
      }
    },
    purgeExpired: async (before, limit) => {
      const expired = rows.filter((row) => row.createdAtMs < before).slice(0, limit);
      return expired.length;
    },
    ...overrides,
  };
  const options: any = {
    stores: { adminFeedback: store } as RuntimeStores,
    adminAccess: allowAllAdminAccess,
    discordBotToken: "bot-token",
    readCustomerAdminSession: async () =>
      ({ user: { id: "auth-user", discordUserId: "discord-user" } }) as never,
    workerVersion: "worker-test",
    environment: "staging",
    waitUntil: (promise: Promise<unknown>) => {
      backgroundTasks.push(promise);
    },
    ...extras,
  };
  const route = createAdminFeedbackRoute(options)[0] as Route;
  return {
    route,
    rows,
    options,
    async awaitBackground() {
      await Promise.all(backgroundTasks.splice(0));
    },
  };
}

async function call(
  route: Route,
  options: any,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const request = new Request("https://example.test/admin/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return dispatchAdminRoute([route], request, {
    adminAccess: options.adminAccess,
    features: ALL_FEATURES_ENABLED,
    stores: options.stores,
  });
}

const valid = (category = "problem") => ({
  version: 1,
  category,
  summary: "Summary",
  description: "Description",
  route: "/admin/overview",
});

test("feedback requires the authenticated customer session", async () => {
  const { route, options } = harness({}, { readCustomerAdminSession: async () => null });
  const response = await call(route, options, valid());
  assert.equal(response?.status, 401);
});

test("feedback accepts every category and derives trusted fields before notification", async () => {
  const observed: AdminFeedbackRecord[] = [];
  const { route, options, awaitBackground } = harness(
    {},
    {
      notifyAdminFeedback: async (record: AdminFeedbackRecord) => {
        observed.push(record);
      },
    },
  );
  for (const category of ["problem", "suggestion", "other"]) {
    const response = await call(route, options, valid(category), {
      "CF-Ray": "ray-123",
      "User-Agent": "Mozilla/5.0 Chrome/123 Windows",
    });
    assert.equal(response?.status, 201);
  }
  await awaitBackground();
  assert.equal(observed[0]?.reporterUserId, "auth-user");
  assert.equal(observed[0]?.workerVersion, "worker-test");
  assert.equal(observed[0]?.environment, "staging");
  assert.equal(observed[0]?.rayId, "ray-123");
  assert.equal(observed[0]?.browser, null);
  assert.equal(new Set(observed.map((record) => record.reference)).size, 3);
  assert.equal(new Set(observed.map((record) => record.id)).size, 3);
});

test("feedback persists bounded page context, error code, and client worker fallback", async () => {
  const observed: AdminFeedbackRecord[] = [];
  const { route, options, rows, awaitBackground } = harness(
    {},
    { notifyAdminFeedback: async (record: AdminFeedbackRecord) => observed.push(record) },
  );
  const response = await call(route, options, {
    ...valid(),
    pageLabel: "Tickets",
    errorCode: "discord_rate_limited",
    workerVersion: "worker-client",
  });
  assert.equal(response?.status, 201);
  await awaitBackground();
  assert.equal(rows[0]?.pageLabel, "Tickets");
  assert.equal(rows[0]?.errorCode, "discord_rate_limited");
  assert.equal(rows[0]?.workerVersion, "worker-test");
  assert.equal(observed[0]?.pageLabel, "Tickets");
  assert.equal(observed[0]?.errorCode, "discord_rate_limited");
});

test("machine identifiers and Cloudflare Ray are safely bounded", async () => {
  const accepted = harness({}, { notifyAdminFeedback: async () => {} });
  assert.equal(
    (
      await call(
        accepted.route,
        accepted.options,
        { ...valid(), correlationId: "corr:abc_123" },
        { "CF-Ray": "ray-id:123" },
      )
    )?.status,
    201,
  );
  assert.equal(accepted.rows[0]?.correlationId, "corr:abc_123");
  assert.equal(accepted.rows[0]?.rayId, "ray-id:123");
  const invalid = harness({}, { notifyAdminFeedback: async () => {} });
  await call(invalid.route, invalid.options, valid(), { "CF-Ray": "ray with spaces" });
  assert.equal(invalid.rows[0]?.rayId, null);
});

test("feedback persists sent/failed notification states and accepts multiline descriptions", async () => {
  const sent = harness({}, { notifyAdminFeedback: async () => {} });
  assert.equal(
    (await call(sent.route, sent.options, { ...valid(), description: "line one\nline two" }))
      ?.status,
    201,
  );
  await sent.awaitBackground();
  assert.equal(sent.rows[0]?.notificationState, "sent");
  const failed = harness(
    {},
    {
      notifyAdminFeedback: async () => {
        throw new Error("Discord down");
      },
    },
  );
  assert.equal((await call(failed.route, failed.options, valid()))?.status, 201);
  await failed.awaitBackground();
  assert.equal(failed.rows[0]?.notificationState, "failed");
  assert.equal(failed.rows[0]?.notificationErrorCode, "discord_unavailable");
});

test("feedback validates strict bounded body and streamed size", async () => {
  const { route, options } = harness();
  for (const body of [
    { ...valid(), unknown: true },
    { ...valid(), summary: "   " },
    { ...valid(), description: "bad\u0000value" },
    { ...valid(), diagnostics: { included: false, browser: "Chrome" } },
    { ...valid(), correlationId: "token=secret" },
    { ...valid(), pageLabel: "   " },
    { ...valid(), errorCode: "error code" },
    { ...valid(), workerVersion: "worker version" },
  ]) {
    const response = await call(route, options, body);
    assert.equal(response?.status, 400);
  }
  const huge = JSON.stringify({ ...valid(), description: "x".repeat(9_000) });
  const response = await dispatchAdminRoute(
    [route],
    new Request("https://example.test/admin/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(huge.length) },
      body: huge,
    }),
    { adminAccess: options.adminAccess, features: ALL_FEATURES_ENABLED, stores: options.stores },
  );
  assert.equal(response?.status, 400);
  const streamResponse = await dispatchAdminRoute(
    [route],
    new Request("https://example.test/admin/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      duplex: "half",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(huge));
          controller.close();
        },
      }),
    } as RequestInit & { duplex: "half" }),
    { adminAccess: options.adminAccess, features: ALL_FEATURES_ENABLED, stores: options.stores },
  );
  assert.equal(streamResponse?.status, 400);
});

test("feedback enforces five reports per rolling hour with retry metadata", async () => {
  const oldest = Date.now() - 15 * 60 * 1_000;
  const { route, options } = harness({
    countRecentByReporter: async () => 5,
    readOldestRecentCreatedAtMs: async () => oldest,
  });
  const response = await call(route, options, valid());
  assert.ok(response);
  assert.equal(response.status, 429);
  assert.equal(((await response.clone().json()) as { code: string }).code, "feedback_rate_limited");
  const retryAfter = Number(response.headers.get("Retry-After"));
  assert.ok(retryAfter >= 2_699 && retryAfter <= 2_700);
});

test("guild and workspace scopes use the existing authorization requirement", async () => {
  const seen: unknown[] = [];
  const { route, options } = harness();
  options.adminAccess = {
    authorize: (_request: Request, requirement: unknown) => {
      seen.push(requirement);
      return Promise.resolve({ ok: true as const });
    },
  };
  assert.equal((await call(route, options, { ...valid(), guildId: "123" }))?.status, 201);
  assert.equal(
    (await call(route, options, { ...valid(), guildId: "123", workspaceId: "workspace-1" }))
      ?.status,
    201,
  );
  assert.deepEqual(seen, [
    { mode: "read", guildId: "123" },
    { mode: "read", customerSessionOnly: true },
    {
      mode: "read",
      guildId: "123",
      workspaceId: "workspace-1",
      workspaceOnly: true,
    },
    { mode: "read", customerSessionOnly: true },
  ]);
  options.adminAccess = {
    authorize: () =>
      Promise.resolve({ ok: false as const, error: { _tag: "Forbidden", message: "Forbidden" } }),
  };
  assert.equal((await call(route, options, { ...valid(), guildId: "123" }))?.status, 403);

  options.adminAccess = {
    authorize: (_request: Request, requirement: { workspaceOnly?: boolean }) =>
      requirement.workspaceOnly
        ? Promise.resolve({
            ok: false as const,
            error: { _tag: "Forbidden", message: "Workspace or Guild link denied" },
          })
        : Promise.resolve({ ok: true as const }),
  };
  assert.equal(
    (await call(route, options, { ...valid(), guildId: "123", workspaceId: "workspace-2" }))
      ?.status,
    403,
  );
});

test("notification and status failures do not fail an accepted report", async () => {
  const events: unknown[] = [];
  const { route, rows, options, awaitBackground } = harness(
    {
      updateNotification: async () => {
        throw new Error("status unavailable");
      },
    },
    {
      notifyAdminFeedback: async () => {
        throw new Error("discord unavailable");
      },
      reportOperationalEvent: (event: unknown) => {
        events.push(event);
      },
    },
  );
  const response = await call(route, options, valid());
  assert.equal(response?.status, 201);
  await awaitBackground();
  assert.equal(rows.length, 1);
  assert.equal(events.length, 2);
});

test("feedback returns its durable receipt before bounded notification work completes", async () => {
  let finishNotification: (() => void) | undefined;
  const notification = new Promise<void>((resolve) => {
    finishNotification = resolve;
  });
  const deferred = harness(
    {},
    {
      notifyAdminFeedback: () => notification,
    },
  );

  const response = await call(deferred.route, deferred.options, valid());

  assert.equal(response?.status, 201);
  assert.equal(deferred.rows[0]?.notificationState, "pending");
  finishNotification?.();
  await deferred.awaitBackground();
  assert.equal(deferred.rows[0]?.notificationState, "sent");

  deferred.options.notifyAdminFeedback = () => new Promise<void>(() => {});
  await deliverAdminFeedbackNotification(deferred.rows[0]!, deferred.options, 1, 10);
  assert.equal(deferred.rows[0]?.notificationState, "failed");
  assert.equal(deferred.rows[0]?.notificationErrorCode, "notification_timeout");
});

test("a throwing operational reporter cannot turn delivery failure into a request failure", async () => {
  const { route, options } = harness(
    {},
    {
      notifyAdminFeedback: async () => {
        throw new Error("discord unavailable");
      },
      reportOperationalEvent: () => {
        throw new Error("telemetry unavailable");
      },
    },
  );
  assert.equal((await call(route, options, valid()))?.status, 201);
});

test("only unique constraint failures are retried during insert", async () => {
  let attempts = 0;
  const collision = new Error("UNIQUE constraint failed: admin_feedback.reference");
  const { route, options } = harness({
    insert: async () => {
      attempts += 1;
      if (attempts < 2) throw collision;
    },
  });
  assert.equal((await call(route, options, valid()))?.status, 201);
  assert.equal(attempts, 2);
  const { route: failedRoute, options: failedOptions } = harness({
    insert: async () => {
      throw new Error("database offline");
    },
  });
  assert.equal((await call(failedRoute, failedOptions, valid()))?.status, 503);
  let checkAttempts = 0;
  const { route: checkRoute, options: checkOptions } = harness({
    insert: async () => {
      checkAttempts += 1;
      throw new Error("CHECK constraint failed: admin_feedback.category");
    },
  });
  assert.equal((await call(checkRoute, checkOptions, valid()))?.status, 503);
  assert.equal(checkAttempts, 1);
});

test("opted-in diagnostics use bounded client values or safe User-Agent fallbacks and redact secrets", async () => {
  let notified: AdminFeedbackRecord | null = null;
  const { route, rows, options, awaitBackground } = harness(
    {},
    {
      notifyAdminFeedback: async (record: AdminFeedbackRecord) => {
        notified = record;
      },
    },
  );
  const response = await call(
    route,
    options,
    {
      ...valid(),
      summary: "token=secret cookie=session",
      description: "Bearer secret webhook https://discord.com/api/webhooks/1/abc",
      route: "/admin?session=secret",
      diagnostics: { included: true, browser: "token=browser", os: "cookie=os" },
    },
    { "User-Agent": "Mozilla/5.0 Chrome/123 Windows" },
  );
  assert.equal(response?.status, 201);
  await awaitBackground();
  assert.equal(rows[0]?.diagnosticsIncluded, true);
  assert.equal(rows[0]?.browser, "token=[REDACTED]");
  assert.equal(rows[0]?.os, "cookie=[REDACTED]");
  assert.match(rows[0]?.summary ?? "", /REDACTED/);
  assert.equal(notified, rows[0]);
  for (const value of [
    rows[0]?.summary,
    rows[0]?.description,
    rows[0]?.route,
    rows[0]?.browser,
    rows[0]?.os,
  ]) {
    assert.doesNotMatch(value ?? "", /secret|https:\/\/discord\.com\/api\/webhooks\/1\/abc/i);
  }
  assert.ok((rows[0]?.summary.length ?? 0) <= 200);
  assert.ok((rows[0]?.description.length ?? 0) <= 4_000);
  assert.ok((rows[0]?.route.length ?? 0) <= 200);
  assert.ok((rows[0]?.browser?.length ?? 0) <= 80);
  assert.ok((rows[0]?.os?.length ?? 0) <= 80);
  const ios = harness({}, { notifyAdminFeedback: async () => {} });
  await call(
    ios.route,
    ios.options,
    { ...valid(), diagnostics: { included: true } },
    { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605" },
  );
  assert.equal(ios.rows[0]?.os, "iOS");
});

test("Cloudflare feedback store counts, updates, and purges only the oldest bounded rows", async () => {
  const database = new SqliteD1Database();
  try {
    const store = createSqliteAdminFeedbackStore(database.d1);
    const make = (id: string, createdAtMs: number): AdminFeedbackRecord => ({
      id,
      reference: `FB-${id}`,
      category: "other",
      summary: "s",
      description: "d",
      reporterUserId: "user",
      guildId: null,
      workspaceId: null,
      route: "/admin",
      pageLabel: null,
      correlationId: null,
      errorCode: null,
      rayId: null,
      workerVersion: "w",
      environment: "test",
      diagnosticsIncluded: false,
      browser: null,
      os: null,
      notificationState: "pending",
      notificationErrorCode: null,
      createdAtMs,
    });
    await store.insert(make("old", 1));
    await store.insert(make("old-2", 2));
    await store.insert(make("recent", Date.now()));
    assert.equal(await store.countRecentByReporter("user", 0), 3);
    assert.equal(await store.readOldestRecentCreatedAtMs("user", 0), 1);
    await store.updateNotification("recent", "sent");
    const purged = await store.purgeExpired(10, 1);
    assert.equal(purged, 1);
    assert.equal(await store.countRecentByReporter("user", 0), 2);
    assert.equal(await store.readOldestRecentCreatedAtMs("user", 0), 2);
  } finally {
    database.close();
  }
});
