/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile via tsconfig.tests.json.
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { AdminPageHeader } from "../src/admin/components/admin-page-header";
import { ToastProvider } from "../src/admin/components/toast";

type ClipboardWrite = (value: string) => Promise<void>;

function installClipboard(writeText: ClipboardWrite): () => void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousNavigator = (globalThis as typeof globalThis & { navigator?: Navigator }).navigator;
  const nextNavigator = previousNavigator
    ? (Object.create(previousNavigator) as Navigator)
    : ({} as Navigator);

  Object.defineProperty(nextNavigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: nextNavigator,
  });

  return () => {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, "navigator", previousDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  };
}

async function exerciseCopy(writeText: ClipboardWrite) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://hafbot.xyz/admin/workspace-1/guild-1/lfg?tab=setup#notice",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const restoreClipboard = installClipboard(writeText);
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <ToastProvider>
          <AdminPageHeader title="LFG" />
        </ToastProvider>,
      );
    });
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === "Copy page link",
    );
    assert.ok(button);
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    return container.textContent ?? "";
  } finally {
    await act(async () => root.unmount());
    restoreClipboard();
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
}

test("Copy page link copies the exact current deep link and reports success", async () => {
  let copied = "";
  const text = await exerciseCopy(async (value) => {
    copied = value;
  });

  assert.equal(copied, "https://hafbot.xyz/admin/workspace-1/guild-1/lfg?tab=setup#notice");
  assert.match(text, /Page link copied\./);
});

test("Copy page link reports clipboard failure", async () => {
  const text = await exerciseCopy(async () => {
    throw new Error("permission denied");
  });

  assert.match(text, /Could not copy the page link\./);
  assert.doesNotMatch(text, /Page link copied\./);
});
