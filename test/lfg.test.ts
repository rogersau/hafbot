/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  buildLfgRenewalReminderMessage,
  buildLfgServerResponse,
  parseLfgCustomId,
} from "../src/lfg";
import { parseLfgPost } from "../src/runtime/lfg-request-parsers";

test("parseLfgPost accepts blank extra info for optional modal submissions", () => {
  const post = parseLfgPost({
    guildId: "guild-1",
    id: "post-1",
    ownerId: "owner-1",
    ownerDisplayName: "Owner",
    serverId: "namalsk",
    serverLabel: "Namalsk",
    whenPlay: "Evenings",
    lookingFor: "Duo",
    extraInfo: "",
    channelId: "channel-1",
    messageId: null,
    active: true,
    createdAtMs: 1,
    expiresAtMs: 2,
    reminderSentAtMs: null,
    renewedAtMs: null,
    renewalsCount: 0,
    closedAtMs: null,
    closedByUserId: null,
  });

  assert.equal(post.extraInfo, "");
});

test("LFG renewal reminder button carries guild and post ids for DM interactions", () => {
  const message = buildLfgRenewalReminderMessage({
    guildId: "guild-1",
    id: "post-1",
    ownerId: "owner-1",
    ownerDisplayName: "Owner",
    serverId: "namalsk",
    serverLabel: "Namalsk",
    whenPlay: "Evenings",
    lookingFor: "Duo",
    extraInfo: "",
    channelId: "channel-1",
    messageId: null,
    active: true,
    createdAtMs: 1,
    expiresAtMs: 2,
    reminderSentAtMs: null,
    renewedAtMs: null,
    renewalsCount: 0,
    closedAtMs: null,
    closedByUserId: null,
  });

  const customId = message.components[0]?.components[0]?.custom_id;
  assert.equal(customId, "lfg:renew:guild-1:post-1");
  assert.deepEqual(parseLfgCustomId(customId ?? ""), {
    action: "renew",
    guildId: "guild-1",
    postId: "post-1",
  });
});

test("Clan LFG server selection preserves trusted Clan scope through the modal", () => {
  const response = buildLfgServerResponse(
    {
      guildId: "guild-1",
      noticeChannelId: null,
      noticeMessageId: null,
      notificationRoleId: null,
      noticeColor: 0x2b2d31,
      counterVoiceChannelId: null,
      counterDisplayFormat: "LFG ({count})",
      approvalFlowEnabled: false,
      approvalAuditChannelId: null,
      approvalVoiceCategoryId: null,
      expiryAction: "close",
      expiryDurationHours: 24,
      serverOptions: [{ id: "dayz", label: "DayZ", emoji: null }],
      updatedAtMs: 1,
    },
    "clan",
  );
  const customId = response.data.components[0]?.components[0]?.custom_id;
  assert.equal(customId, "lfg:server-clan:dayz");
  assert.deepEqual(parseLfgCustomId(customId ?? ""), {
    action: "server-clan",
    serverId: "dayz",
  });
  assert.deepEqual(parseLfgCustomId("lfg:modal-clan:dayz"), {
    action: "modal-clan",
    serverId: "dayz",
  });
});
