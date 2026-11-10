/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";

import { AdminRouteErrorContent, retryAdminRoute } from "../src/admin/components/admin-route-error";

function renderRouteError(error: Error, pathname = "/admin/guild-1/tickets") {
  const rootRoute = createRootRoute();
  const errorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/admin/$guildId/tickets",
    component: () => <AdminRouteErrorContent error={error} reset={() => undefined} />,
  });
  const routeTree = rootRoute.addChildren([errorRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [pathname] }),
  });
  router.stores.setMatches(
    router.matchRoutes(router.state.location).map((match) => ({
      ...match,
      status: "success" as const,
    })),
  );
  return renderToString(<RouterProvider router={router} />);
}

test("AdminRouteError offers retry and guild-scoped troubleshooting for transient failures", () => {
  const html = renderRouteError(new Error("503 Discord lookup failed"));

  assert.match(html, /role="alert"/);
  assert.match(html, />Retry</);
  assert.match(html, /href="\/admin\/guild-1\/troubleshooting"/);
});

test("AdminRouteError offers Discord reconnection instead of retry for expired authorization", () => {
  const html = renderRouteError(new Error("Missing Discord OAuth access token for guild lookup."));

  assert.match(html, /Sign out and reconnect Discord/);
  assert.match(html, /action="\/admin\/logout"/);
  assert.doesNotMatch(html, />Retry</);
});

test("AdminRouteError retry invalidates the failed route before resetting its boundary", async () => {
  const calls: string[] = [];
  await retryAdminRoute(
    {
      invalidate: async () => {
        calls.push("invalidate");
      },
    },
    () => calls.push("reset"),
  );
  assert.deepEqual(calls, ["invalidate", "reset"]);
});
