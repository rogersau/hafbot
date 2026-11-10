/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { act, useRef, useState, type ReactNode } from "react";
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
  captureCommandPaletteReturnFocus,
  restoreCommandPaletteFocus,
} from "../src/admin/components/admin-command-palette";
import { AdminShell } from "../src/admin/components/admin-shell";
import { CommandPalette } from "../src/admin/components/command-palette";
import { DEFAULT_USER_PREFERENCES } from "../src/runtime/admin-types";

test("command palette restores focus for button and keyboard-shortcut dismissal", async () => {
  await withDom(async (container) => {
    container.innerHTML =
      '<button type="button">Open command palette</button><button type="button">Shortcut origin</button><input />';
    const buttons = container.querySelectorAll("button");
    const trigger = buttons[0] as HTMLButtonElement;
    const shortcutOrigin = buttons[1] as HTMLButtonElement;
    const paletteInput = container.querySelector("input") as HTMLInputElement;
    const returnFocusRef = { current: null as HTMLElement | null };

    trigger.focus();
    captureCommandPaletteReturnFocus(returnFocusRef);
    paletteInput.focus();
    restoreCommandPaletteFocus(returnFocusRef);
    await Promise.resolve();
    assert.ok(document.activeElement === trigger, "focus returns to the palette trigger");

    shortcutOrigin.focus();
    captureCommandPaletteReturnFocus(returnFocusRef);
    paletteInput.focus();
    restoreCommandPaletteFocus(returnFocusRef);
    await Promise.resolve();
    assert.equal(document.activeElement, shortcutOrigin);
  });
});

test("command palette traps Tab, isolates the background, and restores focus on Escape", async () => {
  await withDom(async (container) => {
    const preservedBackground = document.createElement("div");
    preservedBackground.setAttribute("inert", "inert");
    preservedBackground.setAttribute("aria-hidden", "true");
    document.body.appendChild(preservedBackground);
    container.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "auto";
    let triggerFocusCount = 0;

    function PaletteHarness() {
      const [open, setOpen] = useState(false);
      const returnFocusRef = useRef<HTMLElement | null>(null);
      return (
        <>
          <button
            onFocus={() => {
              triggerFocusCount += 1;
            }}
            onClick={() => {
              captureCommandPaletteReturnFocus(returnFocusRef);
              setOpen(true);
            }}
          >
            Open search
          </button>
          <CommandPalette
            open={open}
            items={[{ id: "tickets", label: "Tickets" }]}
            onSelect={() => undefined}
            onDismiss={() => {
              setOpen(false);
              restoreCommandPaletteFocus(returnFocusRef);
            }}
          />
        </>
      );
    }

    const root = createRoot(container);
    await act(async () => root.render(<PaletteHarness />));
    const trigger = container.querySelector("button")!;
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = document.querySelector('[data-command-palette="true"]')!;
    const input = dialog.querySelector("input")!;
    assert.equal(document.activeElement, input);
    assert.ok(container.hasAttribute("inert"));
    assert.equal(container.getAttribute("aria-hidden"), "true");
    assert.equal(dialog.closest("[inert]"), null);
    assert.equal(document.body.style.overflow, "hidden");

    const initialTriggerFocusCount = triggerFocusCount;
    await act(async () => root.render(<PaletteHarness />));
    assert.equal(triggerFocusCount, initialTriggerFocusCount);
    assert.equal(document.activeElement, input);

    for (const shiftKey of [false, true]) {
      const event = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => input.dispatchEvent(event));
      assert.equal(event.defaultPrevented, true);
      assert.equal(document.activeElement, input);
    }
    await act(async () => trigger.focus());
    assert.equal(document.activeElement, input);

    let backgroundEscapes = 0;
    const handleBackgroundEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") backgroundEscapes += 1;
    };
    window.addEventListener("keydown", handleBackgroundEscape);
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    window.removeEventListener("keydown", handleBackgroundEscape);
    assert.equal(backgroundEscapes, 0);
    assert.equal(document.querySelector('[data-command-palette="true"]'), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(container.hasAttribute("inert"), false);
    assert.equal(container.getAttribute("aria-hidden"), "false");
    assert.equal(preservedBackground.getAttribute("inert"), "inert");
    assert.equal(preservedBackground.getAttribute("aria-hidden"), "true");
    assert.equal(document.body.style.overflow, "auto");

    await act(async () => trigger.click());
    assert.equal(document.body.style.overflow, "hidden");
    await act(async () => root.unmount());
    assert.equal(container.hasAttribute("inert"), false);
    assert.equal(container.getAttribute("aria-hidden"), "false");
    assert.equal(preservedBackground.getAttribute("inert"), "inert");
    assert.equal(preservedBackground.getAttribute("aria-hidden"), "true");
    assert.equal(document.body.style.overflow, "auto");
  });
});

test("mobile navigation traps focus, makes content inert, closes on Escape, and restores focus", async () => {
  await withDom(async (container) => {
    const shell = (
      <AdminShell
        currentPath="/admin"
        currentSearch=""
        guildDirectory={[]}
        guildLookupError={null}
        selectedGuildId=""
        onSelectedGuildChange={() => undefined}
        refreshGuildDirectory={async () => undefined}
        selectedWorkspaceId=""
        buildNavigationHref={(path) => path}
        playstationLinkEnabled
        userProfile={{ name: "Alex Morgan", image: "" }}
        userPreferences={DEFAULT_USER_PREFERENCES}
        applyUserPreferencesPatch={async () => undefined}
        pageMetadata={null}
      >
        <button type="button">Page action</button>
      </AdminShell>
    );

    const root = await renderInRouter(container, shell);
    const trigger = container.querySelector(
      '[aria-label="Open navigation menu"]',
    ) as HTMLButtonElement;
    await act(async () => trigger.click());

    const close = container.querySelector(
      'aside [aria-label="Close navigation menu"]',
    ) as HTMLButtonElement;
    const content = container.querySelector(".admin-shell-content") as HTMLElement;
    assert.equal(document.activeElement, close);
    assert.ok(content.hasAttribute("inert"));
    assert.equal(content.getAttribute("aria-hidden"), "true");
    assert.equal(document.body.style.overflow, "hidden");

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(document.activeElement, trigger);
    assert.equal(content.hasAttribute("inert"), false);
    assert.equal(document.body.style.overflow, "");
    await act(async () => root.unmount());
  });
});

async function renderInRouter(container: Element, component: ReactNode) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => component,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const root = createRoot(container);
  await act(async () => root.render(<RouterProvider router={router} />));
  return root;
}

async function withDom(run: (container: Element) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://example.com/" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    KeyboardEvent: globalThis.KeyboardEvent,
    self: globalThis.self,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    self: dom.window,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
  });
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent: () => undefined,
    detachEvent: () => undefined,
    scrollIntoView: () => undefined,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);

  try {
    await run(container);
  } finally {
    Object.assign(globalThis, previous);
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
}
