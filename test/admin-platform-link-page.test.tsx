/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Tests compile via tsconfig.tests.json; admin React is excluded from the runtime test build.
import test from "node:test";
import { renderToString } from "react-dom/server";

import {
  AdminPlatformLinkPage,
  PLATFORM_METADATA,
  buildPlatformLinkSavePayload,
  getWhoisFieldOptions,
  getLinkTrustLabel,
  parseGameAppIdsInput,
} from "../src/admin/components/admin-platform-link-page";
import type { PlayerLinkLoaderData } from "../src/admin/lib/admin-route-loaders";
import type { PlatformLinkConfig } from "../src/runtime/contracts/platform-link-store";

function buildConfig(overrides: Partial<PlatformLinkConfig> = {}): PlatformLinkConfig {
  return {
    guildId: "guild-1",
    platform: "steam",
    linkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    whoisFields: [],
    customLinks: [],
    panelTitle: "",
    panelDescription: "",
    panelButtonLabel: "",
    panelButtonStyle: "Primary",
    allowRelink: true,
    allowMultipleLinks: false,
    requireRelinkOnRejoin: false,
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: 1,
    ...overrides,
  };
}

function buildInitialData(overrides: Partial<PlatformLinkConfig> = {}): PlayerLinkLoaderData {
  return {
    guildId: "guild-1",
    platform: "steam",
    config: buildConfig(overrides),
    links: [],
  };
}

function renderPage(initialData: PlayerLinkLoaderData | null) {
  return renderToString(
    <AdminPlatformLinkPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      activePlatform="steam"
      initialData={initialData}
    />,
  );
}

test("AdminPlatformLinkPage renders allowRelink checked and allowMultipleLinks unchecked", () => {
  const html = renderPage(buildInitialData({ allowRelink: true, allowMultipleLinks: false }));

  assert.match(html, /aria-label="Allow relink"/);
  assert.match(html, /aria-label="Allow multiple links per Discord user"/);

  // The radix Switch renders data-state on the same button element as aria-label.
  // allowRelink is on -> checked; allowMultipleLinks is off -> unchecked.
  const switches = html.match(
    /data-state="(checked|unchecked)"[^>]*aria-label="Allow (relink|multiple links per Discord user)"/g,
  );
  assert.ok(switches, "expected to find both switch states");
  assert.ok(
    switches.some((s) => s.includes("checked") && s.includes("relink")),
    `allowRelink should be checked, got: ${JSON.stringify(switches)}`,
  );
  assert.ok(
    switches.some((s) => s.includes("unchecked") && s.includes("multiple links")),
    `allowMultipleLinks should be unchecked, got: ${JSON.stringify(switches)}`,
  );
});

test("AdminPlatformLinkPage defers the panel preview until activation", () => {
  const html = renderPage(
    buildInitialData({
      panelTitle: "Verify your Steam account",
      panelDescription: "Click the button below to link your profile.",
      panelButtonLabel: "Link account",
      panelButtonStyle: "Success",
    }),
  );

  assert.match(html, /Load message preview/);
  assert.doesNotMatch(html, /<discord-messages|<discord-button/);
});

test("buildPlatformLinkSavePayload includes platform and both toggle values from the draft", () => {
  // The helper is shared by manual save and auto-save; both must send an
  // identical payload with platform + the toggles.
  const draft = {
    guildId: "guild-1",
    linkedRoleId: "role-1",
    logChannelId: "log-1",
    gameAppIds: "730, 440",
    whoisFields: "name, country",
    panelTitle: "",
    panelDescription: "",
    panelButtonLabel: "",
    panelButtonStyle: "Success" as const,
    panelColor: 0x123456,
    allowRelink: false,
    allowMultipleLinks: true,
    requireRelinkOnRejoin: true,
    panelChannelId: "panel-1",
    customLinks: [{ label: "Discord", url: "https://discord.gg/x" }],
  };

  const payload = buildPlatformLinkSavePayload(draft, "steam", PLATFORM_METADATA.steam);

  assert.equal(payload.platform, "steam");
  assert.equal(payload.allowRelink, false);
  assert.equal(payload.allowMultipleLinks, true);
  assert.equal(payload.requireRelinkOnRejoin, true);
  assert.equal(payload.panelColor, 0x123456);
  // gameAppIds should be parsed from the comma-separated draft string.
  assert.deepEqual(payload.gameAppIds, ["730", "440"]);
});

test("parseGameAppIdsInput accepts pasted lists and removes invalid or duplicate IDs", () => {
  assert.deepEqual(parseGameAppIdsInput("730, 440\n730, nope, 221100"), ["730", "440", "221100"]);
});

test("Whois field choices vary by platform while custom and unknown keys remain inspectable", () => {
  assert.deepEqual(
    getWhoisFieldOptions("xbox").map((option) => option.key),
    ["profile"],
  );
  assert.deepEqual(
    getWhoisFieldOptions("steam", [
      { label: "CFTools", url: "https://example.test/{steamId64}" },
    ]).map((option) => option.key),
    ["profile", "gameOwnership", "CFTools"],
  );
});

test("PlayStation member links are visibly marked as self-attested while staff links stay manual", () => {
  const base = {
    guildId: "guild-1",
    userId: "user-1",
    platform: "playstation" as const,
    platformId: "ExamplePSN",
    linkedAtMs: 1,
    manual: true,
    metadataJson: null,
    active: true,
  };
  assert.equal(
    getLinkTrustLabel({ ...base, actionedByUserId: null }, "playstation"),
    "Member-submitted · unverified",
  );
  assert.equal(
    getLinkTrustLabel({ ...base, actionedByUserId: "staff-1" }, "playstation"),
    "Manual staff link",
  );
});

test("Player Link renders validated App ID tokens, Whois controls, and responsive audit controls", () => {
  const html = renderToString(
    <AdminPlatformLinkPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      activePlatform="steam"
      initialData={{
        ...buildInitialData({
          gameAppIds: [730, 221100],
          whoisFields: ["profile", "legacyField"],
        }),
        links: [
          {
            guildId: "guild-1",
            userId: "user-1",
            platform: "steam",
            platformId: "76561198000000000",
            linkedAtMs: 1,
            manual: false,
            actionedByUserId: null,
            metadataJson: null,
            active: true,
          },
        ],
      }}
    />,
  );

  assert.match(html, /Counter-Strike 2/);
  assert.match(html, /DayZ/);
  assert.match(html, /Unsupported saved fields/);
  assert.match(html, /Search linked accounts/);
  assert.match(html, /Copy command/);
});
