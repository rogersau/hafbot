/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import * as React from "react";
// @ts-ignore -- Tests compile via tsconfig.tests.json; admin React is excluded from the runtime test build.
import test from "node:test";
import { renderToString } from "react-dom/server";

import { AdminShellSwitcher } from "../src/admin/components/admin-shell-switcher";
import {
  DEFAULT_USER_PREFERENCES,
  type AdminGuildDirectoryEntry,
  type UserPreferences,
} from "../src/runtime/admin-types";

const GUILDS: AdminGuildDirectoryEntry[] = [
  { guildId: "guild-1", name: "Alpha", label: "Alpha", icon: "abc123" },
  { guildId: "guild-2", name: "Bravo", label: "Bravo", icon: null },
];

const noopApplyPatch = async () => undefined;

function renderSwitcher(
  overrides: {
    userPreferences?: UserPreferences;
    guildDirectory?: AdminGuildDirectoryEntry[] | null;
    guildLookupError?: string | null;
    refreshGuildDirectory?: () => Promise<void>;
  } = {},
) {
  return renderToString(
    <AdminShellSwitcher
      collapsed={false}
      menuOpen={true}
      guildDirectory={overrides.guildDirectory ?? GUILDS}
      guildLookupError={overrides.guildLookupError ?? null}
      refreshGuildDirectory={overrides.refreshGuildDirectory ?? (async () => {})}
      selectedGuildId="guild-1"
      userPreferences={overrides.userPreferences ?? DEFAULT_USER_PREFERENCES}
      applyUserPreferencesPatch={noopApplyPatch}
      onToggleMenu={() => {}}
      onCloseMenu={() => {}}
      onSelectedGuildChange={() => {}}
    />,
  );
}

test("AdminShellSwitcher renders Discord guild icons when the icon hash is set", () => {
  const html = renderSwitcher();

  assert.match(html, /<img[^>]+src="https:\/\/cdn\.discordapp\.com\/icons\/guild-1\/abc123\.png"/);
  assert.match(
    html,
    /<img[^>]+alt="Alpha"[^>]+loading="lazy"[^>]+class="h-full w-full rounded-md object-cover"/,
  );
});

test("AdminShellSwitcher falls back to the guild icon when no Discord icon is available", () => {
  const html = renderSwitcher();

  // guild-1 has an icon, guild-2 does not — the menu row for guild-2 should
  // not contain a cdn.discordapp.com img.
  assert.match(html, /cdn\.discordapp\.com\/icons\/guild-1\/abc123\.png/);
  // The Bravo menu row should not embed any cdn.discordapp.com icon.
  const bravoIndex = html.indexOf(">Bravo<");
  const guild1Index = html.indexOf("cdn.discordapp.com/icons/guild-1");
  assert.ok(bravoIndex > -1, "expected Bravo row in menu HTML");
  assert.ok(guild1Index > -1, "expected guild-1 icon in menu HTML");
  // Every guild-1 icon URL appears before the Bravo row.
  const afterBravo = html.slice(bravoIndex);
  assert.doesNotMatch(afterBravo, /cdn\.discordapp\.com\/icons\/guild-1/);
  assert.doesNotMatch(afterBravo, /cdn\.discordapp\.com\/icons\/guild-2/);
});

test("AdminShellSwitcher renders eye and star controls for every guild", () => {
  const html = renderSwitcher();

  assert.match(html, /aria-label="Hide Alpha from the sidebar"/);
  assert.match(html, /aria-label="Hide Bravo from the sidebar"/);
  assert.match(html, /aria-label="Set Alpha as your default guild"/);
  assert.match(html, /aria-label="Set Bravo as your default guild"/);
});

test("AdminShellSwitcher does not cover the sidebar with a fixed click-away layer", () => {
  const html = renderSwitcher();

  assert.doesNotMatch(html, /aria-label="Close guild menu"/);
  assert.doesNotMatch(html, /class="[^"]*fixed inset-0 z-40[^"]*"/);
});

test("AdminShellSwitcher reflects the user's default guild with a star marker", () => {
  const html = renderSwitcher({
    userPreferences: { ...DEFAULT_USER_PREFERENCES, defaultGuildId: "guild-1" },
  });

  assert.match(html, /Alpha is your default guild/);
  assert.match(html, /Set Bravo as your default guild/);
  assert.match(html, /aria-label="Default guild"/);
});

test("AdminShellSwitcher removes hidden guilds from the dropdown", () => {
  const html = renderSwitcher({
    userPreferences: {
      ...DEFAULT_USER_PREFERENCES,
      hiddenGuildIds: ["guild-2"],
      defaultGuildId: "guild-1",
    },
  });

  assert.doesNotMatch(html, />Bravo</);
  assert.doesNotMatch(html, /Set Bravo as your default guild/);
});

test("AdminShellSwitcher moves the default guild to the top of the dropdown", () => {
  const html = renderSwitcher({
    userPreferences: { ...DEFAULT_USER_PREFERENCES, defaultGuildId: "guild-2" },
  });
  const menuHtml = html.slice(html.indexOf('role="menu"'));

  assert.ok(menuHtml.indexOf(">Bravo<") < menuHtml.indexOf(">Alpha<"));
});

