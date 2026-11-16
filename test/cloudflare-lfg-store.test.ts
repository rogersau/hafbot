/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createSqliteLfgStore } from "./support/sqlite/runtime/sqlite-lfg-store";
import type { LfgConfig, LfgPost } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("createSqliteLfgStore uses the migrated unified database without runtime DDL", async () => {
  const database = new SqliteD1Database();
  const store = createSqliteLfgStore(database.d1);
  const config: LfgConfig = {
    guildId: "guild-1",
    noticeChannelId: "notice-channel-1",
    noticeMessageId: "notice-message-1",
    notificationRoleId: "role-1",
    noticeColor: 0x2b2d31,
    counterVoiceChannelId: "voice-1",
    counterDisplayFormat: "Open squads: {count}",
    approvalFlowEnabled: true,
    approvalAuditChannelId: "audit-channel-1",
    approvalVoiceCategoryId: "voice-category-1",
    expiryAction: "delete",
    expiryDurationHours: 12,
    serverOptions: [{ id: "namalsk", label: "Namalsk", emoji: null }],
    updatedAtMs: 100,
  };
  const post: LfgPost = {
    guildId: "guild-1",
    id: "post-1",
    ownerId: "owner-1",
    ownerDisplayName: "Owner",
    serverId: "namalsk",
    serverLabel: "Namalsk",
    whenPlay: "now",
    lookingFor: "duo",
    extraInfo: "bring food",
    channelId: "channel-1",
    messageId: null,
    active: true,
    createdAtMs: 200,
    expiresAtMs: 1000,
    reminderSentAtMs: null,
    renewedAtMs: null,
    renewalsCount: 0,
    closedAtMs: null,
    closedByUserId: null,
    scope: "public",
    clanId: null,
    clanTag: null,
    persistentVoiceChannelId: null,
  };
  const newerPost: LfgPost = {
    ...post,
    id: "post-2",
    ownerId: "owner-2",
    ownerDisplayName: "Owner 2",
    createdAtMs: 250,
    expiresAtMs: 1100,
  };

  await store.upsertLfgConfig(config);
  await store.createLfgPost(post);
  await store.createLfgPost(newerPost);
  await store.createLfgApplication({
    guildId: "guild-1",
    postId: "post-1",
    applicantId: "applicant-1",
    applicantDisplayName: "Applicant",
    message: "I can run support.",
    status: "pending",
    createdAtMs: 250,
    updatedAtMs: 250,
    reviewedByUserId: null,
    reviewedAtMs: null,
  });
  await store.upsertLfgVoiceChannel({
    guildId: "guild-1",
    postId: "post-1",
    channelId: "voice-channel-1",
    createdAtMs: 260,
    updatedAtMs: 260,
  });
  await store.updateLfgPostMessage({
    guildId: "guild-1",
    postId: "post-1",
    messageId: "message-1",
  });

  assert.deepEqual(await store.readLfgConfig("guild-1"), config);
  assert.equal(await store.countActiveLfgPosts("guild-1"), 2);
  assert.deepEqual(await store.readLfgPost("guild-1", "post-1"), {
    ...post,
    messageId: "message-1",
  });
  assert.deepEqual(await store.listLfgPosts("guild-1", { limit: 1 }), [newerPost]);
  assert.deepEqual(await store.readActiveLfgPostByOwner("guild-1", "owner-1"), {
    ...post,
    messageId: "message-1",
  });
  assert.deepEqual(await store.listDueLfgRenewalReminders(100, 10), [
    { ...post, messageId: "message-1" },
    newerPost,
  ]);
  assert.deepEqual(await store.listDueLfgRenewalReminders(100, 10, ["guild-1"]), []);
  const renewedPost = {
    ...post,
    messageId: "message-1",
    whenPlay: "tomorrow",
    lookingFor: "trio",
    extraInfo: "bring meds",
    expiresAtMs: 3_000,
    reminderSentAtMs: 900,
    renewedAtMs: 800,
    renewalsCount: 1,
  };
  await store.updateLfgPost(renewedPost);
  assert.deepEqual(await store.readLfgPost("guild-1", "post-1"), renewedPost);
  assert.deepEqual(await store.listDueLfgRenewalReminders(500, 10), [newerPost]);
  assert.deepEqual(await store.readLfgApplication("guild-1", "post-1", "applicant-1"), {
    guildId: "guild-1",
    postId: "post-1",
    applicantId: "applicant-1",
    applicantDisplayName: "Applicant",
    message: "I can run support.",
    status: "pending",
    createdAtMs: 250,
    updatedAtMs: 250,
    reviewedByUserId: null,
    reviewedAtMs: null,
  });
  assert.deepEqual(await store.readLfgVoiceChannel("guild-1", "post-1"), {
    guildId: "guild-1",
    postId: "post-1",
    channelId: "voice-channel-1",
    createdAtMs: 260,
    updatedAtMs: 260,
  });
  assert.deepEqual(await store.readLfgVoiceChannelByChannelId("voice-channel-1"), {
    guildId: "guild-1",
    postId: "post-1",
    channelId: "voice-channel-1",
    createdAtMs: 260,
    updatedAtMs: 260,
  });

  await store.upsertLfgConfig({ ...config, guildId: "guild-2", expiryAction: "nothing" });
  await store.createLfgPost({ ...post, guildId: "guild-2", id: "post-3", expiresAtMs: 50 });
  assert.deepEqual(await store.listDueLfgPostExpiries(1_200, 10), [newerPost]);

  const closed = await store.closeLfgPost({
    guildId: "guild-1",
    postId: "post-2",
    closedByUserId: "owner-1",
    closedAtMs: 300,
  });

  assert.equal(closed.active, false);
  assert.equal(await store.countActiveLfgPosts("guild-1"), 1);
  assert.deepEqual(await store.listLfgPosts("guild-1", { activeOnly: true }), [renewedPost]);
  const refresh = {
    guildId: "guild-1",
    channelId: config.noticeChannelId!,
    previousMessageId: config.noticeMessageId,
    expectedUpdatedAtMs: config.updatedAtMs,
    messageId: "refreshed-notice",
    updatedAtMs: 400,
  };
  assert.equal(await store.refreshLfgNotice({ ...refresh, guildId: "missing" }), false);
  assert.equal(await store.refreshLfgNotice({ ...refresh, channelId: "another-channel" }), false);
  assert.equal(
    await store.refreshLfgNotice({ ...refresh, previousMessageId: "another-message" }),
    false,
  );
  assert.equal(await store.refreshLfgNotice({ ...refresh, expectedUpdatedAtMs: 0 }), false);
  assert.equal(await store.refreshLfgNotice(refresh), true);
  assert.deepEqual(await store.readLfgConfig("guild-1"), {
    ...config,
    noticeMessageId: "refreshed-notice",
    updatedAtMs: 400,
  });
  assert.equal(await store.refreshLfgNotice(refresh), false);
  // The null-channel disable transition wins even when the timestamp is unchanged.
  await store.upsertLfgConfig({ ...config, noticeChannelId: null, noticeMessageId: null });
  assert.equal(await store.refreshLfgNotice(refresh), false);
  assert.equal((await store.readLfgConfig("guild-1"))?.noticeChannelId, null);
  await store.upsertLfgConfig({ ...config, noticeMessageId: null });
  assert.equal(await store.refreshLfgNotice({ ...refresh, previousMessageId: null }), true);
  assert.equal(database.execCalls, 0);
  database.close();
});
