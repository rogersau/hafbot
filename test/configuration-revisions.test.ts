/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  diffConfigurationSnapshots,
  prepareConfigurationRevisions,
  prepareTicketPanelRevisionMutation,
  serializeTicketPanelConfiguration,
  type ConfigurationActorContext,
} from "../src/configuration-revisions";
import { createCloudflareConfigurationRevisionStore } from "../src/runtime/cloudflare-configuration-revision-store";
import {
  botDefenseRevisionAdapter,
  configurationRevisionAdapters,
  webhookProxyRevisionAdapter,
} from "../src/configuration-revisions/adapters";
import {
  signConfigurationRestoreToken,
  verifyConfigurationRestoreToken,
} from "../src/configuration-revisions/restore-token";
import { createCloudflareTicketStore } from "../src/runtime/cloudflare-ticket-store";
import { createTicketPanelService } from "../src/services/tickets/ticket-panel";
import type { TicketPanelConfig } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";
import { createPermissiveGuildResourceValidator } from "./helpers/guild-resource-validator";

const actor: ConfigurationActorContext = {
  actorUserId: "user-1",
  source: "dashboard-save",
  operationId: "ticketsPanel.post",
  correlationId: "correlation-1",
};

function panel(name: string, messageId: string | null = null): TicketPanelConfig {
  return {
    guildId: "guild-1",
    panelId: "panel-1",
    panelName: name,
    panelChannelId: "channel-1",
    categoryChannelId: "category-1",
    transcriptChannelId: "transcript-1",
    panelEmoji: null,
    panelTitle: "Support",
    panelDescription: "Open a ticket",
    panelFooter: null,
    panelColor: 0x57f287,
    panelMessageId: messageId,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: true,
    aiTranscriptSummariesEnabled: false,
    ticketTypes: [],
  };
}

test("Ticket Panel snapshots are canonical and omit publication state", () => {
  const first = serializeTicketPanelConfiguration(panel("Main", "message-1"));
  const second = serializeTicketPanelConfiguration(panel("Main", "message-2"));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes("panelMessageId"), false);
});

test("Ticket Panel snapshots preserve participant management", () => {
  const configured = panel("Main");
  configured.ticketTypes = [
    {
      id: "support",
      label: "Support",
      emoji: null,
      buttonStyle: "primary",
      supportRoleId: "role-1",
      channelNamePrefix: "support",
      questions: [],
      autoReplyEnabled: false,
      autoReplyMessage: null,
      limitExclusion: false,
      participantManagementEnabled: true,
    },
  ];

  const snapshot = serializeTicketPanelConfiguration(configured);
  assert.match(JSON.stringify(snapshot), /"participantManagementEnabled":true/);
});

test("Premium Ticket Panel save captures baseline and update atomically", async () => {
  const database = new SqliteD1Database();
  const tickets = createCloudflareTicketStore(database.d1);
  const revisions = createCloudflareConfigurationRevisionStore(database.d1);
  await tickets.upsertTicketPanelConfig(panel("Before"));
  const service = createTicketPanelService({
    store: tickets,
    entitlements: {
      async readGuildEntitlement(guildId) {
        return { guildId, tier: "premium", updatedAtMs: 0 };
      },
    },
    configurationRevisions: revisions,
    guildResources: createPermissiveGuildResourceValidator(),
    discord: {
      async publish() {
        return "message";
      },
      async deleteMessage() {},
      async recordConfigChange() {},
    },
  });

  const result = await service.savePanel(panel("After"), actor);
  assert.equal(result.ok, true);
  const page = await service.listPanelRevisions({
    guildId: "guild-1",
    panelId: "panel-1",
    limit: 20,
    beforeCreatedAtMs: null,
  });
  assert.deepEqual(
    page.revisions.map((revision) => revision.operation),
    ["update", "baseline"],
  );
  assert.equal(page.revisions[0]?.actorUserId, "user-1");
  assert.equal(page.revisions[0]?.correlationId, "correlation-1");
  const detail = await service.getPanelRevision({
    guildId: "guild-1",
    revisionId: page.revisions[0]!.id,
  });
  assert.ok(detail);
  assert.ok(detail.diff.some((entry) => entry.path === "value.panelName"));
});

