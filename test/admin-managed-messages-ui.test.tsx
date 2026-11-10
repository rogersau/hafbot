/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { JSDOM } from "jsdom";
import { changeValue } from "./support/admin-dom-events";

import {
  AdminManagedMessagesPage,
  saveAndContinueMutation,
} from "../src/admin/components/admin-managed-messages-page";
import type { ManagedMessagesLoaderData } from "../src/admin/lib/admin-route-loaders";

test("Save and continue dispatches only to the active editor mutation", async () => {
  const calls: string[] = [];
  await saveAndContinueMutation("template", {
    managedMessage: async () => {
      calls.push("managed-message");
    },
    template: async () => {
      calls.push("template");
    },
  });
  assert.deepEqual(calls, ["template"]);
});

test("Managed Messages editor covers editing, preview, validation, and confirmed lifecycle actions", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "https://example.com/admin/guild-1/managed-messages",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    requestAnimationFrame: () => 0,
  });
  const requests: Array<{ url: string; method: string }> = [];
  let responseMessage: ManagedMessagesLoaderData["messages"][number] | null = null;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("/admin/api/permissions/diagnostics")) {
      return Response.json({ guildId: "guild-1", checksByFeature: { "managed-messages": [] } });
    }
    const method = init?.method ?? "GET";
    requests.push({ url: String(input), method });
    return method === "DELETE"
      ? Response.json({ ok: true, deleted: true })
      : Response.json({ message: responseMessage });
  };
  const initialData: ManagedMessagesLoaderData = {
    guildId: "guild-1",
    messages: [
      {
        id: "managed-1",
        guildId: "guild-1",
        internalName: "rules",
        channelId: "channel-1",
        messageId: "message-1",
        embeds: [
          {
            description: "Rules",
            fields: [
              { name: "First", value: "One", inline: false },
              { name: "Second", value: "Two", inline: false },
            ],
          },
          { description: "Second embed", fields: [] },
        ],
        buttons: [{ label: "Support", url: "https://example.com/support", emoji: "🔗" }],
        announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
        status: "published",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ],
    entitlement: null,
    canWrite: true,
    resources: {
      guildId: "guild-1",
      roles: [],
      categories: [],
      textChannels: [{ id: "channel-1", name: "rules" }],
      voiceChannels: [],
      forumChannels: [],
    },
  };
  responseMessage = initialData.messages[0]!;
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  // React DOM must detect the browser environment before its first import.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <AdminManagedMessagesPage
          selectedWorkspaceId="workspace-1"
          selectedGuildId="guild-1"
          initialData={initialData}
        />,
      );
    });
    assert.match(container.textContent ?? "", /Free tier: 1 of 3 used/);
    assert.match(container.textContent ?? "", /Published/);
    await clickButton(container, "Edit");
    const destination = container.querySelector<HTMLButtonElement>("#managed-message-channel");
    assert.ok(destination?.disabled, "Existing destination channel must be immutable");
    assert.match(container.textContent ?? "", /Rules/);
    assert.equal(
      container.querySelector<HTMLInputElement>("#managed-message-button-0-label")?.value,
      "Support",
    );
    assert.equal(
      container.querySelector<HTMLInputElement>("#managed-message-button-0-url")?.value,
      "https://example.com/support",
    );
    assert.match(container.textContent ?? "", /Link buttons/);
    const mediaUpload = container.querySelector<HTMLInputElement>('input[type="file"]');
    assert.ok(mediaUpload);
    assert.ok(mediaUpload.classList.contains("min-w-0"));
    assert.ok(mediaUpload.closest("label")?.classList.contains("flex-1"));
    assert.equal(mediaUpload.classList.contains("max-w-xs"), false);

    const firstDescription = container.querySelector<HTMLTextAreaElement>(
      "#managed-embed-description-0",
    );
    assert.ok(firstDescription);
    assert.equal(firstDescription.maxLength, 4096);
    assert.ok(container.querySelector('button[aria-label="Heading 1"]'));
    assert.ok(
      [...container.querySelectorAll("button")].some((button) => button.textContent === "Preview"),
    );
    firstDescription.setSelectionRange(0, firstDescription.value.length);
    await clickButtonByLabel(container, "Bold");
    assert.equal(firstDescription.value, "**Rules**");

    const descriptionAtLimit = "x".repeat(4096);
    await changeTextarea(firstDescription, descriptionAtLimit);
    firstDescription.setSelectionRange(0, firstDescription.value.length);
    await clickButtonByLabel(container, "Bold");
    assert.equal(
      firstDescription.value,
      descriptionAtLimit,
      "Formatting must not exceed Discord's description limit",
    );
    await changeTextarea(firstDescription, "**Rules**");

    await clickButtonByLabel(container, "Duplicate field 1 in embed 1");
    assert.deepEqual(readFieldNames(container), ["First", "First", "Second"]);

    await clickButtonByLabel(container, "Move field 2 down in embed 1");
    assert.deepEqual(readFieldNames(container), ["First", "Second", "First"]);
    await clickButton(container, "Add field");
    assert.deepEqual(readFieldNames(container), ["First", "Second", "First", ""]);
    await clickButtonByLabel(container, "Remove field 4 from embed 1");

    await clickButton(container, "Add embed");
    assert.match(container.textContent ?? "", /Second embed/);
    assert.deepEqual(readEmbedDescriptions(container), ["**Rules**", "Second embed", ""]);
    await clickButtonByLabel(container, "Duplicate embed 1");
    assert.deepEqual(readEmbedDescriptions(container), [
      "**Rules**",
      "**Rules**",
      "Second embed",
      "",
    ]);
    await clickButtonByLabel(container, "Move embed 2 down");
    assert.deepEqual(readEmbedDescriptions(container), [
      "**Rules**",
      "Second embed",
      "**Rules**",
      "",
    ]);
    await clickButtonByLabel(container, "Remove embed 3");
    assert.deepEqual(readEmbedDescriptions(container), ["**Rules**", "Second embed", ""]);
    await clickButtonByLabel(container, "Remove embed 3");
    assert.deepEqual(readEmbedDescriptions(container), ["**Rules**", "Second embed"]);

    for (let index = 0; index < 8; index += 1) {
      await clickButton(container, "Add embed");
    }
    assert.equal(readEmbedDescriptions(container).length, 10);
    assert.ok(
      [
        ...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Duplicate embed"]'),
      ].every((button) => button.disabled),
      "Embed duplication must be disabled at the 10-embed limit",
    );
    for (let index = 10; index > 2; index -= 1) {
      await clickButtonByLabel(container, `Remove embed ${index}`);
    }

    await clickButton(container, "Save");
    assert.match(dom.window.document.body.textContent ?? "", /Save Managed Message/);
    assert.deepEqual(requests, []);

    await clickButton(dom.window.document.body, "Save changes");
    assert.deepEqual(requests, [{ url: "/admin/api/managed-messages", method: "POST" }]);

    await clickButton(container, "Existing Messages");
    await clickButton(container, "Delete");
    assert.match(dom.window.document.body.textContent ?? "", /Delete Managed Message/);
    assert.equal(requests.length, 1);

    await clickLastButton(dom.window.document.body, "Delete");
    assert.deepEqual(requests[1], { url: "/admin/api/managed-messages", method: "DELETE" });

    await clickButton(container, "New Managed Message");
    assert.ok(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Save Draft",
      ),
    );
    assert.ok(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Publish Now",
      ),
    );
    assert.ok(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Schedule",
      ),
    );
    assert.ok(container.querySelector('input[type="datetime-local"]'));
    await clickButton(container, "Save Draft");
    assert.match(container.textContent ?? "", /Internal name is required/);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      fetch: previousFetch,
      requestAnimationFrame: previousRequestAnimationFrame,
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});

