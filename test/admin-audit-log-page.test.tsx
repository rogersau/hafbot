/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile via tsconfig.tests.json.
import test from "node:test";
import { renderToString } from "react-dom/server";

import type { GuildAuditLogConfig } from "../src/types";
import { AdminAuditLogPage } from "../src/admin/components/admin-audit-log-page";

function renderAuditLog(config: GuildAuditLogConfig | null) {
  return renderToString(
    <AdminAuditLogPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{ guildId: "guild-1", config, entitlement: null, canWrite: true }}
      tier="free"
    />,
  );
}

test("Guild Audit Log defaults unchanged groups to collapsed summaries", () => {
  const html = renderAuditLog(null);
  const text = html.replace(/<[^>]+>/g, "");

  assert.equal((html.match(/<details/g) ?? []).length, 13);
  assert.equal((html.match(/<details open/g) ?? []).length, 0);
  assert.match(text, /Default destination/);
  assert.match(text, /7 of 7 events enabled/);
  assert.match(text, /Search audit events/);
});

test("Guild Audit Log summaries expose destinations and inherited versus explicit event state", () => {
  const html = renderAuditLog({
    guildId: "guild-1",
    auditChannelId: "audit-channel",
    groupChannelIds: { member: "member-channel" },
    eventStates: {
      groups: { member: false },
      overrides: { "member.join": true },
    },
    excludedChannelIds: [],
    excludedRoleIds: [],
    updatedAtMs: 1,
  });
  const text = html.replace(/<[^>]+>/g, "");

  assert.match(text, /1 of 7 events enabled/);
  assert.match(text, /#dedicated-channel/);
  assert.match(text, /Explicit override/);
  assert.match(text, /Uses group setting · Disabled/);
  assert.match(text, /Use group setting/);
  assert.match(text, /Reset event overrides \(1\)/);
});
