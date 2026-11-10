/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
import test from "node:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { NoGuildSelected } from "../src/admin/components/no-guild-selected";
import { AdminGuildSettingsPage } from "../src/admin/components/admin-guild-settings-page";
import { ToastProvider } from "../src/admin/components/toast";
import type { AdminRouterContext } from "../src/admin/routes/context";
import { AdminRouteContextProvider } from "../src/admin/routes/page-context";
function renderEmptyState(search = "", description?: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/admin",
    component: () => <NoGuildSelected feature="Guild Settings" description={description} />,
  });
  const routeTree = rootRoute.addChildren([adminRoute]);
  const context = {
    currentPath: "/admin",
    currentSearch: search,
    selectedWorkspaceId: "workspace-1",
  } as AdminRouterContext;
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/admin${search}`] }),
  });
  router.stores.setMatches(
    router
      .matchRoutes(router.state.location)
      .map((match) => ({ ...match, status: "success" as const })),
  );
  return renderToString(
    <AdminRouteContextProvider value={context}>
      <RouterProvider router={router} />
    </AdminRouteContextProvider>,
  );
}
test("NoGuildSelected has the generic empty state and a keyboard-accessible canonical dashboard link", () => {
  const html = renderEmptyState("?workspaceId=workspace-1");
  assert.match(html, />Choose a server</);
  assert.match(html, /Select a Discord server before managing this feature\./);
  assert.match(html, /<a[^>]+href="\/admin\?workspaceId=workspace-1"[^>]*>Choose server<\/a>/);
  assert.doesNotMatch(html, /role="button"/);
});
test("NoGuildSelected preserves a supplied feature description and omits workspace when unavailable", () => {
  const html = renderEmptyState("", "Configure this feature after selecting your server.");
  assert.match(html, /Configure this feature after selecting your server\./);
  assert.doesNotMatch(html, /Select a Discord server before managing this feature\./);
  assert.match(html, /<a[^>]+href="\/admin"[^>]*>Choose server<\/a>/);
});
test("selected-guild settings keeps its controls instead of rendering the empty state", () => {
  const html = renderToString(
    <ToastProvider>
      <AdminGuildSettingsPage selectedWorkspaceId="workspace-1" selectedGuildId="guild-1" />
    </ToastProvider>,
  );
  assert.match(html, /HAF admin role/);
  assert.doesNotMatch(html, /Choose a server/);
});
