import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { LandingDemo } from "../src/landing/landing-demo";

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
    const tab = (channel: string) => container.querySelector<HTMLButtonElement>(`#tab-${channel}`)!;
    const panel = (channel: string) => container.querySelector<HTMLElement>(`#panel-${channel}`)!;
    const hydrationErrors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(container, <LandingDemo />, {
        onRecoverableError: (error) => hydrationErrors.push(error),
      });
    });
    assert.deepEqual(hydrationErrors, []);
    assert.equal(tab("community").getAttribute("aria-selected"), "true");
    assert.equal(panel("community").hidden, false);
    assert.equal(panel("mod-queue").hidden, true);

    await act(async () => toggle.click());
    assert.equal(consoleElement.hasAttribute("data-mobile-nav-open"), true);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    await act(async () => tab("mod-queue").click());
    assert.equal(consoleElement.hasAttribute("data-mobile-nav-open"), false);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(tab("mod-queue").getAttribute("aria-selected"), "true");
    assert.equal(panel("mod-queue").hidden, false);
    assert.equal(panel("community").hidden, true);
    assert.equal(document.getElementById("active-channel")?.textContent, "# mod-queue");

    await act(async () => {
      tab("mod-queue").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    assert.equal(tab("audit-log").getAttribute("aria-selected"), "true");
    assert.equal(document.activeElement, tab("audit-log"));
    assert.equal(panel("audit-log").hidden, false);

    await act(async () => toggle.click());
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(consoleElement.hasAttribute("data-mobile-nav-open"), false);

    await act(async () => toggle.click());
    await act(async () => backdrop.click());
    assert.equal(consoleElement.hasAttribute("data-mobile-nav-open"), false);
  } finally {
    await act(async () => root?.unmount());
    Object.assign(globals, previousGlobals);
    dom.window.close();
  }
});
