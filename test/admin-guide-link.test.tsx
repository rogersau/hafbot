/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile via tsconfig.tests.json.
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import { AdminShellHeader } from "../src/admin/components/admin-shell-header";
import { getAdminGuideUrl } from "../src/admin/dashboard-routes";

test("getAdminGuideUrl resolves flat and Guild-scoped Admin routes", () => {
  assert.equal(getAdminGuideUrl("/admin/tickets"), "https://docs.hafbot.xyz/features/tickets");
  assert.equal(getAdminGuideUrl("/admin/123456789/lfg"), "https://docs.hafbot.xyz/features/lfg");
});

test("getAdminGuideUrl handles non-matching guide slugs and fallback", () => {
  assert.equal(
    getAdminGuideUrl("/admin/playercount"),
    "https://docs.hafbot.xyz/features/player-count",
  );
  assert.equal(
    getAdminGuideUrl("/admin/123456789/audit-log"),
    "https://docs.hafbot.xyz/features/guild-audit-log",
  );
  assert.equal(
    getAdminGuideUrl("/admin/webhooks"),
    "https://docs.hafbot.xyz/features/webhook-proxy",
  );
  assert.equal(getAdminGuideUrl("/admin/unknown"), "https://docs.hafbot.xyz/admin-dashboard");
});

test("AdminShellHeader exposes a safe route-aware View guide action", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://hafbot.xyz/admin/123456789/lfg",
  });
  const previousWindow = globalThis.window;
  const previousSelf = globalThis.self;
  const previousDocument = globalThis.document;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    self: dom.window,
  });
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);

  const rootRoute = createRootRoute({
    component: () => (
      <AdminShellHeader
        pageMetadata={{ title: "LFG", description: "Find a group", icon: <span /> }}
        sidebarCollapsed={false}
        accountMenuOpen={false}
        billingHref="/admin/billing"
        profileHref="/admin/profile"
        showBilling
        signOutAction="/admin/logout"
        userProfile={{ name: "Admin User", image: "" }}
        onOpenMobileNavigation={() => {}}
        onToggleSidebar={() => {}}
        onToggleAccountMenu={() => {}}
        onCloseAccountMenu={() => {}}
        onOpenCommandPalette={() => {}}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/admin/123456789/lfg"] }),
  });

  await router.load();

  try {
    await act(async () => {
      root.render(<RouterProvider router={router} />);
    });
    await act(async () => undefined);

    const guide = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
      (anchor) => anchor.textContent?.trim() === "View guide",
    );
    assert.ok(guide);
    assert.equal(guide.href, "https://docs.hafbot.xyz/features/lfg");
    assert.equal(guide.target, "_blank");
    assert.equal(guide.rel, "noopener noreferrer");
    assert.ok(container.querySelector('[data-command-palette-trigger="true"]'));
    assert.ok(container.querySelector('[aria-label="Open account menu for Admin User"]'));
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      self: previousSelf,
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});

test("AdminShellHeader exposes an external Support action in the account menu", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://hafbot.xyz/admin/123456789/lfg",
  });
  const previousWindow = globalThis.window;
  const previousSelf = globalThis.self;
  const previousDocument = globalThis.document;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    self: dom.window,
  });
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  let closeCount = 0;

  const rootRoute = createRootRoute({
    component: () => (
      <AdminShellHeader
        pageMetadata={{ title: "LFG", description: "Find a group", icon: <span /> }}
        sidebarCollapsed={false}
        accountMenuOpen
        billingHref="/admin/billing"
        profileHref="/admin/profile"
        showBilling
        signOutAction="/admin/logout"
        userProfile={{ name: "Admin User", image: "" }}
        onOpenMobileNavigation={() => {}}
        onToggleSidebar={() => {}}
        onToggleAccountMenu={() => {}}
        onCloseAccountMenu={() => {
          closeCount += 1;
        }}
        onOpenCommandPalette={() => {}}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/admin/123456789/lfg"] }),
  });

  await router.load();

  try {
    await act(async () => {
      root.render(<RouterProvider router={router} />);
    });
    await act(async () => undefined);

    const support = [...container.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]')].find(
      (anchor) => anchor.textContent?.trim() === "Support",
    );
    assert.ok(support);
    assert.equal(support.tagName, "A");
    assert.equal(support.href, "https://discord.gg/HpRPkdm6dv");
    assert.equal(support.target, "_blank");
    assert.equal(support.rel, "noopener noreferrer");
    assert.equal(support.getAttribute("role"), "menuitem");
    assert.equal(
      support.className,
      "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
    );
    assert.ok(container.querySelector('[role="menuitem"][href="/admin/profile"]'));
    assert.ok(container.querySelector('[role="menuitem"][href="/admin/billing"]'));
    assert.ok(container.querySelector('[role="menuitem"][href="/changelog"]'));
    assert.ok(
      container.querySelector(
        'form[action="/admin/logout"] button[type="submit"][role="menuitem"]',
      ),
    );
    assert.ok(container.querySelector('[role="menuitem"]')?.closest('[role="menu"]'));
    assert.match(container.textContent ?? "", /What's New/);
    assert.match(container.textContent ?? "", /Sign out/);
    assert.ok(container.querySelector('[aria-label="View guide"]'));

    await act(async () => {
      support.click();
    });
    assert.equal(closeCount, 1);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      self: previousSelf,
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});
