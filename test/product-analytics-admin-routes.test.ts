/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createDashboardProductAnalyticsEvent } from "../src/contracts/admin/cross-cutting";
import type { ProductAnalyticsEvent } from "../src/product-analytics";
import { dispatchAdminRoute } from "../src/runtime/admin-route-registry";
import { createSocialAdminRoutes } from "../src/runtime/admin-routes/social";
import { allowAllAdminAccess } from "./helpers/admin-api";

function createAnalyticsRoutes(options: {
  enabled?: boolean;
  events?: ProductAnalyticsEvent[];
  webhookIngressGuard?: unknown;
}) {
  let enabled = options.enabled ?? true;
  const routes = createSocialAdminRoutes({
    stores: {
      productAnalyticsPreferences: {
        readEnabled: async () => enabled,
        setEnabled: async (_guildId: string, value: boolean) => void (enabled = value),
      },
    } as never,
    adminAccess: {} as never,
    discordBotToken: "token",
    productAnalytics: options.events
      ? { report: async (event) => void options.events!.push(event) }
      : undefined,
    webhookIngressGuard: options.webhookIngressGuard as never,
  });
  return {
    event: routes.find(({ operationId }) => operationId === "productAnalyticsEvent.post")!,
    preferenceGet: routes.find(
      ({ operationId }) => operationId === "productAnalyticsPreference.get",
    )!,
    preferencePost: routes.find(
      ({ operationId }) => operationId === "productAnalyticsPreference.post",
    )!,
  };
}

test("product analytics preference routes read and update the durable Guild setting", async () => {
  const routes = createAnalyticsRoutes({ enabled: true });
  const request = new Request("https://example.com/admin/api/product-analytics/preference");
  const context = {
    request,
    url: new URL(request.url),
    params: {},
    query: { guildId: "guild-1" },
    body: undefined,
  };

  const initial = await routes.preferenceGet.handler(context as never);
  assert.deepEqual(await initial.json(), { guildId: "guild-1", enabled: true });

  const updated = await routes.preferencePost.handler({
    ...context,
    query: undefined,
    body: { guildId: "guild-1", enabled: false },
  } as never);
  assert.deepEqual(await updated.json(), { guildId: "guild-1", enabled: false });

  const saved = await routes.preferenceGet.handler(context as never);
  assert.deepEqual(await saved.json(), { guildId: "guild-1", enabled: false });
});

test("Dashboard event contract rejects unknown events and identifying properties", () => {
  assert.equal(
    createDashboardProductAnalyticsEvent.body!.safeParse({
      guildId: "guild-1",
      event: "message_sent",
    }).success,
    false,
  );
  assert.equal(
    createDashboardProductAnalyticsEvent.body!.safeParse({
      guildId: "guild-1",
      event: "page_viewed",
      page: "tickets",
      channelId: "channel-1",
    }).success,
    false,
  );
});

test("Dashboard analytics honors GPC and DNT and always returns a constant response", async () => {
  const events: ProductAnalyticsEvent[] = [];
  const { event: route } = createAnalyticsRoutes({ events });
  const body = { guildId: "guild-1", event: "page_viewed", page: "tickets" } as const;

  for (const header of ["sec-gpc", "dnt"]) {
    const request = new Request("https://example.com/admin/api/product-analytics/events", {
      headers: { [header]: "1" },
    });
    const response = await route.handler({
      request,
      url: new URL(request.url),
      params: {},
      query: undefined,
      body,
    } as never);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true });
  }
  assert.deepEqual(events, []);

  const request = new Request("https://example.com/admin/api/product-analytics/events");
  const response = await route.handler({
    request,
    url: new URL(request.url),
    params: {},
    query: undefined,
    body,
  } as never);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.equal(events.length, 1);
  const captured = events[0] as ProductAnalyticsEvent | undefined;
  assert.ok(captured);
  assert.deepEqual(captured, {
    name: "dashboard_page_viewed",
    insertionId: captured.insertionId,
    guildId: "guild-1",
    page: "tickets",
    feature: undefined,
  });
});

test("Dashboard analytics route bounds JSON ingress and suppresses rate-limited events", async () => {
  const events: ProductAnalyticsEvent[] = [];
  let reservations = 0;
  const { event: route } = createAnalyticsRoutes({
    events,
    webhookIngressGuard: {
      getByName: () => ({
        reserve: async () =>
          ++reservations === 1
            ? { ok: true, leaseId: "lease-1", expiresAtMs: Date.now() + 1_000 }
            : { ok: false, reason: "rate_limited", retryAfterSeconds: 60 },
        complete: async () => {},
      }),
    },
  });
  assert.equal(route.maxBodyBytes, 1_024);
  const body = { guildId: "guild-1", event: "page_viewed", page: "tickets" } as const;

  for (let index = 0; index < 2; index += 1) {
    const request = new Request("https://example.com/admin/api/product-analytics/events");
    const response = await route.handler({
      request,
      url: new URL(request.url),
      params: {},
      query: undefined,
      body,
    } as never);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true });
  }

  assert.equal(events.length, 1);
});

test("Dashboard analytics ingress rejects non-JSON and oversized bodies before reporting", async () => {
  const events: ProductAnalyticsEvent[] = [];
  const { event: route } = createAnalyticsRoutes({ events });
  const options = {
    adminAccess: allowAllAdminAccess,
    features: {} as never,
    stores: {} as never,
  };
  const validBody = JSON.stringify({
    guildId: "guild-1",
    event: "page_viewed",
    page: "tickets",
  });

  const wrongType = await dispatchAdminRoute(
    [route],
    new Request("https://example.com/admin/api/product-analytics/events", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: validBody,
    }),
    options,
  );
  const oversized = await dispatchAdminRoute(
    [route],
    new Request("https://example.com/admin/api/product-analytics/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...JSON.parse(validBody), padding: "x".repeat(2_000) }),
    }),
    options,
  );

  assert.equal(wrongType?.status, 400);
  assert.equal(oversized?.status, 400);
  assert.deepEqual(events, []);
});