test("Managed Messages viewer sees Missing status without mutation controls", () => {
  const html = renderToString(
    <AdminManagedMessagesPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{
        guildId: "guild-1",
        messages: [
          {
            id: "managed-1",
            guildId: "guild-1",
            internalName: "rules",
            channelId: "channel-1",
            messageId: "message-1",
            embeds: [{ description: "Rules", fields: [] }],
            announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
            status: "missing",
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
        entitlement: null,
        canWrite: false,
        resources: {
          guildId: "guild-1",
          roles: [],
          categories: [],
          textChannels: [{ id: "channel-1", name: "rules" }],
          voiceChannels: [],
          forumChannels: [],
        },
      }}
    />,
  );

  assert.match(html, />Missing</);
  assert.match(html, />View</);
  assert.doesNotMatch(html, />Delete</);
  assert.match(html, /<button[^>]*disabled=""[^>]*>.*New Managed Message/s);
});

test("Premium Plus keeps Managed Messages and Message Templates unlimited", () => {
  const html = renderToString(
    <AdminManagedMessagesPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{
        guildId: "guild-1",
        messages: Array.from({ length: 3 }, (_, index) => ({
          id: `managed-${index + 1}`,
          guildId: "guild-1",
          internalName: `message-${index + 1}`,
          channelId: "channel-1",
          messageId: `discord-message-${index + 1}`,
          embeds: [{ description: `Message ${index + 1}`, fields: [] }],
          announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
          status: "published" as const,
          createdAtMs: 1,
          updatedAtMs: 1,
        })),
        templates: Array.from({ length: 3 }, (_, index) => ({
          id: `template-${index + 1}`,
          guildId: "guild-1",
          internalName: `template-${index + 1}`,
          embeds: [{ description: `Template ${index + 1}`, fields: [] }],
          availableForTicketReplies: false,
          createdAtMs: 1,
          updatedAtMs: 1,
        })),
        entitlement: {
          tier: "premium_plus",
          limits: {
            blocklistMaxEmojis: null,
            reactionLimitsEnabled: true,
            ticketsMaxPanels: null,
            ticketsMaxTypesPerPanel: null,
            platformLinkMaxLinks: null,
            managedMessagesMax: null,
            messageTemplatesMax: null,
            evidenceVaultMaxRecords: null,
            r2MaxBytes: 1024,
            paidFeatures: true,
          },
          supportInvite: null,
          r2Usage: {
            usedBytes: 0,
            reservedBytes: 0,
            maxBytes: 1024,
            lastReconciledAtMs: null,
          },
        },
        canWrite: true,
        resources: {
          guildId: "guild-1",
          roles: [],
          categories: [],
          textChannels: [{ id: "channel-1", name: "rules" }],
          voiceChannels: [],
          forumChannels: [],
        },
      }}
    />,
  );
  const dom = new JSDOM(html);
  const text = dom.window.document.body.textContent ?? "";
  const buttons = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")];
  const newManagedMessage = buttons.find(
    (button) => button.textContent?.trim() === "New Managed Message",
  );
  const newMessageTemplate = buttons.find(
    (button) => button.textContent?.trim() === "New Message Template",
  );

  assert.match(text, /3 Managed Message items/);
  assert.match(text, /3 templates · Unlimited under this plan\./);
  assert.equal(newManagedMessage?.disabled, false);
  assert.equal(newMessageTemplate?.disabled, false);
  dom.window.close();
});

