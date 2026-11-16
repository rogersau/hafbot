/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "react-dom/server";

import {
  AdminMarketplacePage,
  formatAge,
  validateAdditionalChoices,
} from "../src/admin/components/admin-marketplace-page";
import type { MarketplaceConfig, MarketplacePost } from "../src/types";

const config: MarketplaceConfig = {
  guildId: "guild-1",
  noticeChannelId: "notice-1",
  noticeMessageId: null,
  logChannelId: "log-1",
  serverOptions: [{ id: "server-1", label: "Server One", emoji: null }],
  serverChoiceEnabled: true,
  additionalChoicesEnabled: true,
  additionalChoices: [
    {
      id: "invalid.question",
      label: "Platform",
      options: [
        { id: "pc", label: "PC", emoji: null },
        { id: "console", label: "Console", emoji: null },
      ],
    },
  ],
  updatedAtMs: 1,
};

const post: MarketplacePost = {
  guildId: "guild-1",
  id: "post-1",
  ownerId: "owner-1",
  ownerDisplayName: "Ada",
  tradeType: "have",
  serverId: "server-1",
  serverLabel: "Server One",
  additionalChoices: [
    { choiceId: "invalid.question", choiceLabel: "Platform", optionId: "pc", optionLabel: "PC" },
  ],
  have: "Sword",
  want: "Shield",
  extra: "Evening trade",
  channelId: "channel-1",
  messageId: "message-1",
  active: true,
  createdAtMs: Date.now() - 86_400_000,
  closedAtMs: null,
  closedByUserId: null,
};

test("Additional Choices report invalid and duplicate IDs", () => {
  assert.deepEqual(validateAdditionalChoices(config.additionalChoices ?? []), [
    "Platform: ID may contain only letters, numbers, hyphens, and underscores.",
  ]);
  assert.ok(
    validateAdditionalChoices([
      ...(config.additionalChoices ?? []),
      { ...config.additionalChoices![0]!, id: "invalid.question" },
    ]).some((error) => /duplicate question ID/.test(error)),
  );
});

test("Marketplace page presents ordered member flow and decision-ready post details", () => {
  const html = renderToString(
    <AdminMarketplacePage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{ config, posts: [post], logs: [] }}
    />,
  );
  assert.match(html, /Question 1/);
  assert.match(html, /Advanced · internal question ID/);
  assert.match(html, /Member flow preview/);
  assert.match(html, /Server choice/);
  assert.match(html, /Platform/);
  assert.match(html, /Search marketplace posts/);
  assert.match(html, /Have/);
  assert.match(html, /Evening trade/);
  assert.match(html, /Open in Discord/);
  assert.match(html, /No Marketplace contact logs yet/);
});

test("formatAge uses compact relative units", () => {
  const now = 10_000_000;
  assert.equal(formatAge(now - 45_000, now), "45s");
  assert.equal(formatAge(now - 3_600_000, now), "1h");
  assert.equal(formatAge(now - 172_800_000, now), "2d");
});
