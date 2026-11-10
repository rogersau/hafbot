/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";
import { buildLfgPostMessage } from "../src/lfg";

const basePost = {
  guildId: "g1",
  id: "123-user1",
  ownerId: "user1",
  ownerDisplayName: "Test User",
  serverId: "test-server",
  serverLabel: "Test Server",
  whenPlay: "Evenings",
  lookingFor: "Squad",
  extraInfo: "",
  channelId: "ch1",
  messageId: null,
  active: true,
  createdAtMs: Date.now(),
  expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
  reminderSentAtMs: null,
  renewedAtMs: null,
  renewalsCount: 0,
  closedAtMs: null,
  closedByUserId: null,
};

test("buildLfgPostMessage has no empty embed field values with normal data", () => {
  const msg = buildLfgPostMessage(basePost);
  const emptyFields = msg.embeds[0].fields.filter((f) => !f.value || f.value === "");
  assert.deepEqual(emptyFields, []);
});

test("buildLfgPostMessage has no empty embed field values with empty whenPlay/lookingFor", () => {
  const post = { ...basePost, whenPlay: "", lookingFor: "" };
  const msg = buildLfgPostMessage(post);
  const emptyFields = msg.embeds[0].fields.filter((f) => !f.value || f.value === "");
  assert.deepEqual(emptyFields, []);
});

test("buildLfgPostMessage has no empty embed field values with empty serverLabel", () => {
  const post = { ...basePost, serverLabel: "" };
  const msg = buildLfgPostMessage(post);
  const emptyFields = msg.embeds[0].fields.filter((f) => !f.value || f.value === "");
  assert.deepEqual(emptyFields, []);
});

test("buildLfgPostMessage includes configured notification role ping", () => {
  const msg = buildLfgPostMessage(basePost, { notificationRoleId: "role-1" });
  assert.equal(msg.content, "<@&role-1>");
  assert.deepEqual(msg.allowed_mentions, { roles: ["role-1"] });
});

test("buildLfgPostMessage renders owner as a mention without a raw ID line", () => {
  const msg = buildLfgPostMessage(basePost);
  const postedByField = msg.embeds[0].fields.find((field) => field.name === "👤 Posted by");

  assert.equal(postedByField?.value, "<@user1>");
  assert.doesNotMatch(postedByField?.value ?? "", /\nID:/);
});
