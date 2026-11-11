/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Tests compile via tsconfig.tests.json; admin React is excluded from the runtime test build.
import test from "node:test";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";

import "./support/admin-page-test-loader";

import type { AdminRouterContext } from "../src/admin/routes/context";
import { AdminRouteContextProvider } from "../src/admin/routes/page-context";
import { routeTree } from "../src/admin/routes/route-tree";
import { AdminApiError } from "../src/admin/lib/api";
import { getGuildEntitlementLimits } from "../src/types";

const affectedPages = [
  {
    name: "Evidence Vault",
    routeId: "/admin/$guildId/evidence-vault",
    path: "/admin/guild-1/evidence-vault",
    configPath: "/admin/api/evidence-vault",
    editorMarker: 'id="ev-audit-channel"',
    firstRun: {
      guildId: "guild-1",
      config: null,
      enumValueUsage: {},
      recordUsage: { used: 7, max: 30 },
    },
  },
  {
    name: "Image Rules",
    routeId: "/admin/$guildId/image-rules",
    path: "/admin/guild-1/image-rules",
    configPath: "/admin/api/image-rules",
    editorMarker: 'id="ir-topic-description"',
    firstRun: { guildId: "guild-1", config: null },
  },
  {
    name: "Bot Defense",
    routeId: "/admin/$guildId/bot-defense",
    path: "/admin/guild-1/bot-defense",
    configPath: "/admin/api/bot-defense",
    editorMarker: 'aria-label="Enable Honeypot Detector"',
    firstRun: { guildId: "guild-1", config: null },
  },
  {
    name: "Member Verification",
    routeId: "/admin/$guildId/member-verification",
    path: "/admin/guild-1/member-verification",
    configPath: "/admin/api/member-verification",
    editorMarker: 'id="delivery-mode"',
    firstRun: {
      guildId: "guild-1",
      config: null,
      paidMethodsAvailable: false,
      turnstileAvailable: false,
      steamLinkAvailable: true,
    },
  },
] as const;

