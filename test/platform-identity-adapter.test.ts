/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  createPlatformIdentityAdapter,
  createSteamIdentityAdapter,
} from "../src/services/platform-identity-adapter";
import type {
  PlatformLink,
  PlatformLinkConfig,
} from "../src/runtime/contracts/platform-link-store";

test("identity adapter contract preserves each provider's metadata behavior", async () => {
  const adapters = [
    createSteamIdentityAdapter({}),
    createPlatformIdentityAdapter("xbox"),
    createPlatformIdentityAdapter("playstation"),
  ];

  for (const adapter of adapters) {
    const config = createConfig(adapter.platform);
    const metadata = await adapter.enrichMetadata("provider-id", config);
    assert.equal(metadata, adapter.platform === "steam" ? "[]" : null);
    assert.deepEqual(adapter.describe(createLink(adapter.platform, metadata), config), {
      accountLines: [],
      detailFields: [],
      whoisLines: [],
    });
  }
});

test("Steam identity adapter enriches and presents ownership and custom links", async () => {
  const adapter = createSteamIdentityAdapter({
    steamWebApiKey: "key",
    fetch: async () =>
      Response.json({
        response: {
          games: [{ appid: 730, name: "Counter-Strike 2", playtime_forever: 120 }],
        },
      }),
  });
  const config = createConfig("steam", {
    gameAppIds: [730],
    customLinks: [{ label: "CFTools", url: "https://example.test/{steamId64}" }],
  });
  const metadata = await adapter.enrichMetadata("76561198000000001", config);
  const description = adapter.describe(createLink("steam", metadata), config);

  assert.match(metadata ?? "", /Counter-Strike 2/);
  assert.deepEqual(description.accountLines, ["CFTools: https://example.test/76561198000000001"]);
  assert.match(description.detailFields[0]?.value ?? "", /Owned \(2h\)/);
});

function createConfig(
  platform: PlatformLinkConfig["platform"],
  overrides: Partial<PlatformLinkConfig> = {},
): PlatformLinkConfig {
  return {
    guildId: "guild-1",
    platform,
    linkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    panelTitle: "Link",
    panelDescription: "Link",
    panelButtonLabel: "Link",
    panelButtonStyle: "Primary",
    panelColor: 0x5865f2,
    allowRelink: true,
    allowMultipleLinks: false,
    requireRelinkOnRejoin: false,
    whoisFields: [],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: 1,
    ...overrides,
  };
}

function createLink(platform: PlatformLink["platform"], metadataJson: string | null): PlatformLink {
  return {
    guildId: "guild-1",
    userId: "user-1",
    platform,
    platformId: platform === "steam" ? "76561198000000001" : "provider-id",
    linkedAtMs: 1,
    manual: platform === "playstation",
    actionedByUserId: null,
    metadataJson,
    active: true,
  };
}
