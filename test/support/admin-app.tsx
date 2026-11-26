import { registerHooks } from "node:module";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";

import { getAdminRouteState } from "../../src/admin/lib/admin-route-state";
import type { AdminRouterContext } from "../../src/admin/routes/context";
import { AdminRouteContextProvider } from "../../src/admin/routes/page-context";
import type { AdminDocumentData } from "../../src/web/router-context";

export const routeTree = loadRouteTree();
export const authenticatedAdmin: AdminDocumentData = {
  authenticated: true,
  userProfile: null,
  playstationLinkEnabled: true,
  workerVersion: "",
};

function loadRouteTree(): typeof import("../../src/web/routeTree.gen").routeTree {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (isViteAsset(specifier)) {
        return {
          format: "commonjs",
          shortCircuit: true,
          url: new URL(specifier, context.parentURL).href,
        };
      }
      if (specifier === "@tanstack/react-start") {
        return next(specifier, { ...context, conditions: [...context.conditions, "import"] });
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (isViteAsset(url)) {
        return {
          format: "commonjs",
          shortCircuit: true,
          source: `module.exports = ${JSON.stringify(url.endsWith("?raw") ? "" : new URL(url).pathname)};`,
        };
      }
      return next(url, context);
    },
  });
  try {
    return require("../../src/web/routeTree.gen").routeTree;
  } finally {
    hooks.deregister();
  }
}

function isViteAsset(specifier: string) {
  return /\.(?:css|png)(?:\?url)?$/.test(specifier) || specifier.endsWith("?raw");
}

export default function AdminApp({
  initialAuthenticated = false,
  initialPath = "/admin",
  initialSearch = "",
  initialUserName,
  initialUserEmail,
  initialUserImage,
  initialPlayStationLinkEnabled = true,
  initialWorkerVersion = "",
}: {
  initialAuthenticated?: boolean;
  initialPath?: string;
  initialSearch?: string;
  initialUserName?: string;
  initialUserEmail?: string;
  initialUserImage?: string;
  initialPlayStationLinkEnabled?: boolean;
  initialWorkerVersion?: string;
}) {
  const path = initialAuthenticated ? initialPath : "/admin/login";
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path + initialSearch] }),
    context: {
      admin: initialAuthenticated
        ? {
            authenticated: true,
            userProfile: {
              name: initialUserName ?? "Admin User",
              email: initialUserEmail ?? "",
              image: initialUserImage ?? null,
            },
            playstationLinkEnabled: initialPlayStationLinkEnabled,
            workerVersion: initialWorkerVersion,
          }
        : undefined,
    },
  });
  router.stores.setMatches(
    router.matchRoutes(router.state.location).map((match) => ({
      ...match,
      context: { ...router.options.context, dashboardLocation: router.state.location },
      status: "success" as const,
    })),
  );
  return <RouterProvider router={router} />;
}

export function renderAdminRouteFixture(
  router: ReturnType<typeof createFixtureRouter>,
  context: AdminRouterContext,
) {
  const dashboardLayout = router.routesById["/admin/_dashboard"];
  const originalComponent = dashboardLayout.options.component;
  const isServer = router.isServer;
  const matches = router.state.matches;
  const { pathname, searchStr } = router.state.location;
  const routeState = getAdminRouteState({ pathname, search: searchStr });
  dashboardLayout.options.component = Outlet;
  router.isServer = true;
  router.stores.setMatches(
    matches.map((match) => ({
      ...match,
      ssr: true,
      status: match.status === "pending" ? "success" : match.status,
    })),
  );
  try {
    return renderToString(
      <AdminRouteContextProvider value={{ ...context, ...routeState, currentSearch: searchStr }}>
        <RouterProvider router={router} />
      </AdminRouteContextProvider>,
    );
  } finally {
    dashboardLayout.options.component = originalComponent;
    router.isServer = isServer;
    router.stores.setMatches(matches);
  }
}

export function createFixtureRouter(href: string) {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [href] }),
    context: { admin: authenticatedAdmin },
    isServer: false,
    origin: "https://example.test",
  });
}