test("failed configuration loaders render the shared route error and retry UI instead of an editor", async () => {
  const originalFetch = globalThis.fetch;
  const failures = [
    { status: 401, code: "authentication_required", action: "sign_in" },
    { status: 403, code: "permission_denied", action: "retry" },
    { status: 503, code: "service_unavailable", action: "retry" },
  ] as const;
  try {
    for (const page of affectedPages) {
      for (const failure of failures) {
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url = new URL(String(input), "https://fixture.local");
          if (url.pathname === "/admin/api/entitlement") return premiumEntitlementResponse();
          if (url.pathname === page.configPath) {
            return Response.json(
              {
                error: `${page.name} configuration is unavailable`,
                code: failure.code,
                correlationId: "fictional-reference",
                retryable: failure.status >= 500,
                action: failure.action,
              },
              { status: failure.status },
            );
          }
          if (url.pathname === "/admin/api/product-analytics/events") return Response.json({});
          throw new Error(`Unexpected request: ${url.pathname}`);
        }) as typeof fetch;

        const context = createFixtureContext(page.path);
        const router = createFixtureRouter(context);
        await router.load();

        const match = router.state.matches.find((candidate) => candidate.routeId === page.routeId);
        assert.equal(
          match?.status,
          "error",
          `${page.name} HTTP ${failure.status} must enter the route error state`,
        );
        assert.ok(match?.error instanceof AdminApiError);
        assert.equal(match.error.status, failure.status);

        const html = renderFixtureRouter(router, context);
        assert.match(html, /role="alert"/);
        assert.match(html, />Retry</);
        assert.match(html, /configuration is unavailable/);
        assert.doesNotMatch(
          html,
          new RegExp(page.editorMarker),
          `${page.name} HTTP ${failure.status} must not render an editor backed by invented defaults`,
        );
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed configuration responses also stop at the shared route error boundary", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const page of affectedPages) {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://fixture.local");
        if (url.pathname === "/admin/api/entitlement") return premiumEntitlementResponse();
        if (url.pathname === page.configPath) {
          return new Response('{"config":', {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/admin/api/product-analytics/events") return Response.json({});
        throw new Error(`Unexpected request: ${url.pathname}`);
      }) as typeof fetch;

      const context = createFixtureContext(page.path);
      const router = createFixtureRouter(context);
      await router.load();

      const match = router.state.matches.find((candidate) => candidate.routeId === page.routeId);
      assert.equal(
        match?.status,
        "error",
        `${page.name} malformed JSON must enter the error state`,
      );
      assert.ok(match?.error instanceof SyntaxError);

      const html = renderFixtureRouter(router, context);
      assert.match(html, /role="alert"/);
      assert.match(html, />Retry</);
      assert.doesNotMatch(
        html,
        new RegExp(page.editorMarker),
        `${page.name} malformed JSON must not render an editor backed by invented defaults`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("successful first-run configuration:null still renders the normal setup editor", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const page of affectedPages) {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://fixture.local");
        if (url.pathname === "/admin/api/entitlement") return premiumEntitlementResponse();
        if (url.pathname === page.configPath) return Response.json(page.firstRun);
        if (url.pathname === "/admin/api/product-analytics/events") return Response.json({});
        throw new Error(`Unexpected request: ${url.pathname}`);
      }) as typeof fetch;

      const context = createFixtureContext(page.path);
      const router = createFixtureRouter(context);
      await router.load();

      const match = router.state.matches.find((candidate) => candidate.routeId === page.routeId);
      assert.equal(match?.status, "success", `${page.name} first run must load successfully`);

      const html = renderFixtureRouter(router, context);
      assert.match(html, new RegExp(page.editorMarker));
      assert.doesNotMatch(html, /role="alert"/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function premiumEntitlementResponse() {
  const limits = getGuildEntitlementLimits("premium");
  return Response.json({
    tier: "premium",
    limits,
    supportInvite: null,
    r2Usage: {
      usedBytes: 0,
      reservedBytes: 0,
      maxBytes: limits.r2MaxBytes,
      lastReconciledAtMs: null,
    },
  });
}

function createFixtureRouter(context: AdminRouterContext) {
  return createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: [`${context.currentPath}?workspaceId=workspace-1`],
    }),
    context,
  });
}

function renderFixtureRouter(
  router: ReturnType<typeof createFixtureRouter>,
  context: AdminRouterContext,
) {
  return renderToString(
    <AdminRouteContextProvider value={context}>
      <RouterProvider router={router} context={context} />
    </AdminRouteContextProvider>,
  );
}

function createFixtureContext(currentPath: string): AdminRouterContext {
  return {
    currentPath,
    currentSearch: "?workspaceId=workspace-1",
    selectedWorkspaceId: "workspace-1",
    selectedGuildId: "guild-1",
    pathGuildId: "guild-1",
    reactionRulesTab: "blocklist",
    playerLinkPlatform: "steam",
    ticketsTab: "panel",
    commerceTab: "offerings",
    defaultRedirectTarget: null,
    guildDirectory: [{ guildId: "guild-1", name: "Alpha", label: "Alpha", icon: null }],
    guildLookupError: null,
    guildResourcesRefreshVersion: 0,
    onSelectedGuildChange: () => {},
    refreshGuildDirectory: async () => {},
    onRefresh: async () => {},
    playstationLinkEnabled: true,
    entitlement: null,
    userProfile: {
      name: "Admin User",
      email: "",
      image: "",
    },
    userPreferences: {
      hiddenGuildIds: [],
      defaultGuildId: null,
      emailNotifications: true,
      pushNotifications: false,
      theme: "system",
      language: "en",
    },
    applyUserPreferencesPatch: async () => undefined,
    pageMetadata: null,
    setPageMetadata: () => {},
    isRoutePending: false,
  };
}
