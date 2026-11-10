/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { JSDOM } from "jsdom";

import { enhanceLandingChannels } from "../src/landing/landing-channels";

test("landing Discord channels support click and roving keyboard selection", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <b id="active-channel"># one</b>
    <div role="tablist">
      <button role="tab" data-channel="one" aria-selected="true" tabindex="0"># one</button>
      <button role="tab" data-channel="two" aria-selected="false" tabindex="-1"># two</button>
    </div>
    <section role="tabpanel" data-panel="one"></section>
    <section role="tabpanel" data-panel="two" hidden></section>
  </body>`);
  const { document, KeyboardEvent, MouseEvent } = dom.window;
  enhanceLandingChannels(document);
  const tabs = document.querySelectorAll<HTMLButtonElement>("[role=tab]");
  const panels = document.querySelectorAll<HTMLElement>("[role=tabpanel]");

  tabs[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(tabs[1]!.getAttribute("aria-selected"), "true");
  assert.equal(panels[0]!.hidden, true);
  assert.equal(panels[1]!.hidden, false);
  assert.equal(document.getElementById("active-channel")?.textContent, "# two");

  tabs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(tabs[0]!.getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement, tabs[0]);
  assert.equal(panels[0]!.hidden, false);
});

test("landing Discord mobile channel drawer opens, closes, and follows selection", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="discord-console">
      <button class="mobile-channel-toggle" aria-expanded="false"></button>
      <button class="mobile-channel-backdrop"></button>
      <aside class="channel-rail">
        <button role="tab" data-channel="one" aria-selected="true"># one</button>
        <button role="tab" data-channel="two" aria-selected="false"># two</button>
      </aside>
      <b id="active-channel"># one</b>
      <section role="tabpanel" data-panel="one"></section>
      <section role="tabpanel" data-panel="two" hidden></section>
    </div>
  </body>`);
  const { document, KeyboardEvent, MouseEvent } = dom.window;
  enhanceLandingChannels(document);
  const consoleElement = document.querySelector<HTMLElement>(".discord-console")!;
  const toggle = document.querySelector<HTMLButtonElement>(".mobile-channel-toggle")!;
  const backdrop = document.querySelector<HTMLButtonElement>(".mobile-channel-backdrop")!;
  const tabs = document.querySelectorAll<HTMLButtonElement>("[role=tab]");

  toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(consoleElement.hasAttribute("data-mobile-nav-open"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  tabs[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(consoleElement.hasAttribute("data-mobile-nav-open"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(consoleElement.hasAttribute("data-mobile-nav-open"), false);

  toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.equal(consoleElement.hasAttribute("data-mobile-nav-open"), false);
});
