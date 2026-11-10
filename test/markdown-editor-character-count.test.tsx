/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile via tsconfig.tests.json.
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  getMarkdownCharacterCountTone,
  MarkdownEditor,
} from "../src/admin/components/markdown-editor";

test("Markdown character count tones change at the documented thresholds", () => {
  assert.equal(getMarkdownCharacterCountTone(1_799, 2_000), "normal");
  assert.equal(getMarkdownCharacterCountTone(1_800, 2_000), "warning");
  assert.equal(getMarkdownCharacterCountTone(1_999, 2_000), "warning");
  assert.equal(getMarkdownCharacterCountTone(2_000, 2_000), "limit");
});

test("MarkdownEditor keeps a formatted count visible in Write, Preview, and disabled states", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <MarkdownEditor
          value={"x".repeat(1_800)}
          maxLength={2_000}
          helpText="Discord message body"
          disabled
          onChange={() => {}}
        />,
      );
    });

    const count = container.querySelector('[data-character-count-tone="warning"]');
    assert.ok(count);
    assert.equal(count.textContent, "1,800 / 2,000");
    assert.match(container.textContent ?? "", /Discord message body/);

    const preview = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Preview",
    );
    assert.ok(preview);
    await act(async () => {
      preview.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    assert.equal(
      container.querySelector('[data-character-count-tone="warning"]')?.textContent,
      "1,800 / 2,000",
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
    if (previousNavigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", previousNavigatorDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});

test("MarkdownEditor remains unchanged when maxLength is omitted", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(<MarkdownEditor value="hello" onChange={() => {}} />);
    });
    assert.equal(container.querySelector("[data-character-count-tone]"), null);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
    if (previousNavigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", previousNavigatorDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});
