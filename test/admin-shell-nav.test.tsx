/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import {
  ADMIN_NAV_SECTION_STORAGE_KEY,
  AdminShellNav,
} from "../src/admin/components/admin-shell-nav";

const allPaths = [
  "/admin/guild-1",
  "/admin/guild-1/blocklist?tab=blocklist",
  "/admin/guild-1/player-link?platform=steam",
  "/admin/guild-1/evidence-vault",
  "/admin/guild-1/ban-cases",
  "/admin/guild-1/image-rules",
  "/admin/guild-1/bot-defense",
  "/admin/guild-1/mention-protection",
  "/admin/guild-1/lfg",
  "/admin/guild-1/clans",
  "/admin/guild-1/suggestions",
  "/admin/guild-1/events",
  "/admin/guild-1/commerce",
  "/admin/guild-1/marketplace",
  "/admin/guild-1/tickets",
  "/admin/guild-1/managed-messages",
  "/admin/guild-1/timed-roles",
  "/admin/guild-1/member-verification",
  "/admin/guild-1/webhooks",
  "/admin/guild-1/playercount",
  "/admin/guild-1/guild-settings",
  "/admin/guild-1/tickets?tab=history",
  "/admin/guild-1/audit-log",
  "/admin/guild-1/profile",
  "/admin/guild-1/troubleshooting",
];

function navProps(overrides: Partial<React.ComponentProps<typeof AdminShellNav>> = {}) {
  return {
    currentPath: "/admin/guild-1",
    currentSearch: "",
    selectedGuildId: "guild-1",
    collapsed: false,
    buildNavigationHref: (path: string) => `/admin/guild-1${path.slice("/admin".length)}`,
    onNavigate: () => undefined,
    ...overrides,
  };
}

async function renderNav(container: Element, props: React.ComponentProps<typeof AdminShellNav>) {
  let updateProps: (next: React.ComponentProps<typeof AdminShellNav>) => void = () => undefined;
  function NavRoute() {
    const [currentProps, setCurrentProps] = useState(props);
    updateProps = setCurrentProps;
    return <AdminShellNav {...currentProps} />;
  }
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: NavRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const root = createRoot(container);
  await act(async () => root.render(<RouterProvider router={router} />));
  return { root, updateProps };
}

async function withDom(run: (container: Element) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "https://example.com/",
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    self: globalThis.self,
  };
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    self: dom.window,
  });
  try {
    await run(dom.window.document.querySelector("#root")!);
  } finally {
    Object.assign(globalThis, previous);
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
}

test("admin nav defaults to Overview and exposes accessible section disclosures", async () => {
  await withDom(async (container) => {
    const { root } = await renderNav(container, navProps());
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("[aria-controls]")];
    assert.equal(buttons.length, 6);
    assert.equal(
      buttons.find((button) => button.textContent?.includes("Overview"))?.ariaExpanded,
      "true",
    );
    for (const button of buttons.slice(1)) assert.equal(button.ariaExpanded, "false");
    for (const button of buttons) {
      assert.ok(button.getAttribute("aria-controls"));
      assert.equal(
        container.querySelector(`#${button.getAttribute("aria-controls")}`)?.id,
        button.getAttribute("aria-controls"),
      );
    }
    await act(async () => root.unmount());
  });
});

test("admin nav toggles with a click and persists explicit choices", async () => {
  await withDom(async (container) => {
    const { root } = await renderNav(container, navProps());
    const moderation = [...container.querySelectorAll<HTMLButtonElement>("[aria-controls]")].find(
      (button) => button.textContent?.includes("Moderation"),
    )!;
    await act(async () => moderation.click());
    assert.equal(moderation.ariaExpanded, "true");
    assert.equal(
      JSON.parse(window.localStorage.getItem(ADMIN_NAV_SECTION_STORAGE_KEY)!).Moderation,
      true,
    );
    await act(async () => moderation.click());
    assert.equal(moderation.ariaExpanded, "false");
    await act(async () => {
      moderation.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      moderation.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      moderation.click();
    });
    assert.equal(moderation.ariaExpanded, "true");
    await act(async () => root.unmount());
  });
});

test("admin nav restores valid storage and opens active routes", async () => {
  await withDom(async (container) => {
    window.localStorage.setItem(
      ADMIN_NAV_SECTION_STORAGE_KEY,
      JSON.stringify({
        Overview: false,
        Moderation: false,
        "Community Management": true,
        "Access Control": false,
        Integrations: false,
        Configuration: false,
      }),
    );
    const { root, updateProps } = await renderNav(container, navProps());
    await act(async () => Promise.resolve());
    const section = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("[aria-controls]")].find((button) =>
        button.textContent?.includes(label),
      )!;
    assert.equal(section("Community Management").ariaExpanded, "true");
    await act(async () => updateProps(navProps({ currentPath: "/admin/guild-1/blocklist" })));
    assert.equal(section("Moderation").ariaExpanded, "true");
    assert.equal(section("Configuration").ariaExpanded, "false");
    await act(async () => root.unmount());
  });
});

test("admin nav rejects invalid stored section preferences on a fresh mount", async () => {
  await withDom(async (container) => {
    window.localStorage.setItem(ADMIN_NAV_SECTION_STORAGE_KEY, "not-json");
    const { root } = await renderNav(container, navProps());
    await act(async () => Promise.resolve());
    const section = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("[aria-controls]")].find((button) =>
        button.textContent?.includes(label),
      )!;
    assert.equal(section("Overview").ariaExpanded, "true");
    assert.equal(section("Moderation").ariaExpanded, "false");
    assert.equal(section("Configuration").ariaExpanded, "false");
    await act(async () => root.unmount());
  });
});

test("forced-open section disclosures do not mutate stored preferences", async () => {
  await withDom(async (container) => {
    const { root, updateProps } = await renderNav(container, navProps());
    const section = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("[aria-controls]")].find((button) =>
        button.textContent?.includes(label),
      )!;
    assert.equal(section("Overview").disabled, true);
    await act(async () => section("Overview").click());
    assert.equal(window.localStorage.getItem(ADMIN_NAV_SECTION_STORAGE_KEY), null);

    await act(async () =>
      updateProps(navProps({ currentPath: "/admin/guild-1/lfg", collapsed: true })),
    );
    assert.equal(section("Community Management").disabled, true);
    await act(async () => section("Community Management").click());
    assert.equal(window.localStorage.getItem(ADMIN_NAV_SECTION_STORAGE_KEY), null);
    await act(async () => root.unmount());
  });
});

test("icon-only nav keeps every route reachable and nested groups intact", async () => {
  await withDom(async (container) => {
    const { root } = await renderNav(container, navProps({ collapsed: true }));
    for (const path of allPaths) assert.ok(container.querySelector(`a[href="${path}"]`), path);
    assert.ok(container.querySelector('a[href*="blocklist?tab=limits"]'));
    assert.ok(container.querySelector('a[href*="player-link?platform=xbox"]'));
    await act(async () => root.unmount());
  });
});

test("admin nav calls onNavigate after selecting a route", async () => {
  await withDom(async (container) => {
    let navigated = 0;
    const { root } = await renderNav(container, navProps({ onNavigate: () => navigated++ }));
    const dashboard = container.querySelector<HTMLAnchorElement>('a[href="/admin/guild-1"]')!;
    await act(async () => dashboard.click());
    assert.equal(navigated, 1);
    await act(async () => root.unmount());
  });
});