test("Free Ticket Panel saves do not record revisions", async () => {
  const database = new SqliteD1Database();
  const tickets = createCloudflareTicketStore(database.d1);
  const revisions = createCloudflareConfigurationRevisionStore(database.d1);
  const service = createTicketPanelService({
    store: tickets,
    entitlements: {
      async readGuildEntitlement(guildId) {
        return { guildId, tier: "free", updatedAtMs: 0 };
      },
    },
    configurationRevisions: revisions,
    guildResources: createPermissiveGuildResourceValidator(),
    discord: {
      async publish() {
        return "message";
      },
      async deleteMessage() {},
      async recordConfigChange() {},
    },
  });

  const result = await service.savePanel(panel("Free"), actor);
  assert.equal(result.ok, true);
  const page = await revisions.list({
    guildId: "guild-1",
    feature: "tickets",
    resourceKey: "panel-1",
    limit: 20,
    beforeCreatedAtMs: null,
  });
  assert.deepEqual(page.revisions, []);
});

test("Premium saves fail closed when revision storage is unavailable", async () => {
  const database = new SqliteD1Database();
  const tickets = createCloudflareTicketStore(database.d1);
  const service = createTicketPanelService({
    store: tickets,
    entitlements: {
      async readGuildEntitlement(guildId) {
        return { guildId, tier: "premium", updatedAtMs: 0 };
      },
    },
    guildResources: createPermissiveGuildResourceValidator(),
    discord: {
      async publish() {
        return "message";
      },
      async deleteMessage() {},
      async recordConfigChange() {},
    },
  });

  await assert.rejects(
    () => service.savePanel(panel("Premium"), actor),
    /revision storage is unavailable/,
  );
  assert.equal(await tickets.readTicketPanelConfigById!("guild-1", "panel-1"), null);
});

test("stale revision heads roll back the Ticket Panel mutation", async () => {
  const database = new SqliteD1Database();
  const tickets = createCloudflareTicketStore(database.d1);
  const revisions = createCloudflareConfigurationRevisionStore(database.d1);
  const initial = await prepareTicketPanelRevisionMutation({
    currentPanel: null,
    nextPanel: panel("Initial"),
    head: null,
    actor,
    createId: idSequence("00000000-0000-4000-8000-00000000000"),
    now: () => 100,
  });
  await revisions.commitTicketPanelMutation(initial);
  const head = await revisions.readHead({
    guildId: "guild-1",
    feature: "tickets",
    resourceKey: "panel-1",
  });
  assert.ok(head);
  const first = await prepareTicketPanelRevisionMutation({
    currentPanel: panel("Initial"),
    nextPanel: panel("First"),
    head,
    actor,
    createId: () => "10000000-0000-4000-8000-000000000001",
    now: () => 200,
  });
  const stale = await prepareTicketPanelRevisionMutation({
    currentPanel: panel("Initial"),
    nextPanel: panel("Stale"),
    head,
    actor,
    createId: () => "20000000-0000-4000-8000-000000000002",
    now: () => 201,
  });
  await revisions.commitTicketPanelMutation(first);
  await assert.rejects(() => revisions.commitTicketPanelMutation(stale), /head conflict/);
  assert.equal(
    (await tickets.readTicketPanelConfigById!("guild-1", "panel-1"))?.panelName,
    "First",
  );
});

test("Ticket revision timestamps remain monotonic within one resource", async () => {
  const first = await prepareTicketPanelRevisionMutation({
    currentPanel: null,
    nextPanel: panel("First"),
    head: null,
    actor,
    createId: () => "30000000-0000-4000-8000-000000000003",
    now: () => 100,
  });
  const second = await prepareTicketPanelRevisionMutation({
    currentPanel: panel("First"),
    nextPanel: panel("Second"),
    head: first.revision,
    actor,
    createId: () => "40000000-0000-4000-8000-000000000004",
    now: () => 100,
  });

  assert.equal(first.revision.createdAtMs, 100);
  assert.equal(second.revision.createdAtMs, 101);
});

test("structural diff remains safe JSON text", () => {
  const before = JSON.stringify(serializeTicketPanelConfiguration(panel("Before")));
  const after = JSON.stringify(serializeTicketPanelConfiguration(panel("After")));
  const diff = diffConfigurationSnapshots(before, after);
  assert.deepEqual(diff, [
    { path: "value.panelName", kind: "changed", before: "Before", after: "After" },
  ]);
});

