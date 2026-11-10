/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile via tsconfig.tests.json.
import test from "node:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  ServerOptionsEditor,
  type ServerOptionEditorValue,
} from "../src/admin/components/server-options-editor";

const initialOptions: ServerOptionEditorValue[] = [
  { id: "alpha", label: "Alpha", emoji: null },
  { id: "bravo", label: "Bravo", emoji: null },
];

test("server options preserve the focused edited value", async () => {
  const editor = await renderEditor();
  try {
    const firstLabel = editor.labels()[0];
    assert.ok(firstLabel);
    firstLabel.focus();
    setInputValue(firstLabel, "Alpha updated", editor.window);
    await act(async () => undefined);

    assert.equal(document.activeElement, firstLabel);
    assert.equal(editor.labels()[0]?.value, "Alpha updated");
  } finally {
    await editor.cleanup();
  }
});

test("server options add a blank choice", async () => {
  const editor = await renderEditor();
  try {
    await act(async () => findButton(editor.container, "Add server").click());

    assert.equal(editor.labels().length, 3);
    assert.equal(editor.labels()[2]?.value, "");
  } finally {
    await editor.cleanup();
  }
});

test("server options remove only the selected choice", async () => {
  const editor = await renderEditor();
  try {
    await act(async () => editor.removeButtons()[0]?.click());

    assert.deepEqual(
      editor.labels().map((input) => input.value),
      ["Bravo"],
    );
  } finally {
    await editor.cleanup();
  }
});

async function renderEditor() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent: () => undefined,
    detachEvent: () => undefined,
  });

  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);

  function Harness() {
    const [options, setOptions] = useState(initialOptions);
    return <ServerOptionsEditor options={options} onChange={setOptions} />;
  }

  await act(async () => root.render(<Harness />));

  return {
    container,
    window: dom.window,
    labels: () =>
      Array.from(container.querySelectorAll<HTMLInputElement>('input[aria-label="Server label"]')),
    removeButtons: () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
        (button) => button.textContent?.trim() === "Remove",
      ),
    cleanup: async () => {
      await act(async () => root.unmount());
      Object.assign(globalThis, { window: previousWindow, document: previousDocument });
      reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      dom.window.close();
    },
  };
}

function findButton(container: Element, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(button, `Expected ${label} button`);
  return button as HTMLButtonElement;
}

function setInputValue(input: HTMLInputElement, value: string, window: unknown) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  assert.ok(setter);
  setter.call(input, value);
  const EventConstructor = (window as { Event: typeof Event }).Event;
  input.dispatchEvent(new EventConstructor("input", { bubbles: true }));
}
