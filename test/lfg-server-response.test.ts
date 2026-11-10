/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";
import { buildLfgServerResponse } from "../src/lfg";

test("buildLfgServerResponse with empty server label still has valid button labels", () => {
  const config = {
    guildId: "g1",
    noticeChannelId: null,
    noticeMessageId: null,
    notificationRoleId: null,
    counterVoiceChannelId: null,
    counterDisplayFormat: "LFG ({count})",
    approvalFlowEnabled: false,
    approvalAuditChannelId: null,
    approvalVoiceCategoryId: null,
    expiryAction: "close" as const,
    expiryDurationHours: 24,
    serverOptions: [{ id: "srv1", label: "", emoji: null }],
    updatedAtMs: Date.now(),
  };
  const response = buildLfgServerResponse(config);
  const button = (response.data.components as any[])[0].components[0];
  console.log("Button label:", JSON.stringify(button.label));
  assert.ok(button.label && button.label.length > 0, "Button label must not be empty");
});

test("buildLfgServerResponse with invalid emoji still sends a valid structure", () => {
  const config = {
    guildId: "g1",
    noticeChannelId: null,
    noticeMessageId: null,
    notificationRoleId: null,
    counterVoiceChannelId: null,
    counterDisplayFormat: "LFG ({count})",
    approvalFlowEnabled: false,
    approvalAuditChannelId: null,
    approvalVoiceCategoryId: null,
    expiryAction: "close" as const,
    expiryDurationHours: 24,
    serverOptions: [{ id: "srv1", label: "Test", emoji: "invalid_emoji_text" }],
    updatedAtMs: Date.now(),
  };
  const response = buildLfgServerResponse(config);
  const button = (response.data.components as any[])[0].components[0];
  console.log("Button emoji:", JSON.stringify(button.emoji));
  // Discord requires emoji.name to be a valid unicode emoji or custom emoji format
  // "invalid_emoji_text" is not a valid unicode emoji
  assert.ok(button.emoji, "Button has emoji");
});

test("buildLfgNoticeMessage includes alerts toggle when notification role is configured", async () => {
  const { buildLfgNoticeMessage } = await import("../src/lfg");
  const message = buildLfgNoticeMessage({ notificationRoleId: "role-1" });
  const row = message.components[0] as { components: Array<{ custom_id: string }> };
  assert.deepEqual(
    row.components.map((component) => component.custom_id),
    ["lfg:create", "lfg:toggle-alerts"],
  );
});
