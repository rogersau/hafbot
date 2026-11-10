/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Tests compile via tsconfig.tests.json; admin React is excluded from the runtime test build.
import test from "node:test";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { JSDOM } from "jsdom";
import { changeValue } from "./support/admin-dom-events";

import { AdminMemberVerificationPage } from "../src/admin/components/admin-member-verification-page";
import { ToastProvider } from "../src/admin/components/toast";

function memberVerificationData() {
  return {
    guildId: "guild-1",
    entitlement: null,
    paidMethodsAvailable: true,
    turnstileAvailable: false,
    steamLinkAvailable: false,
    steamLinkConfigured: false,
    config: {
      guildId: "guild-1",
      enabled: true,
      verifiedRoleId: "role-1",
      title: "Welcome",
      description: "Click Verify below.",
      color: 0x5865f2,
      imageUrl: null,
      thumbnailUrl: null,
      rulesUrl: null,
      verifyButtonEmoji: null,
      deliveryMode: "channel" as const,
      verificationMethod: "discord-button" as const,
      welcomeChannelId: "channel-1",
      panelMessageId: "panel-1",
      updatedAtMs: 1,
    },
  };
}

test("Member Verification channel panels expose a publish or repair action", () => {
  const initialData = memberVerificationData();

  const html = renderToString(
    <ToastProvider>
      <AdminMemberVerificationPage
        selectedWorkspaceId="workspace-1"
        selectedGuildId="guild-1"
        entitlement={null}
        initialData={initialData}
      />
    </ToastProvider>,
  );

  assert.match(html, />Publish or repair panel</);
  assert.match(html, /Repair edits it in place, or recreates it if the message was deleted/);
});

test("Member Verification keeps retained Turnstile configuration visible when runtime support is unavailable", () => {
  const data = memberVerificationData();
  const html = renderToString(
    <ToastProvider>
      <AdminMemberVerificationPage
        selectedWorkspaceId="workspace-1"
        selectedGuildId="guild-1"
        entitlement={null}
        initialData={{
          ...data,
          turnstileAvailable: false,
          config: { ...data.config, verificationMethod: "turnstile" },
        }}
      />
    </ToastProvider>,
  );

  assert.match(html, /Turnstile challenge/);
});

async function renderSaveOutcome(
  outcome: "saved" | "saved-panel-repair-required",
): Promise<string> {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://example.com/admin/guild-1/member-verification",
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
  const initialData = memberVerificationData();
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST" && String(input).includes("/member-verification/config")) {
      const body = JSON.parse(String(init.body)) as { title: string };
      return Response.json({
        guildId: "guild-1",
        config: { ...initialData.config, title: body.title },
        outcome,
      });
    }
    if (String(input).startsWith("/admin/api/guild-resources")) {
      return Response.json({
        guildId: "guild-1",
        roles: [{ id: "role-1", name: "Verified" }],
        textChannels: [{ id: "channel-1", name: "welcome" }],
        voiceChannels: [],
        categories: [],
        forumChannels: [],
      });
    }
    return Response.json({ guildId: "guild-1", checksByFeature: {} });
  };

  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  // React DOM must detect the browser environment before its first import.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  let textContent = "";
  try {
    await act(async () => {
      root.render(
        <ToastProvider>
          <AdminMemberVerificationPage
            selectedWorkspaceId="workspace-1"
            selectedGuildId="guild-1"
            entitlement={null}
            initialData={initialData}
          />
        </ToastProvider>,
      );
    });
    const title = container.querySelector<HTMLInputElement>("#welcome-title");
    assert.ok(title);
    await act(async () => {
      changeValue(title, "Updated welcome");
    });
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Save",
    );
    assert.ok(save);
    await act(async () => {
      save.click();
    });
    textContent = container.textContent ?? "";
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
  return textContent;
}

test("Member Verification shows saved configuration that needs panel repair", async () => {
  const textContent = await renderSaveOutcome("saved-panel-repair-required");

  assert.match(
    textContent,
    /Member Verification configuration was saved, but the Welcome Panel needs repair/,
  );
  assert.match(textContent, /Configuration is saved, but the Welcome Panel needs repair/);
});

test("Member Verification distinguishes a complete save from panel repair required", async () => {
  const textContent = await renderSaveOutcome("saved");

  assert.match(textContent, /Saved Member Verification configuration/);
  assert.doesNotMatch(textContent, /Welcome Panel needs repair/);
});
