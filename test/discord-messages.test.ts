/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import {
  allowUserMentions,
  buildAuditEmbed,
  formatStaffUserReference,
  formatUserMention,
  suppressMentions,
} from "../src/discord/messages";

test("buildAuditEmbed adds audit defaults and normalizes fields", () => {
  const embed = buildAuditEmbed({
    title: "Audit event",
    color: 0x5865f2,
    fields: [
      { name: "User", value: "<@123>", inline: true },
      { name: "Reason", value: "Rule violation" },
    ],
  });

  assert.equal(embed.title, "Audit event");
  assert.equal(embed.color, 0x5865f2);
  assert.deepEqual(embed.footer, { text: "hafbot.xyz" });
  assert.match(embed.timestamp ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(embed.fields, [
    { name: "User", value: "<@123>", inline: false },
    { name: "Reason", value: "Rule violation", inline: false },
  ]);
});

test("buildAuditEmbed uses an explicit event timestamp when provided", () => {
  const eventAt = "2026-01-01T12:00:00.000Z";
  const embed = buildAuditEmbed({
    title: "Audit event",
    color: 0x5865f2,
    fields: [],
    timestamp: eventAt,
  });

  assert.equal(embed.timestamp, eventAt);
});

test("user reference helpers render staff and user facing mentions with reusable controls", () => {
  assert.equal(formatStaffUserReference("123456789"), "<@123456789>\nID: 123456789");
  assert.equal(formatUserMention("123456789"), "<@123456789>");
  assert.deepEqual(suppressMentions(), { parse: [] });
  assert.deepEqual(allowUserMentions(["123456789", "987654321"]), {
    parse: [],
    users: ["123456789", "987654321"],
  });
});
