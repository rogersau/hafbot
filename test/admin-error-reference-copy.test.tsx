/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile via tsconfig.tests.json.
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { AdminErrorNotice } from "../src/admin/components/admin-error-notice";
import { ToastProvider } from "../src/admin/components/toast";
import { AdminApiError } from "../src/admin/lib/api";

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
    if (previousDescriptor) Object.defineProperty(globalThis, "navigator", previousDescriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
  };
}

async function renderNotice(error: unknown, writeText: ClipboardWrite) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
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

  await act(async () => {
    root.render(
      <ToastProvider>
        <AdminErrorNotice error={error} />
      </ToastProvider>,
    );
  });

  return {
    container,
    async clickCopy() {
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === "Copy reference",
      );
      assert.ok(button);
      await act(async () => {
        button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
    },
    async cleanup() {
      await act(async () => root.unmount());
      restoreClipboard();
      Object.assign(globalThis, { window: previousWindow, document: previousDocument });
      reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      dom.window.close();
    },
  };
}

test("AdminErrorNotice copies only a valid correlation ID", async () => {
  let copied = "";
  const rendered = await renderNotice(
    new AdminApiError("Request failed", 500, "internal_error", "abc-123", false),
    async (value) => {
      copied = value;
    },
  );

  try {
    await rendered.clickCopy();
    assert.equal(copied, "abc-123");
    assert.match(rendered.container.textContent ?? "", /Reference copied\./);
  } finally {
    await rendered.cleanup();
  }
});

test("AdminErrorNotice reports clipboard failure", async () => {
  const rendered = await renderNotice(
    new AdminApiError("Request failed", 500, "internal_error", "abc-123", false),
    async () => {
      throw new Error("permission denied");
    },
  );

  try {
    await rendered.clickCopy();
    assert.match(rendered.container.textContent ?? "", /Could not copy the reference\./);
    assert.doesNotMatch(rendered.container.textContent ?? "", /Reference copied\./);
  } finally {
    await rendered.cleanup();
  }
});

test("AdminErrorNotice omits copy action for unknown and non-API errors", async () => {
  for (const error of [
    new AdminApiError("Request failed", 500, "internal_error", "unknown", false),
    new Error("Request failed"),
  ]) {
    const rendered = await renderNotice(error, async () => undefined);
    try {
      assert.doesNotMatch(rendered.container.textContent ?? "", /Copy reference/);
    } finally {
      await rendered.cleanup();
    }
  }
});
