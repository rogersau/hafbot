import { testWebhookCredential } from "./support/webhook-credentials";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBanCasePermissionChecks,
  buildEventPermissionChecks,
  buildGuildAuditLogPermissionChecks,
  buildWebhookPermissionChecks,
  type GuildPermissionContext,
} from "../src/runtime/admin-permissions";
import type {
  BanCaseConfig,
  BanCaseSource,
  EventRecord,
  GuildAuditLogConfig,
  WebhookProxyConfig,
} from "../src/types";

const context: GuildPermissionContext = {
  guildId: "guild-1",
  botUserId: "bot-1",
  channels: [
    { id: "events", name: "events", type: 0, parent_id: null, position: 0 },
    { id: "audit", name: "audit", type: 0, parent_id: null, position: 1 },
    { id: "cases", name: "cases", type: 15, parent_id: null, position: 2 },
  ],
  roles: [{ id: "guild-1", name: "@everyone", permissions: "8", position: 0 }],
  member: { roles: [] },
};

test("Event and Guild Audit Log setup checks use saved Discord destinations", () => {
  const event: EventRecord = {
    guildId: "guild-1",
    id: "event-1",
    templateId: null,
    title: "Raid",
    description: "",
    status: "draft",
    channelId: "events",
    messageId: null,
    threadId: null,
    startsAtMs: 1,
    endsAtMs: null,
    signupCutoffAtMs: 1,
    signupMode: "single_choice",
    participationMode: "individual",
    requiredTeamSize: null,
    threadEnabled: true,
    waitlistedMembersJoinThread: false,
    groups: [],
    reminders: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    publishedAtMs: null,
    cancelledAtMs: null,
    endedAtMs: null,
    archivedAtMs: null,
  };
  const audit = {
    guildId: "guild-1",
    auditChannelId: "audit",
    groupChannelIds: {},
    eventStates: {},
    updatedAtMs: 1,
  } as GuildAuditLogConfig;

  assert.ok(buildEventPermissionChecks(context, [event]).every((check) => check.status === "ok"));
  assert.ok(
    buildGuildAuditLogPermissionChecks(context, audit).every((check) => check.status === "ok"),
  );
  assert.deepEqual(buildEventPermissionChecks(context, []), []);
  assert.deepEqual(buildGuildAuditLogPermissionChecks(context, null), []);
});

test("Webhook setup checks validate locally without contacting destinations", () => {
  const config: WebhookProxyConfig = {
    guildId: "guild-1",
    publicId: "public-1",
    name: "Alerts",
    enabled: true,
    banLookupEnabled: false,
    banLookupCredentialId: null,
    banLookupAppIds: [],
    destinations: [
      {
        id: "main",
        label: "Main",
        credentialId: testWebhookCredential("https://example.com/webhook"),
      },
    ],
    defaultDestinationIds: ["main"],
    routingRules: [],
    contentReplacements: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };

  assert.equal(buildWebhookPermissionChecks([config])[0]?.status, "ok");
  assert.equal(buildWebhookPermissionChecks([config])[0]?.id, "webhook-configuration-public-1");
  assert.equal(buildWebhookPermissionChecks([{ ...config, enabled: false }])[0]?.status, "warning");
  assert.match(buildWebhookPermissionChecks([config], false)[0]?.detail ?? "", /dormant/i);
  assert.equal(
    buildWebhookPermissionChecks([{ ...config, defaultDestinationIds: ["missing"] }])[0]?.status,
    "error",
  );
  assert.deepEqual(buildWebhookPermissionChecks([]), []);
});

test("Ban Case setup checks require a usable forum and an enabled source", () => {
  const config: BanCaseConfig = {
    guildId: "guild-1",
    enabled: true,
    forumChannelId: "cases",
    modRoleIds: [],
    updatedAtMs: 1,
  };
  const source: BanCaseSource = {
    guildId: "guild-1",
    sourceId: "source-1",
    publicId: "public-1",
    name: "Game bans",
    enabled: true,
    platform: "steam",
    pattern: "(?<steamId>\\d+)",
    flags: "",
    subjectIdGroup: "steamId",
    nameGroup: "name",
    reasonGroup: "reason",
    createdAtMs: 1,
    updatedAtMs: 1,
  };

  assert.ok(
    buildBanCasePermissionChecks(context, config, [source]).every((check) => check.status === "ok"),
  );
  assert.equal(
    buildBanCasePermissionChecks(context, { ...config, enabled: false }, [source])[0]?.status,
    "warning",
  );
  assert.equal(
    buildBanCasePermissionChecks(context, config, [source])[0]?.id,
    "ban-cases-availability",
  );
  assert.match(
    buildBanCasePermissionChecks(context, config, [source], false)[0]?.detail ?? "",
    /dormant/i,
  );
  assert.deepEqual(buildBanCasePermissionChecks(context, null, []), []);
});