test("Managed Messages dashboard exposes Draft, Scheduled, and Failed lifecycle states", () => {
  const html = renderToString(
    <AdminManagedMessagesPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{
        guildId: "guild-1",
        messages: [],
        drafts: [
          {
            id: "draft-1",
            guildId: "guild-1",
            internalName: "scheduled",
            channelId: "channel-1",
            embeds: [{ description: "Scheduled", fields: [] }],
            announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
            status: "scheduled",
            scheduledAtMs: 2_000,
            failureReason: null,
            attemptCount: 0,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
          {
            id: "draft-2",
            guildId: "guild-1",
            internalName: "failed",
            channelId: "channel-1",
            embeds: [{ description: "Failed", fields: [] }],
            announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
            status: "failed",
            scheduledAtMs: null,
            failureReason: "Missing Access",
            attemptCount: 3,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
        entitlement: null,
        canWrite: true,
        resources: {
          guildId: "guild-1",
          roles: [],
          categories: [],
          textChannels: [{ id: "channel-1", name: "rules" }],
          voiceChannels: [],
          forumChannels: [],
        },
      }}
    />,
  );

  assert.match(html, />Scheduled</);
  assert.match(html, />Failed</);
  assert.match(html, /Missing Access/);
  assert.match(html, />Cancel Schedule</);
  assert.match(html, />Edit</);
});

test("Managed Messages dashboard exposes Message Templates and copy-by-value creation", () => {
  const html = renderToString(
    <AdminManagedMessagesPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{
        guildId: "guild-1",
        messages: [],
        templates: [
          {
            id: "template-1",
            guildId: "guild-1",
            internalName: "Appeal denied",
            embeds: [{ description: "Your appeal was denied.", fields: [] }],
            availableForTicketReplies: true,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
        entitlement: null,
        canWrite: true,
        resources: {
          guildId: "guild-1",
          roles: [],
          categories: [],
          textChannels: [],
          voiceChannels: [],
          forumChannels: [],
        },
      }}
    />,
  );
  assert.match(html, /Message Templates/);
  assert.match(html, /Appeal denied/);
  assert.match(html, /Available for Ticket Replies/);
  assert.match(html, />Create Message</);
  assert.match(html, /1 of 3 templates used/);
});

async function clickButton(container: Element, text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  assert.ok(button, `Expected button ${text}`);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickButtonByLabel(container: Element, label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  assert.ok(button, `Expected button ${label}`);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickLastButton(container: Element, text: string) {
  const buttons = [...container.querySelectorAll("button")].filter(
    (candidate) => candidate.textContent?.trim() === text,
  );
  const button = buttons.at(-1);
  assert.ok(button, `Expected button ${text}`);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function changeTextarea(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => changeValue(textarea, value));
}

function readFieldNames(container: Element): string[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[aria-label$=" name"]')].map(
    (input) => input.value,
  );
}

function readEmbedDescriptions(container: Element): string[] {
  return [
    ...container.querySelectorAll<HTMLTextAreaElement>(
      'textarea[id^="managed-embed-description-"]',
    ),
  ].map((textarea) => textarea.value);
}
