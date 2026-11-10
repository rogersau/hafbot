/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile via tsconfig.tests.json.
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { EmojiPicker, type EmojiPickerSelection } from "../src/admin/components/emoji-picker";
import {
  loadEmojiPickerImplementation,
  preloadEmojiPickerImplementation,
} from "../src/admin/components/emoji-picker-loader";

const guildEmojis = [
  { id: "111", name: "verified", animated: false, available: true },
  { id: "222", name: "party_blob", animated: true, available: true },
  { id: "333", name: "missing", animated: false, available: false },
];

test("EmojiPicker lets an administrator select an available server emoji", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousIntersectionObserver = (
    globalThis as typeof globalThis & {
      IntersectionObserver?: unknown;
    }
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
  let selected: EmojiPickerSelection | null = null;

  try {
    await act(async () => {
      root.render(<EmojiPicker emojis={guildEmojis} onSelect={(value) => (selected = value)} />);
    });
    assert.match(container.textContent ?? "", /Choose emoji/);

    await act(async () => findButton(container, "Choose emoji").click());
    await act(async () => findButton(container, "Server").click());

    assert.ok(container.querySelector('input[placeholder="Search server emojis..."]'));
    assert.ok(findButton(container, "verified"));
    assert.equal(findButtonOrNull(container, "missing"), null);

    await act(async () => findButton(container, "verified").click());
    assert.deepEqual(selected, {
      type: "custom",
      value: ":verified:111",
      display: "<:verified:111>",
    });
    assert.equal(findButtonOrNull(container, "Server"), null);
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

test("EmojiPicker intent preload is cached for activation", async () => {
  const preload = preloadEmojiPickerImplementation();
  const activation = loadEmojiPickerImplementation();

  assert.equal(preload, activation);
  assert.equal(typeof (await activation), "function");
});

test("EmojiPicker unicode-only mode never exposes the server emoji tab", async () => {
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
  try {
    await act(async () => {
      root.render(
        createElement(EmojiPicker, {
          emojis: guildEmojis,
          unicodeOnly: true,
          onSelect: () => undefined,
        }),
      );
    });
    await act(async () => findButton(container, "Choose emoji").click());
    assert.equal(findButtonOrNull(container, "Server"), null);
    assert.match(container.textContent ?? "", /Loading unicode emojis|Choose a Unicode emoji/);
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