test("the generic adapter registry includes every initial configuration feature", () => {
  assert.deepEqual(configurationRevisionAdapters.list(), [
    "tickets",
    "webhook-proxy",
    "mention-protection",
    "bot-defense",
    "member-verification",
    "guild-audit-log",
  ]);
});

test("Webhook Proxy snapshots never contain credentials or webhook URLs", () => {
  const snapshot = webhookProxyRevisionAdapter.serialize(
    {
      guildId: "guild-1",
      publicId: "proxy-1",
      name: "Alerts",
      enabled: true,
      banLookupEnabled: true,
      banLookupNotificationUrl: "https://discord.com/api/webhooks/123/ban-secret",
      banLookupAppIds: [2, 1],
      destinations: [
        {
          id: "destination-1",
          label: "Staff",
          url: "https://discord.com/api/webhooks/123/destination-secret",
        },
      ],
      defaultDestinationIds: ["destination-1"],
      routingRules: [],
      contentReplacements: [],
      createdAtMs: 1,
      updatedAtMs: 2,
    },
    "proxy-1",
  );
  const serialized = JSON.stringify(snapshot);

  assert.doesNotMatch(serialized, /discord\.com|ban-secret|destination-secret/);
  assert.match(serialized, /"state":"configured"/);
  assert.deepEqual(snapshot.value?.banLookupAppIds, [1, 2]);
});

test("generic paid feature mutations commit current state and revision atomically", async () => {
  const database = new SqliteD1Database();
  const revisions = createCloudflareConfigurationRevisionStore(database.d1);
  const next = {
    guildId: "guild-1",
    honeypotEnabled: true,
    honeypotWarnUser: true,
    honeypotDeleteMessage: false,
    rateEnabled: false,
    rateWarnUser: false,
    rateDeleteMessage: false,
    honeypotChannelIds: ["channel-1"],
    rateChannelThreshold: 5,
    rateWindowSeconds: 60,
    excludedRoleIds: [],
    modRoleIds: [],
    modQueueChannelId: null,
    pingOnQueuePost: true,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const prepared = await prepareConfigurationRevisions({
    guildId: "guild-1",
    feature: "bot-defense",
    resourceKey: "default",
    currentSnapshot: botDefenseRevisionAdapter.serialize(null, "default"),
    nextSnapshot: botDefenseRevisionAdapter.serialize(next, "default"),
    currentExists: false,
    nextExists: true,
    head: null,
    actor,
  });
  await revisions.commitVersionedMutation!({
    feature: "bot-defense",
    current: null,
    next,
    ...prepared,
  });

  const row = await database.d1
    .prepare("SELECT honeypot_enabled FROM bot_defense_configs WHERE guild_id = ?")
    .bind("guild-1")
    .first<{ honeypot_enabled: number }>();
  assert.equal(row?.honeypot_enabled, 1);
  assert.equal(
    (
      await revisions.readHead({
        guildId: "guild-1",
        feature: "bot-defense",
        resourceKey: "default",
      })
    )?.operation,
    "create",
  );
});

test("restore preview tokens are signed, expiring, and contain no snapshots", async () => {
  const secret = "configuration-revision-test-secret-at-least-32-bytes";
  const payload = {
    version: 1 as const,
    guildId: "guild-1",
    feature: "bot-defense" as const,
    resourceKey: "default",
    targetRevisionId: "revision-1",
    currentHeadId: "head-1",
    currentSnapshotHash: "current-hash",
    targetSnapshotHash: "target-hash",
    entitlementTier: "premium",
    expiresAtMs: 2_000,
    nonce: "nonce-1",
  };
  const token = await signConfigurationRestoreToken(payload, secret);
  assert.doesNotMatch(token, /snapshot|guild-1|bot-defense/);
  assert.deepEqual(await verifyConfigurationRestoreToken(token, secret, 1_000), payload);
  await assert.rejects(
    () => verifyConfigurationRestoreToken(token, secret, 2_000),
    /restore_preview_expired/,
  );
  await assert.rejects(
    () => verifyConfigurationRestoreToken(`${token}tampered`, secret, 1_000),
    /restore_preview_invalid/,
  );
});

function idSequence(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}${counter++}`.slice(0, 36);
}
