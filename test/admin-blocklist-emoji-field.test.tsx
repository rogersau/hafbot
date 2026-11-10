/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile via tsconfig.tests.json.
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  BlocklistEmojiField,
  type BlocklistEmojiFieldProps,
} from "../src/admin/components/blocklist-emoji-field";

const guildEmojis = [
  { id: "111", name: "verified", animated: false, available: true },
  { id: "222", name: "party_blob", animated: true, available: true },
  { id: "333", name: "new_blob", animated: false, available: true },
];

test("BlocklistEmojiField keeps a draft open for review before one batch submit", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousIntersectionObserver = (
    globalThis as typeof globalThis & { IntersectionObserver?: unknown }
  ).IntersectionObserver;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent: () => undefined,
    detachEvent: () => undefined,
  });

  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  const submitted: string[][] = [];
  let shouldSucceed = true;
  const props: BlocklistEmojiFieldProps = {
    currentEmojis: ["verified:111", "✅"],
    emojis: guildEmojis,
    onSubmit: async (emojis) => {
      submitted.push(emojis);
      return shouldSucceed;
    },
  };

  try {
    await act(async () => root.render(createElement(BlocklistEmojiField, props)));
    await act(async () => findButton(container, "Choose emojis").click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.equal(container.querySelector('button[data-unified="2705"]'), null);
    await act(async () => findButton(container, "Server").click());

    const alreadyBlocked = findButton(container, "verified");
    assert.equal(alreadyBlocked.disabled, true);

    await act(async () => findButton(container, "party_blob").click());
    assert.match(container.textContent ?? "", /Add 1 emoji/);
    assert.ok(findButtonOrNull(container, "Server"));

    await act(async () => findButton(container, "Remove party_blob:222 from selection").click());
    assert.doesNotMatch(container.textContent ?? "", /Add 1 emoji/);

    await act(async () => findButton(container, "party_blob").click());
    await act(async () => findButton(container, "Cancel").click());
    assert.doesNotMatch(container.textContent ?? "", /Add 1 emoji/);
    assert.deepEqual(submitted, []);

    await act(async () => findButton(container, "party_blob").click());
    await act(async () => findButton(container, "new_blob").click());
    assert.match(container.textContent ?? "", /Add 2 emojis/);

    await act(async () => findButton(container, "Add 2 emojis").click());
    assert.deepEqual(submitted, [["party_blob:222", "new_blob:333"]]);
    assert.doesNotMatch(container.textContent ?? "", /Add 2 emojis/);

    shouldSucceed = false;
    await act(async () => findButton(container, "party_blob").click());
    await act(async () => findButton(container, "Add 1 emoji").click());
    assert.deepEqual(submitted, [["party_blob:222", "new_blob:333"], ["party_blob:222"]]);
    assert.match(container.textContent ?? "", /Add 1 emoji/);
    assert.match(container.textContent ?? "", /Already blocked: verified:111, ✅/);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      IntersectionObserver: previousIntersectionObserver,
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});

function findButton(container: Element, label: string): HTMLButtonElement {
  const button = findButtonOrNull(container, label);
  assert.ok(button, `Expected ${label} button`);
  return button;
}

function findButtonOrNull(container: Element, label: string): HTMLButtonElement | null {
  return (
    (Array.from(container.querySelectorAll("button")).find(
      (candidate) =>
        candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
    ) as HTMLButtonElement | undefined) ?? null
  );
}
