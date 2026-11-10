/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { AdminWebhooksPage } from "../src/admin/components/admin-webhooks-page";
import { ToastProvider } from "../src/admin/components/toast";
import type { WebhooksLoaderData } from "../src/admin/lib/admin-route-loaders";

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
    url: "https://example.com/admin/workspace-1/guild-1/webhooks",
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

function createInboundData(): WebhooksLoaderData {
  return {
    guildId: "guild-1",
    configs: [
      {
        guildId: "guild-1",
        publicId: "hook-abc",
        name: "Primary webhook",
        enabled: true,
        banLookupEnabled: false,
        banLookupNotificationUrl: null,
        banLookupAppIds: [],
        destinations: [
          {
            id: "main",
            label: "Main",
            url: "https://discord.com/api/webhooks/original",
          },
        ],
        defaultDestinationIds: ["main"],
        routingRules: [],
        contentReplacements: [],
        createdAtMs: 0,
        updatedAtMs: 0,
      },
    ],
  } as unknown as WebhooksLoaderData;
}

function createCredentialData(): WebhooksLoaderData {
  return {
    guildId: "guild-1",
    configs: [
      {
        guildId: "guild-1",
        publicId: "hook-abc",
        name: "Primary webhook",
        enabled: true,
        banLookupEnabled: false,
        banLookupNotificationUrl: null,
        banLookupAppIds: [],
        destinations: [
          {
            id: "main",
            label: "Main",
            credential: {
              configured: true,
              credentialId: "cred-1",
              provider: "discord",
              fingerprint: "fingerprint-1",
              maskedDisplay: "•••",
            },
          },
        ],
        defaultDestinationIds: ["main"],
        routingRules: [],
        contentReplacements: [],
        createdAtMs: 0,
        updatedAtMs: 0,
      },
    ],
  } as unknown as WebhooksLoaderData;
}

async function renderPage(
  env: ReturnType<typeof createDom>,
  initialData: WebhooksLoaderData,
  fetchHandler?: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  if (fetchHandler) {
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) =>
      fetchHandler(String(input), init);
  }

  await act(async () => {
    env.root.render(
      <ToastProvider>
        <AdminWebhooksPage
          selectedWorkspaceId="workspace-1"
          selectedGuildId="guild-1"
          initialData={initialData}
        />
      </ToastProvider>,
    );
  });
}

function findButton(root: Element, label: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(button, `Expected ${label} button`);
  return button;
}

function findCardCopyButton(root: Element): HTMLButtonElement {
  const details = root.querySelector("details");
  assert.ok(details);
  const button = [...details.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === "Copy URL",
  );
  assert.ok(button);
  return button;
}

function findCredentialCopyButton(root: Element): HTMLButtonElement {
  const input = root.querySelector<HTMLInputElement>('input[aria-label="Discord webhook URL"]');
  assert.ok(input);

  let current: Element | null = input.parentElement;
  while (current) {
    const buttons = [...current.querySelectorAll<HTMLButtonElement>("button")];
    if (buttons.some((button) => button.textContent?.trim() === "Reveal URL")) {
      const copyButton = buttons.find((button) => button.textContent?.trim() === "Copy URL");
      assert.ok(copyButton);
      return copyButton;
    }
    current = current.parentElement;
  }

  assert.fail("Expected credential Copy URL button");
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

test("Webhook card copies the exact public URL and preserves success feedback", async () => {
  let copied = "";
  const restoreClipboard = installClipboard(async (value) => {
    copied = value;
  });
  const env = createDom();

  try {
    await renderPage(env, createInboundData());
    const copyButton = findCardCopyButton(env.container);
    await click(copyButton);

    assert.equal(copied, "https://example.com/webhooks/hook-abc");
    assert.equal(copyButton.textContent?.trim(), "Copied");
  } finally {
    await restoreDom(env);
    restoreClipboard();
  }
});

test("Webhook card reports clipboard failure without claiming success", async () => {
  const restoreClipboard = installClipboard(async () => {
    throw new Error("clipboard blocked");
  });
  const env = createDom();

  try {
    await renderPage(env, createInboundData());
    const copyButton = findCardCopyButton(env.container);
    await click(copyButton);

    assert.equal(copyButton.textContent?.trim(), "Copy URL");
    assert.match(env.container.textContent ?? "", /Failed to copy to clipboard\./);
  } finally {
    await restoreDom(env);
    restoreClipboard();
  }
});

test("Credential Copy URL copies the exact revealed value", async () => {
  let copied = "";
  const restoreClipboard = installClipboard(async (value) => {
    copied = value;
  });
  const env = createDom();

  try {
    await renderPage(env, createCredentialData(), (url, init) => {
      assert.equal(url, "/admin/api/webhook-proxy/credential/reveal");
      assert.equal(init?.method, "POST");
      return Response.json({
        url: "https://discord.com/api/webhooks/revealed-destination",
        fingerprint: "fingerprint-1",
        expiresAtMs: 123,
      });
    });

    await click(findButton(env.container, "Edit"));
    await click(findCredentialCopyButton(env.container));

    assert.equal(copied, "https://discord.com/api/webhooks/revealed-destination");
  } finally {
    await restoreDom(env);
    restoreClipboard();
  }
});

test("Credential Copy URL reports clipboard failure and clears plaintext", async () => {
  const restoreClipboard = installClipboard(async () => {
    throw new Error("clipboard blocked");
  });
  const env = createDom();

  try {
    await renderPage(env, createCredentialData(), () =>
      Response.json({
        url: "https://discord.com/api/webhooks/revealed-destination",
        fingerprint: "fingerprint-1",
        expiresAtMs: 123,
      }),
    );

    await click(findButton(env.container, "Edit"));
    await click(findCredentialCopyButton(env.container));

    assert.match(env.container.textContent ?? "", /Failed to copy to clipboard\./);
    const input = env.container.querySelector<HTMLInputElement>(
      'input[aria-label="Discord webhook URL"]',
    );
    assert.ok(input);
    assert.notEqual(input.value, "https://discord.com/api/webhooks/revealed-destination");
  } finally {
    await restoreDom(env);
    restoreClipboard();
  }
});
