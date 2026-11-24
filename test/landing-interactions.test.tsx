import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { ChangelogPage } from "../src/landing/changelog-page";
import { LandingHomePage } from "../src/landing/home-page";
import { LandingDemo } from "../src/landing/landing-demo";
import { PRIVACY_POLICY_HTML, TERMS_OF_SERVICE_HTML } from "../src/routes/legal-pages";

test("public documents place a skip link before navigation and make main focusable", () => {
  const documents = [
    renderToString(<LandingHomePage prices={[]} />),
    renderToString(<ChangelogPage />),
    TERMS_OF_SERVICE_HTML,
    PRIVACY_POLICY_HTML,
  ];
  for (const markup of documents) {
    const dom = new JSDOM(markup);
    try {
      const { document } = dom.window;
      const firstLink = document.querySelector("a[href]");
      assert.equal(firstLink?.textContent, "Skip to main content");
      assert.equal(firstLink?.getAttribute("href"), "#main-content");
      const main = document.querySelector<HTMLElement>("main#main-content");
      assert.equal(main?.getAttribute("tabindex"), "-1");
      main?.focus();
      assert.equal(document.activeElement, main);
    } finally {
      dom.window.close();
    }
  }
});

test("the server-rendered Discord demo hydrates and supports keyboard selection and mobile navigation", async () => {
  const markup = renderToString(<LandingDemo />);
  const dom = new JSDOM(`<!doctype html><div id="demo">${markup}</div>`, {
    pretendToBeVisual: true,
  });
  const { document, KeyboardEvent } = dom.window;
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousGlobals = {
    window: globals.window,
    document: globals.document,
    IS_REACT_ACT_ENVIRONMENT: globals.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globals, { window: dom.window, document, IS_REACT_ACT_ENVIRONMENT: true });
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    const container = document.getElementById("demo")!;
    const consoleElement = container.querySelector<HTMLElement>(".discord-console")!;
    const toggle = container.querySelector<HTMLButtonElement>(".mobile-channel-toggle")!;
    const backdrop = container.querySelector<HTMLButtonElement>(".mobile-channel-backdrop")!;
    const panel = (tab: HTMLButtonElement) =>
      document.getElementById(tab.getAttribute("aria-controls")!)!;
    const key = (target: Element, name: string) =>
      act(async () =>
        target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })),
      );
    const hydrationErrors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(container, <LandingDemo />, {
        onRecoverableError: (error) => hydrationErrors.push(error),
      });
    });
    assert.deepEqual(hydrationErrors, []);
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const selectedIndex = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
    const selected = tabs[selectedIndex];
    const next = tabs[(selectedIndex + 1) % tabs.length];
    assert.ok(next !== selected);
    assert.equal(panel(selected).hidden, false);
    assert.equal(panel(next).hidden, true);

    await act(async () => toggle.click());
    assert.equal(consoleElement.hasAttribute("data-mobile-nav-open"), true);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(document.activeElement, selected);

    await key(selected, "ArrowDown");
    assert.equal(document.activeElement, next);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    await act(async () => next.click());
    assert.equal(consoleElement.hasAttribute("data-mobile-nav-open"), false);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(next.getAttribute("aria-selected"), "true");
    assert.equal(panel(next).hidden, false);
    assert.equal(panel(selected).hidden, true);
    assert.equal(document.getElementById("active-channel")?.textContent, next.textContent);
    assert.equal(document.activeElement, toggle);

    const firstTab = tabs[0];
    const lastTab = tabs.at(-1)!;
    await key(next, "Home");
    assert.equal(document.activeElement, firstTab);
    await key(firstTab, "ArrowUp");
    assert.equal(document.activeElement, lastTab);
    await key(lastTab, "ArrowDown");
    assert.equal(document.activeElement, firstTab);
    await key(firstTab, "End");
    assert.equal(document.activeElement, lastTab);
    assert.equal(lastTab.getAttribute("aria-selected"), "true");
    assert.equal(lastTab.tabIndex, 0);
    assert.equal(firstTab.tabIndex, -1);
    const activePanel = panel(lastTab);
    assert.equal(activePanel?.getAttribute("tabindex"), "0");
    assert.equal(activePanel?.hidden, false);

    await act(async () => toggle.click());
    await key(lastTab, "Escape");
    assert.equal(consoleElement.hasAttribute("data-mobile-nav-open"), false);
    assert.equal(document.activeElement, toggle);

    await act(async () => toggle.click());
    await act(async () => backdrop.click());
    assert.equal(consoleElement.hasAttribute("data-mobile-nav-open"), false);
    assert.equal(document.activeElement, toggle);

    await act(async () => toggle.click());
    await act(async () => activePanel?.focus());
    assert.equal(consoleElement.hasAttribute("data-mobile-nav-open"), false);
    assert.equal(document.activeElement, activePanel);
  } finally {
    await act(async () => root?.unmount());
    Object.assign(globals, previousGlobals);
    dom.window.close();
  }
});
