/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { AdminBanCasesPage } from "../src/admin/components/admin-ban-cases-page";
import { ToastProvider } from "../src/admin/components/toast";
import type { BanCasesLoaderData } from "../src/admin/lib/admin-route-loaders";

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

function createDom() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "https://example.com/admin/workspace-1/guild-1/ban-cases",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  });

  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);

  return {
    dom,
    root,
    container,
    previousWindow,
    previousDocument,
    previousFetch,
    reactActEnvironment,
    previousActEnvironment,
  };
}

async function restoreDom(env: ReturnType<typeof createDom>) {
  await act(async () => env.root.unmount());
  Object.assign(globalThis, {
    window: env.previousWindow,
    document: env.previousDocument,
    fetch: env.previousFetch,
  });
  env.reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = env.previousActEnvironment;
  env.dom.window.close();
}

function createInitialData(): BanCasesLoaderData {
  return {
    guildId: "guild-1",
    config: null,
    sources: [
      {
        guildId: "guild-1",
        sourceId: "source-1",
        publicId: "source-alpha",
        name: "Matchmaker",
        enabled: true,
        platform: "steam",
        pattern: "(?<steamId>\\d+)",
        flags: "",
        subjectIdGroup: "steamId",
        nameGroup: "name",
        reasonGroup: "reason",
        createdAtMs: 1,
        updatedAtMs: 2,
      },
    ],
  };
}

async function renderPage(env: ReturnType<typeof createDom>) {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("/admin/api/tickets/resources")) {
      return Response.json({
        guildId: "guild-1",
        roles: [],
        categories: [],
        textChannels: [],
        voiceChannels: [],
        forumChannels: [],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  await act(async () => {
    env.root.render(
      <ToastProvider>
        <AdminBanCasesPage
          selectedWorkspaceId="workspace-1"
          selectedGuildId="guild-1"
          initialData={createInitialData()}
        />
      </ToastProvider>,
    );
  });
}

function getCopyButton(env: ReturnType<typeof createDom>): HTMLButtonElement {
  const button = [...env.container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === "Copy",
  );
  assert.ok(button);
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

test("Ban Cases copies the exact public webhook URL and reports success", async () => {
  let copied = "";
  const restoreClipboard = installClipboard(async (value) => {
    copied = value;
  });
  const env = createDom();

  try {
    await renderPage(env);
    await click(getCopyButton(env));

    assert.equal(copied, "https://example.com/ban-cases/source-alpha");
    assert.match(env.container.textContent ?? "", /Webhook URL copied\./);
  } finally {
    await restoreDom(env);
    restoreClipboard();
  }
});

test("Ban Cases reports clipboard failure without claiming success", async () => {
  const restoreClipboard = installClipboard(async () => {
    throw new Error("permission denied");
  });
  const env = createDom();

  try {
    await renderPage(env);
    await click(getCopyButton(env));

    assert.match(env.container.textContent ?? "", /Failed to copy to clipboard\./);
    assert.doesNotMatch(env.container.textContent ?? "", /Webhook URL copied\./);
  } finally {
    await restoreDom(env);
    restoreClipboard();
  }
});