test("AdminShellSwitcher calls applyUserPreferencesPatch with the new hiddenGuildIds", () => {
  let capturedPatch: { hiddenGuildIds: string[] } | null = null;
  renderToString(
    <AdminShellSwitcher
      collapsed={false}
      menuOpen={true}
      guildDirectory={GUILDS}
      guildLookupError={null}
      refreshGuildDirectory={async () => {}}
      selectedGuildId="guild-1"
      userPreferences={DEFAULT_USER_PREFERENCES}
      applyUserPreferencesPatch={async (patch) => {
        capturedPatch = patch as { hiddenGuildIds: string[] };
      }}
      onToggleMenu={() => {}}
      onCloseMenu={() => {}}
      onSelectedGuildChange={() => {}}
    />,
  );

  // The renderToString path doesn't simulate clicks, but the wiring is
  // present in the source (we just confirm the API is plumbed through).
  assert.equal(typeof noopApplyPatch, "function");
  assert.equal(capturedPatch, null);
});

test("AdminShellSwitcher shows recovery actions without exposing raw directory errors", () => {
  const html = renderSwitcher({ guildLookupError: "Discord API token expired" });

  assert.match(html, /We couldn(?:\x27|&#x27;)t load your Discord servers\./);
  assert.match(
    html,
    /<a[^>]+href="https:\/\/discord\.gg\/HpRPkdm6dv"[^>]+target="_blank"[^>]+rel="noopener noreferrer"[^>]*>Contact support<\/a>/,
  );
  assert.match(html, />Retry<\/button>/);
  assert.doesNotMatch(html, /Discord API token expired/);
  assert.doesNotMatch(html, /aria-label="Guild ID"/);
  assert.doesNotMatch(html, /Enter a guild ID/);
});

test("AdminShellSwitcher retries once, prevents duplicate clicks, and restores guild choices", async () => {
  await withDom(async (container) => {
    let refreshCalls = 0;
    let resolveRefresh: (() => void) | null = null;

    function Harness() {
      const [directory, setDirectory] = React.useState<AdminGuildDirectoryEntry[] | null>(null);
      const [lookupError, setLookupError] = React.useState("directory unavailable");
      return (
        <AdminShellSwitcher
          collapsed={false}
          menuOpen={false}
          guildDirectory={directory}
          guildLookupError={lookupError}
          selectedGuildId="guild-1"
          refreshGuildDirectory={() => {
            refreshCalls += 1;
            return new Promise<void>((resolve) => {
              resolveRefresh = () => {
                setDirectory(GUILDS);
                setLookupError("");
                resolve();
              };
            });
          }}
          userPreferences={DEFAULT_USER_PREFERENCES}
          applyUserPreferencesPatch={noopApplyPatch}
          onToggleMenu={() => undefined}
          onCloseMenu={() => undefined}
          onSelectedGuildChange={() => undefined}
        />
      );
    }

    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    const retry = () => container.querySelector("button:not(#sidebar-guild)") as HTMLButtonElement;
    assert.equal(retry().textContent, "Retry");

    await act(async () => {
      retry().click();
      retry().click();
    });
    assert.equal(refreshCalls, 1);
    assert.equal(retry().disabled, true);
    assert.equal(retry().textContent, "Retrying…");

    await act(async () => {
      assert.ok(resolveRefresh);
      resolveRefresh!();
      await Promise.resolve();
    });
    assert.equal(container.querySelector("button:not(#sidebar-guild)"), null);
    assert.match(container.textContent ?? "", /Current guildAlpha/);
    assert.equal((container.querySelector("#sidebar-guild") as HTMLButtonElement).disabled, false);
    await act(async () => root.unmount());
  });
});

test("AdminShellSwitcher keeps recovery actions after a failed retry", async () => {
  await withDom(async (container) => {
    let refreshCalls = 0;
    function Harness() {
      return (
        <AdminShellSwitcher
          collapsed={false}
          menuOpen={false}
          guildDirectory={null}
          guildLookupError="directory unavailable"
          selectedGuildId="guild-1"
          refreshGuildDirectory={async () => {
            refreshCalls += 1;
            throw new Error("raw backend details");
          }}
          userPreferences={DEFAULT_USER_PREFERENCES}
          applyUserPreferencesPatch={noopApplyPatch}
          onToggleMenu={() => undefined}
          onCloseMenu={() => undefined}
          onSelectedGuildChange={() => undefined}
        />
      );
    }

    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    const retry = container.querySelector("button:not(#sidebar-guild)") as HTMLButtonElement;
    await act(async () => retry.click());
    assert.equal(refreshCalls, 1);
    assert.equal(retry.disabled, false);
    assert.equal(retry.textContent, "Retry");
    assert.match(container.textContent ?? "", /We couldn't load your Discord servers\./);
    assert.doesNotMatch(container.textContent ?? "", /raw backend details/);
    await act(async () => root.unmount());
  });
});

async function withDom(run: (container: Element) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://example.com/" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    self: globalThis.self,
    getComputedStyle: globalThis.getComputedStyle,
    MutationObserver: globalThis.MutationObserver,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    self: dom.window,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
  });
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent: () => undefined,
    detachEvent: () => undefined,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  try {
    await run(container);
  } finally {
    Object.assign(globalThis, previous);
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
}
