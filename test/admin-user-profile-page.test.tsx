/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Tests compile via tsconfig.tests.json; admin React is excluded from the runtime test build.
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { JSDOM } from "jsdom";

import {
  buildGuildVisibilityPatch,
  UserProfilePage,
} from "../src/admin/components/user-profile-page";
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from "../src/runtime/admin-types";
import type { AdminGuildDirectoryEntry } from "../src/runtime/admin-types";
import { ToastProvider } from "../src/admin/components/toast";

const USER = { name: "Alice", email: "alice@example.com", image: "https://example.com/avatar.png" };
const ENTITLEMENT_LABEL = "Admin";

const GUILDS: AdminGuildDirectoryEntry[] = [
  { guildId: "guild-1", name: "Alpha", label: "Alpha", icon: "alpha-icon" },
  { guildId: "guild-2", name: "Bravo", label: "Bravo", icon: null },
  { guildId: "guild-3", name: "Charlie", label: "Charlie", icon: null },
];

const noopApplyPatch = async () => undefined;

function renderProfile(overrides?: {
  preferences?: UserPreferences;
  user?: { name: string; email?: string; image: string };
}) {
  return renderToString(
    <UserProfilePage
      preferences={overrides?.preferences ?? DEFAULT_USER_PREFERENCES}
      user={overrides?.user ?? USER}
      guilds={GUILDS}
      entitlementLabel={ENTITLEMENT_LABEL}
      applyUserPreferencesPatch={noopApplyPatch}
    />,
  );
}

test("UserProfilePage renders only enabled preference cards", () => {
  const html = renderProfile();

  assert.match(html, /Identity/);
  assert.match(html, /Guilds/);
  assert.match(html, /Appearance/);
  assert.doesNotMatch(html, /Notifications/);
  assert.doesNotMatch(html, /Language/);
});

test("UserProfilePage renders the user's name and an Admin entitlement badge in Identity", () => {
  const html = renderProfile();

  assert.match(html, /Alice/);
  assert.match(html, /alice@example.com/);
  assert.match(html, /Admin/);
});

test("UserProfilePage keeps dormant preferences out of the UI", () => {
  const preferences: UserPreferences = {
    ...DEFAULT_USER_PREFERENCES,
    emailNotifications: false,
    pushNotifications: true,
    language: "es",
  };

  const html = renderProfile({ preferences });

  assert.doesNotMatch(html, /Weekly digests/);
  assert.doesNotMatch(html, /Browser alerts/);
  assert.doesNotMatch(html, /Espa/);
});

test("UserProfilePage no longer renders a compact-mode toggle", () => {
  const html = renderProfile();

  assert.doesNotMatch(html, /Compact mode/);
  assert.doesNotMatch(html, /Denser layout/);
});

test("UserProfilePage marks the selected theme button as active", () => {
  const preferences: UserPreferences = {
    ...DEFAULT_USER_PREFERENCES,
    theme: "dark",
  };

  const html = renderProfile({ preferences });

  const darkIndex = html.indexOf(">Dark<");
  const systemIndex = html.indexOf(">System<");
  const lightIndex = html.indexOf(">Light<");
  assert.ok(darkIndex > 0, "expected a Dark theme button");
  assert.ok(systemIndex > 0, "expected a System theme button");
  assert.ok(lightIndex > 0, "expected a Light theme button");

  // The active (dark) button carries aria-pressed="true"; the others are false.
  assert.ok(html.includes('aria-pressed="true"'), "expected an active theme button");
});

test("UserProfilePage lists each guild in the Guilds card", () => {
  const html = renderProfile();

  assert.match(html, /Alpha/);
  assert.match(html, /Bravo/);
  assert.match(html, /Charlie/);
});

test("UserProfilePage renders Discord guild icons in the Guilds card", () => {
  const html = renderProfile();

  assert.match(
    html,
    /<img[^>]+src="https:\/\/cdn\.discordapp\.com\/icons\/guild-1\/alpha-icon\.png"/,
  );
});

test("UserProfilePage styles hidden guild rows as muted and omits the default button", () => {
  const preferences: UserPreferences = {
    ...DEFAULT_USER_PREFERENCES,
    defaultGuildId: "guild-2",
    hiddenGuildIds: ["guild-2"],
  };

  const html = renderProfile({ preferences });

  assert.match(html, /border-dashed/);
  assert.doesNotMatch(html, /Set Bravo as default guild/);
  assert.doesNotMatch(html, />Default</);
});

test("UserProfilePage renders the Profile workspace identity", () => {
  const html = renderProfile();

  assert.match(html, /<h1>Profile<\/h1>/);
  assert.match(html, /admin-workspace-page-header/);
  assert.match(html, />Admin</);
});

test("UserProfilePage allows cards, identity details, and actions to shrink on mobile", () => {
  const html = renderProfile({
    user: {
      name: "A very long administrator display name",
      email: "an-extremely-long-address-without-helpful-breaks@example.com",
      image: "",
    },
  });

  assert.match(html, /grid min-w-0 gap-6/);
  assert.match(html, /flex min-w-0 flex-wrap items-center gap-4/);
  assert.match(html, /break-all text-sm text-muted-foreground/);
  assert.match(html, /flex flex-wrap gap-2/);
});

test("hiding the default guild clears it in the same preference patch", () => {
  assert.deepEqual(
    buildGuildVisibilityPatch(
      { ...DEFAULT_USER_PREFERENCES, defaultGuildId: "guild-2" },
      "guild-2",
      true,
    ),
    { hiddenGuildIds: ["guild-2"], defaultGuildId: null },
  );
});

test("UserProfilePage does not show a success toast when a preference save fails", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ToastProvider>
          <UserProfilePage
            preferences={DEFAULT_USER_PREFERENCES}
            user={USER}
            guilds={GUILDS}
            entitlementLabel={ENTITLEMENT_LABEL}
            applyUserPreferencesPatch={async (_patch, options) => {
              options?.onError?.("Preference save failed.");
            }}
          />
        </ToastProvider>,
      ),
    );
    const darkButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Dark",
    );
    assert.ok(darkButton);
    await act(async () => darkButton.click());
    assert.match(container.textContent ?? "", /Preference save failed\./);
    assert.doesNotMatch(container.textContent ?? "", /Theme set to Dark\./);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});
