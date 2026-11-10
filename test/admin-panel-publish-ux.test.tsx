/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "react-dom/server";

import { AdminLfgPage } from "../src/admin/components/admin-lfg-page";
import { AdminMarketplacePage } from "../src/admin/components/admin-marketplace-page";
import { AdminSuggestionsPage } from "../src/admin/components/admin-suggestions-page";
import { AdminSteamLinkPage } from "../src/admin/components/admin-steam-link-page";
import { defaultSuggestionsConfig } from "../src/suggestions";
import type { LfgConfig, MarketplaceConfig } from "../src/types";
import type { PlatformLinkConfig } from "../src/runtime/contracts/platform-link-store";

const lfgConfig = (overrides: Partial<LfgConfig> = {}): LfgConfig => ({
  guildId: "guild-1",
  noticeChannelId: "channel-1",
  noticeMessageId: null,
  notificationRoleId: null,
  counterVoiceChannelId: null,
  counterDisplayFormat: "LFG ({count})",
  approvalFlowEnabled: false,
  approvalAuditChannelId: null,
  approvalVoiceCategoryId: null,
  expiryAction: "close",
  expiryDurationHours: 24,
  serverOptions: [],
  updatedAtMs: 1,
  ...overrides,
});

const marketplaceConfig = (overrides: Partial<MarketplaceConfig> = {}): MarketplaceConfig => ({
  guildId: "guild-1",
  noticeChannelId: "channel-1",
  noticeMessageId: null,
  logChannelId: null,
  serverOptions: [],
  updatedAtMs: 1,
  ...overrides,
});

const playerConfig = (overrides: Partial<PlatformLinkConfig> = {}): PlatformLinkConfig => ({
  guildId: "guild-1",
  platform: "steam",
  linkedRoleId: null,
  logChannelId: null,
  gameAppIds: [],
  whoisFields: [],
  customLinks: [],
  panelTitle: "Link your Steam account",
  panelDescription: "Link your account.",
  panelButtonLabel: "Link Steam",
  panelButtonStyle: "Primary",
  panelColor: 0x2b2d31,
  allowRelink: true,
  allowMultipleLinks: false,
  requireRelinkOnRejoin: false,
  panelChannelId: "channel-1",
  panelMessageId: null,
  updatedAtMs: 1,
  ...overrides,
});

test("panel editors use Update copy when a Discord message already exists", () => {
  const lfg = renderToString(
    <AdminLfgPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{ config: lfgConfig({ noticeMessageId: "message-1" }), posts: [] }}
    />,
  );
  const marketplace = renderToString(
    <AdminMarketplacePage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{
        config: marketplaceConfig({ noticeMessageId: "message-1" }),
        posts: [],
        logs: [],
      }}
    />,
  );
  const player = renderToString(
    <AdminSteamLinkPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{
        guildId: "guild-1",
        platform: "steam",
        config: playerConfig({ panelMessageId: "message-1" }),
        links: [],
      }}
    />,
  );

  assert.match(lfg, />Update noticeboard</);
  assert.match(marketplace, />Update noticeboard</);
  assert.match(player, />Update panel</);
});

test("LFG advanced controls are disclosed and dependent fields are not shown when inactive", () => {
  const html = renderToString(
    <AdminLfgPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{ config: lfgConfig(), posts: [] }}
    />,
  );

  assert.match(html, /Advanced automation/);
  assert.doesNotMatch(html, /Counter display format/);
  assert.doesNotMatch(html, /Private voice category/);
});

test("Suggestions exposes role selection, labelled required prompts, and save-aware actions", () => {
  const config = defaultSuggestionsConfig("guild-1");
  const html = renderToString(
    <AdminSuggestionsPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{
        guildId: "guild-1",
        config,
        suggestions: [],
        collapsedReplies: [],
        readiness: { state: "not_configured", checks: {} },
      }}
    />,
  );

  assert.match(html, /Voter role/);
  assert.doesNotMatch(html, /Voter role ID/);
  assert.match(html, /Prompt 1 required/);
  assert.match(html, /Save/);
  assert.match(html, /Publish panel/);
  assert.match(html, /Add a category/);
});
