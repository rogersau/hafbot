/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  buildTicketPanelMessage,
  createDiscordTicketPanelAdapter,
  createTicketPanelService,
  type TicketPanelDiscordAdapter,
} from "../src/services/tickets/ticket-panel";
import type { TicketStore } from "../src/runtime/contracts";
import type { TicketPanelConfig } from "../src/types";
import { createTicketLifecycle } from "../src/services/tickets/ticket-lifecycle";
import { handleTicketSlashCommandInteraction } from "../src/runtime/ticket-interaction-handler";
import type { ProductionRuntimeStoresFixture } from "./support/production-runtime-stores";
import { afterStoreSeed, createProductionRuntimeStores } from "./support/production-runtime-stores";
import {
  createPermissiveGuildResourceValidator,
  createStaticGuildResourceValidator,
  testChannel,
  testRole,
} from "./helpers/guild-resource-validator";
import { GuildResourceValidationError } from "../src/discord/guild-resource-validator";
import { DiscordApiError } from "../src/discord/client";
import type { ProductAnalyticsEvent, ProductAnalyticsReporter } from "../src/product-analytics";

const ticketFixtures = new WeakMap<TicketPanelConfig[], ProductionRuntimeStoresFixture>();

test("Ticket Panel builds the production Discord payload with stable custom IDs", () => {
  const message = buildTicketPanelMessage(createPanel());

  assert.deepEqual(message, {
    content: "",
    embeds: [
      {
        color: 0x57f287,
        title: "🎫 Support",
        description: "Choose a request type.",
        footer: { text: "Private support" },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            custom_id: "ticket:open:panel-1:support",
            label: "Support",
            style: 1,
          },
        ],
      },
    ],
  });
});

test("Ticket Panel publishes Ticket Types in configured array order", () => {
  const panel = createPanel();
  panel.ticketTypes = [
    panel.ticketTypes[0]!,
    {
      ...panel.ticketTypes[0]!,
      id: "billing",
      label: "Billing",
      channelNamePrefix: "billing",
    },
    {
      ...panel.ticketTypes[0]!,
      id: "appeal",
      label: "Appeal",
      channelNamePrefix: "appeal",
    },
  ];

  const message = buildTicketPanelMessage(panel);

  assert.deepEqual(
    message.components.flatMap((row) => row.components.map((button) => button.label)),
    ["Support", "Billing", "Appeal"],
  );
});

test("Ticket Panel owns the free panel limit", async () => {
  const panels = [createPanel()];
  const store = createStore(panels);
  const service = createTicketPanelService({
    store,
    entitlements: {
      readGuildEntitlement: async (guildId) => ({ guildId, tier: "free", updatedAtMs: 1 }),
    },
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
    createId: () => "panel-2",
  });

  const result = await service.createPanel({ guildId: "guild-1", mode: "blank" });

  assert.deepEqual(result, {
    ok: false,
    code: "plan-limit",
    message:
      "The Free plan supports 1 Ticket Panel. Delete the existing panel or upgrade to create another.",
  });
});

test("Ticket Panel normalizes participant management when cloning legacy Ticket types", async () => {
  const source = createPanel();
  delete source.ticketTypes[0]!.participantManagementEnabled;
  const panels = [source];
  const store = createStore(panels);
  store.listTicketPanelConfigs = async () => [source];
  store.readTicketPanelConfigById = async () => source;
  const service = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    configurationRevisions: createTestConfigurationRevisionStore(panels),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
    createId: () => "panel-clone",
  });

  const result = await service.createPanel({
    guildId: "guild-1",
    mode: "clone",
    sourcePanelId: "panel-1",
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.ticketTypes[0]?.participantManagementEnabled, false);
});

test("Ticket Panel refuses to clone a legacy over-limit modal field", async () => {
  const source = createPanel();
  source.ticketTypes[0]!.questions = [
    {
      id: "reason",
      label: "L".repeat(46),
      style: "short",
      placeholder: null,
      required: true,
    },
  ];
  const panels = [source];
  const store = createStore(panels);
  const service = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    configurationRevisions: createTestConfigurationRevisionStore(panels),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
    createId: () => "panel-clone",
  });

  const result = await service.createPanel({
    guildId: "guild-1",
    mode: "clone",
    sourcePanelId: "panel-1",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid-panel");
    assert.match(result.message, /Question label must be 45 characters or fewer/);
  }
  assert.equal((await store.listTicketPanelConfigs("guild-1"))?.length, 1);
});

test("Ticket Panel refuses to restore a legacy over-limit modal field", async () => {
  const panel = createPanel();
  panel.ticketTypes[0]!.questions = [
    {
      id: "reason",
      label: "Reason",
      style: "short",
      placeholder: null,
      required: true,
    },
  ];
  const panels = [panel];
  const store = createStore(panels);
  const configurationRevisions = createTestConfigurationRevisionStore(panels);
  const service = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    configurationRevisions,
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
  });

  const saved = await service.savePanel({ ...panel, panelTitle: "Updated" });
  assert.equal(saved.ok, true);
  const head = await configurationRevisions.readHead({
    guildId: "guild-1",
    feature: "tickets",
    resourceKey: "panel-1",
  });
  assert.ok(head);
  const snapshot = JSON.parse(head.snapshotJson) as {
    value: { ticketTypes: Array<{ questions: Array<{ label: string }> }> };
  };
  snapshot.value.ticketTypes[0]!.questions[0]!.label = "L".repeat(46);
  const legacyRevision = { ...head, snapshotJson: JSON.stringify(snapshot) };
  const restoreService = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    configurationRevisions: {
      ...configurationRevisions,
      readHead: async () => head,
      readById: async () => legacyRevision,
    },
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
  });

  await assert.rejects(
    () =>
      restoreService.preparePanelRestore({
        guildId: "guild-1",
        revisionId: head.id,
        resources: validResources(),
        signingSecret: "restore-secret-01234567890123456789",
      }),
    /Question label must be 45 characters or fewer/,
  );
  assert.equal(
    (await store.readTicketPanelConfigById("guild-1", "panel-1"))?.panelTitle,
    "Updated",
  );
});

test("Ticket Panel publishes through its Discord adapter and persists the returned message ID", async () => {
  const panels = [createPanel()];
  const publishedPayloads: unknown[] = [];
  const store = createStore(panels);
  const service = createTicketPanelService({
    store,
    entitlements: {
      readGuildEntitlement: async (guildId) => ({ guildId, tier: "premium", updatedAtMs: 1 }),
    },
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter({
      publish: async (_panel, message) => {
        publishedPayloads.push(message);
        return "message-2";
      },
    }),
  });

  const result = await service.publishPanel({
    panel: panels[0],
    resources: {
      channels: [
        { id: "panel-channel", name: "tickets", type: 0, parent_id: null, position: 1 },
        { id: "category", name: "Tickets", type: 4, parent_id: null, position: 0 },
        { id: "transcripts", name: "transcripts", type: 0, parent_id: null, position: 2 },
      ],
      roles: [{ id: "support-role", name: "Support", permissions: "0", position: 1 }],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(
    (await store.readTicketPanelConfigById("guild-1", "panel-1"))?.panelMessageId,
    "message-2",
  );
  assert.deepEqual(publishedPayloads, [buildTicketPanelMessage(createPanel())]);
});

test("Ticket Panel returns a typed provider failure without persisting a failed publish", async () => {
  const panel = createPanel();
  const panels = [panel];
  const store = createStore(panels);
  const service = createTicketPanelService({
    store,
    entitlements: {
      readGuildEntitlement: async (guildId) => ({ guildId, tier: "premium", updatedAtMs: 1 }),
    },
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter({
      publish: async () => {
        throw new Error("Discord unavailable");
      },
    }),
  });

  const result = await service.publishPanel({
    panel,
    resources: {
      channels: [
        { id: "panel-channel", name: "tickets", type: 0, parent_id: null, position: 1 },
        { id: "category", name: "Tickets", type: 4, parent_id: null, position: 0 },
        { id: "transcripts", name: "transcripts", type: 0, parent_id: null, position: 2 },
      ],
      roles: [{ id: "support-role", name: "Support", permissions: "0", position: 1 }],
    },
  });

  assert.deepEqual(result, {
    ok: false,
    code: "provider-failure",
    message: "Discord unavailable",
  });
  assert.equal((await store.readTicketPanelConfigById("guild-1", "panel-1"))?.panelMessageId, null);
});

test("Ticket Panel preserves the canonical saved publication ID", async () => {
  const saved = createPanel();
  saved.panelMessageId = "canonical-message";
  const candidate = { ...saved, panelTitle: "Updated", panelMessageId: "forged-message" };
  const panels = [saved];
  const store = createStore(panels);
  const service = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    configurationRevisions: createTestConfigurationRevisionStore(panels),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
  });

  const result = await service.savePanel(candidate);

  assert.equal(result.ok, true);
  assert.equal(
    (await store.readTicketPanelConfigById("guild-1", "panel-1"))?.panelMessageId,
    "canonical-message",
  );
});

test("Ticket Panel requires unpublish before moving a live panel", async () => {
  const saved = createPanel();
  saved.panelMessageId = "canonical-message";
  const service = createTicketPanelService({
    store: createStore([saved]),
    entitlements: premiumEntitlements(),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
  });

  const result = await service.savePanel({ ...saved, panelChannelId: "another-channel" });

  assert.deepEqual(result, {
    ok: false,
    code: "invalid-panel",
    message: "Unpublish this panel before changing its panel channel.",
  });
});

test("Ticket Panel compensates a publish when persistence fails", async () => {
  const panel = createPanel();
  const deleted: string[] = [];
  const store = createStore([panel]);
  store.upsertTicketPanelConfig = async () => {
    throw new Error("D1 unavailable");
  };
  const service = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter({
      publish: async () => "new-message",
      deleteMessage: async (_guildId, _channelId, messageId) => {
        deleted.push(messageId);
      },
    }),
  });

  const result = await service.publishPanel({ panel, resources: validResources() });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "persistence-failure");
  assert.deepEqual(deleted, ["new-message"]);
});

test("Ticket Panel exposes recovery when publish compensation also fails", async () => {
  const panel = createPanel();
  const store = createStore([panel]);
  store.upsertTicketPanelConfig = async () => {
    throw new Error("D1 unavailable");
  };
  const service = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter({
      publish: async () => "orphan-message",
      deleteMessage: async () => {
        throw new Error("Discord unavailable");
      },
    }),
  });

  const result = await service.publishPanel({ panel, resources: validResources() });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "partial-success");
    assert.deepEqual(result.recovery, {
      operation: "publish",
      guildId: "guild-1",
      channelId: "panel-channel",
      messageId: "orphan-message",
      panel: { ...panel, panelMessageId: "orphan-message" },
    });
    store.upsertTicketPanelConfig = createStore([panel]).upsertTicketPanelConfig;
    const recovered = await service.resumeRecovery(result.recovery!);
    assert.equal(recovered.ok, true);
  }
});

test("Ticket Panel rejects cross-guild recovery state before persistence", async () => {
  const panel = createPanel();
  let writes = 0;
  const store = createStore([panel]);
  const normalUpsert = store.upsertTicketPanelConfig;
  store.upsertTicketPanelConfig = async (candidate) => {
    writes += 1;
    await normalUpsert(candidate);
  };
  const service = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
  });

  const crossGuild = await service.resumeRecovery({
    operation: "publish",
    guildId: "guild-1",
    channelId: "panel-channel",
    messageId: "message-1",
    panel: { ...panel, guildId: "guild-2", panelMessageId: "message-1" },
  });
  assert.equal(crossGuild.ok, false);
  if (!crossGuild.ok) assert.equal(crossGuild.code, "invalid-panel");
  assert.equal(writes, 0);
});

test("Ticket Panel recovers publication of an edited candidate over stale saved config", async () => {
  const saved = createPanel();
  const candidate = { ...saved, panelTitle: "Edited before publish" };
  const panels = [saved];
  const store = createStore(panels);
  let writes = 0;
  const normalUpsert = store.upsertTicketPanelConfig;
  store.upsertTicketPanelConfig = async (panel) => {
    writes += 1;
    if (writes === 1) throw new Error("D1 unavailable");
    await normalUpsert(panel);
  };
  const service = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter({
      publish: async () => "message-1",
      deleteMessage: async () => {
        throw new Error("Discord unavailable");
      },
    }),
  });

  const result = await service.publishPanel({ panel: candidate, resources: validResources() });
  assert.equal(result.ok, false);
  if (!result.ok && result.recovery) {
    assert.equal((await service.resumeRecovery(result.recovery)).ok, true);
  } else {
    assert.fail("expected recoverable publication");
  }
  const recovered = await store.readTicketPanelConfigById("guild-1", "panel-1");
  assert.equal(recovered?.panelTitle, "Edited before publish");
  assert.equal(recovered?.panelMessageId, "message-1");
});

test("Ticket Panel recovery is idempotent after publish, unpublish, and delete", async () => {
  const published = { ...createPanel(), panelMessageId: "message-1" };
  let writes = 0;
  let deletes = 0;
  let audits = 0;
  const publishedStore = createStore([published]);
  const canonicalPublished = await publishedStore.readTicketPanelConfigById("guild-1", "panel-1");
  assert.ok(canonicalPublished);
  publishedStore.upsertTicketPanelConfig = async () => {
    writes += 1;
  };
  const publishedService = createTicketPanelService({
    store: publishedStore,
    entitlements: premiumEntitlements(),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter({
      recordConfigChange: async () => {
        audits += 1;
      },
    }),
  });
  assert.equal(
    (
      await publishedService.resumeRecovery({
        operation: "publish",
        guildId: "guild-1",
        channelId: "panel-channel",
        messageId: "message-1",
        panel: canonicalPublished,
      })
    ).ok,
    true,
  );

  const unpublished = createPanel();
  const unpublishedStore = createStore([unpublished]);
  const canonicalUnpublished = await unpublishedStore.readTicketPanelConfigById(
    "guild-1",
    "panel-1",
  );
  assert.ok(canonicalUnpublished);
  const unpublishedService = createTicketPanelService({
    store: unpublishedStore,
    entitlements: premiumEntitlements(),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
  });
  assert.equal(
    (
      await unpublishedService.resumeRecovery({
        operation: "unpublish",
        guildId: "guild-1",
        channelId: "panel-channel",
        messageId: "message-1",
        panel: canonicalUnpublished,
      })
    ).ok,
    true,
  );

  const deletedStore = createStore([]);
  deletedStore.deleteTicketPanelConfig = async () => {
    deletes += 1;
  };
  const deletedService = createTicketPanelService({
    store: deletedStore,
    entitlements: premiumEntitlements(),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
  });
  assert.equal(
    (
      await deletedService.resumeRecovery({
        operation: "delete",
        guildId: "guild-1",
        panelId: "panel-1",
        channelId: "panel-channel",
        messageId: "message-1",
      })
    ).ok,
    true,
  );

  assert.deepEqual({ writes, audits, deletes }, { writes: 0, audits: 0, deletes: 0 });
});

test("Ticket Panel unpublish is resumable after persistence failure", async () => {
  const panel = createPanel();
  panel.panelMessageId = "message-1";
  const panels = [panel];
  const store = createStore(panels);
  let persistAttempts = 0;
  const normalUpsert = store.upsertTicketPanelConfig;
  store.upsertTicketPanelConfig = async (candidate) => {
    persistAttempts += 1;
    if (persistAttempts === 1) throw new Error("D1 unavailable");
    await normalUpsert(candidate);
  };
  const deleted: string[] = [];
  const service = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter({
      // Production treats a repeated Discord 404 as success; this fake is idempotent too.
      deleteMessage: async (_guildId, _channelId, messageId) => {
        deleted.push(messageId);
      },
    }),
  });

  const partial = await service.unpublishPanel({ guildId: "guild-1", panelId: "panel-1" });
  const retried = await service.unpublishPanel({ guildId: "guild-1", panelId: "panel-1" });

  assert.equal(partial.ok, false);
  if (!partial.ok) assert.equal(partial.code, "partial-success");
  assert.equal(retried.ok, true);
  assert.deepEqual(deleted, ["message-1", "message-1"]);
  assert.equal((await store.readTicketPanelConfigById("guild-1", "panel-1"))?.panelMessageId, null);
});

test("Ticket Panel unpublish recovery clears stale state after its first write fails", async () => {
  const panel = { ...createPanel(), panelMessageId: "message-1" };
  const store = createStore([panel]);
  let upsertAttempts = 0;
  const normalUpsert = store.upsertTicketPanelConfig;
  store.upsertTicketPanelConfig = async (candidate) => {
    upsertAttempts += 1;
    if (upsertAttempts === 1) throw new Error("D1 unavailable");
    await normalUpsert(candidate);
  };
  let deletes = 0;
  const service = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    guildResources: createStaticGuildResourceValidator({
      guilds: { "guild-1": { channels: [], roles: [] } },
    }),
    discord: createDiscordAdapter({
      deleteMessage: async () => {
        deletes += 1;
      },
    }),
  });

  const partial = await service.unpublishPanel({ guildId: "guild-1", panelId: "panel-1" });
  assert.equal(partial.ok, false);
  if (partial.ok || !partial.recovery) assert.fail("expected unpublish recovery");
  const recovered = await service.resumeRecovery(partial.recovery);

  assert.equal(recovered.ok, true);
  assert.equal(deletes, 0);
  assert.equal((await store.readTicketPanelConfigById("guild-1", "panel-1"))?.panelMessageId, null);
});

test("Ticket Panel unpublish clears stale publication when its channel is missing", async () => {
  const panel = { ...createPanel(), panelMessageId: "message-1" };
  const store = createStore([panel]);
  let deletes = 0;
  const service = createTicketPanelService({
    store,
    entitlements: freeEntitlements(),
    guildResources: createStaticGuildResourceValidator({
      guilds: { "guild-1": { channels: [], roles: [] } },
    }),
    discord: createDiscordAdapter({
      deleteMessage: async () => {
        deletes += 1;
      },
    }),
  });

  const result = await service.unpublishPanel({ guildId: "guild-1", panelId: "panel-1" });

  assert.equal(result.ok, true);
  assert.equal(deletes, 0);
  assert.equal((await store.readTicketPanelConfigById("guild-1", "panel-1"))?.panelMessageId, null);
});

test("Ticket Panel unpublish treats a deleted Discord message as already absent", async () => {
  const panel = { ...createPanel(), panelMessageId: "message-1" };
  const store = createStore([panel]);
  const service = createTicketPanelService({
    store,
    entitlements: freeEntitlements(),
    guildResources: createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [testChannel("panel-channel", 0, "guild-1")], roles: [] },
      },
    }),
    discord: createDiscordAdapter({
      deleteMessage: async () => {
        throw new DiscordApiError("missing", 404, "missing");
      },
    }),
  });

  const result = await service.unpublishPanel({ guildId: "guild-1", panelId: "panel-1" });

  assert.equal(result.ok, true);
  assert.equal((await store.readTicketPanelConfigById("guild-1", "panel-1"))?.panelMessageId, null);
});

test("Ticket Panel deletion removes stale cross-guild publication without Discord deletion", async () => {
  const panel = {
    ...createPanel(),
    panelMessageId: "message-1",
    panelChannelId: "channel-from-another-guild",
  };
  const store = createStore([panel]);
  let deletes = 0;
  const service = createTicketPanelService({
    store,
    entitlements: freeEntitlements(),
    guildResources: createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [testChannel("channel-from-another-guild", 0, "guild-2")],
          roles: [],
        },
        "guild-2": {
          channels: [testChannel("channel-from-another-guild", 0, "guild-2")],
          roles: [],
        },
      },
    }),
    discord: createDiscordAdapter({
      deleteMessage: async () => {
        deletes += 1;
      },
    }),
  });

  const result = await service.deletePanel({ guildId: "guild-1", panelId: "panel-1" });

  assert.equal(result.ok, true);
  assert.equal(deletes, 0);
  assert.equal(await store.readTicketPanelConfigById("guild-1", "panel-1"), null);
});

test("Ticket Panel resets a stale main panel when its published channel is missing", async () => {
  const panel = {
    ...createPanel(),
    panelId: "main",
    panelMessageId: "message-1",
  };
  const store = createStore([panel]);
  let deletes = 0;
  const service = createTicketPanelService({
    store,
    entitlements: freeEntitlements(),
    guildResources: createStaticGuildResourceValidator({
      guilds: { "guild-1": { channels: [], roles: [] } },
    }),
    discord: createDiscordAdapter({
      deleteMessage: async () => {
        deletes += 1;
      },
    }),
  });

  const result = await service.deletePanel({ guildId: "guild-1", panelId: "main" });

  assert.equal(result.ok, true);
  assert.equal(deletes, 0);
  assert.equal(await store.readTicketPanelConfigById("guild-1", "main"), null);
});

test("Ticket Panel deletion still blocks stale cleanup while Tickets are open", async () => {
  const panel = { ...createPanel(), panelMessageId: "message-1" };
  const store = createStore([panel]);
  store.countOpenTicketsForPanel = async () => 1;
  let deletes = 0;
  const service = createTicketPanelService({
    store,
    entitlements: freeEntitlements(),
    guildResources: createStaticGuildResourceValidator({
      guilds: { "guild-1": { channels: [], roles: [] } },
    }),
    discord: createDiscordAdapter({
      deleteMessage: async () => {
        deletes += 1;
      },
    }),
  });

  const result = await service.deletePanel({ guildId: "guild-1", panelId: "panel-1" });

  assert.deepEqual(result, {
    ok: false,
    code: "open-tickets",
    message: "Cannot delete a ticket panel while it has open tickets.",
  });
  assert.equal(deletes, 0);
  assert.ok(await store.readTicketPanelConfigById("guild-1", "panel-1"));
});

test("Ticket Panel scopes deletion and recovery open-ticket checks to the requested panel", async () => {
  const main = {
    ...createPanel(),
    panelId: "main",
    panelName: "Main",
    panelChannelId: "main-channel",
    panelMessageId: "main-message",
  };
  const escalation = {
    ...createPanel(),
    panelId: "panel-escalation",
    panelName: "Escalation",
    panelChannelId: "escalation-channel",
  };
  const store = createStore([main, escalation]);
  await store.createTicketInstance({
    ...createTicket(),
    channelId: "main-ticket",
    panelId: "main",
  });
  const service = createTicketPanelService({
    store,
    entitlements: freeEntitlements(),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
  });

  const deleted = await service.deletePanel({ guildId: "guild-1", panelId: "panel-escalation" });

  assert.deepEqual(deleted, { ok: true, value: undefined });
  assert.ok(await store.readTicketPanelConfigById("guild-1", "main"));
  assert.equal(await store.readTicketPanelConfigById("guild-1", "panel-escalation"), null);

  const blocked = await service.resumeRecovery({
    operation: "delete",
    guildId: "guild-1",
    panelId: "main",
    channelId: "main-channel",
    messageId: "main-message",
  });

  assert.deepEqual(blocked, {
    ok: false,
    code: "open-tickets",
    message: "Cannot recover deletion while the panel has open tickets.",
  });
  assert.equal(await store.countOpenTicketsForPanel("guild-1", "main"), 1);
});

test("Ticket Panel restore deletion refuses while the requested panel has open tickets", async () => {
  const panel = { ...createPanel(), panelTitle: "Initial" };
  const panels = [panel];
  const store = createStore(panels);
  const configurationRevisions = createTestConfigurationRevisionStore(panels);
  const service = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    configurationRevisions,
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
  });
  const actor = {
    actorUserId: "admin-user",
    source: "dashboard-save" as const,
    operationId: "ticketsPanel.post",
    correlationId: null,
  };

  assert.equal((await service.savePanel(panel, actor)).ok, true);
  assert.equal(
    (await service.deletePanel({ guildId: "guild-1", panelId: "panel-1" }, actor)).ok,
    true,
  );
  const deletionHead = await configurationRevisions.readHead({
    guildId: "guild-1",
    feature: "tickets",
    resourceKey: "panel-1",
  });
  assert.ok(deletionHead);
  assert.equal((await service.savePanel(panel, actor)).ok, true);
  await store.createTicketInstance(createTicket());

  const preview = await service.preparePanelRestore({
    guildId: "guild-1",
    revisionId: deletionHead.id,
    resources: validResources(),
    signingSecret: "restore-secret-01234567890123456789",
  });
  const restored = await service.restorePanelRevision({
    guildId: "guild-1",
    revisionId: deletionHead.id,
    previewToken: preview.previewToken,
    resources: validResources(),
    signingSecret: "restore-secret-01234567890123456789",
    actor,
  });

  assert.deepEqual(restored, {
    ok: false,
    code: "open-tickets",
    message: "Cannot restore deletion while this panel has open tickets.",
  });
  assert.ok(await store.readTicketPanelConfigById("guild-1", "panel-1"));
});

test("Ticket Panel preserves provider failures when a published channel still exists", async () => {
  const panel = { ...createPanel(), panelMessageId: "message-1" };
  const store = createStore([panel]);
  const service = createTicketPanelService({
    store,
    entitlements: freeEntitlements(),
    guildResources: createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [testChannel("panel-channel", 0, "guild-1")], roles: [] },
      },
    }),
    discord: createDiscordAdapter({
      deleteMessage: async () => {
        throw new Error("Discord permission denied");
      },
    }),
  });

  const result = await service.unpublishPanel({ guildId: "guild-1", panelId: "panel-1" });

  assert.deepEqual(result, {
    ok: false,
    code: "provider-failure",
    message: "Discord permission denied",
  });
  assert.equal(
    (await store.readTicketPanelConfigById("guild-1", "panel-1"))?.panelMessageId,
    "message-1",
  );
});

test("Ticket Panel diagnostics rejects any ticket type without a support role", () => {
  const panel = createPanel();
  panel.ticketTypes.push({
    ...panel.ticketTypes[0],
    id: "billing",
    label: "Billing",
    supportRoleId: "",
  });
  const service = createTicketPanelService({
    store: createStore([panel]),
    entitlements: premiumEntitlements(),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
  });

  const result = service.diagnose({
    guildId: "guild-1",
    panel,
    context: {
      guildId: "guild-1",
      botUserId: "bot",
      channels: validResources().channels,
      roles: [
        { id: "guild-1", name: "@everyone", permissions: "8", position: 0 },
        ...validResources().roles,
      ],
      member: { roles: [] },
    },
    isPremiumGuild: true,
    aiSummariesAvailable: true,
  });

  assert.equal(result.checks.find((check) => check.id === "support-roles")?.status, "error");
});

test("Ticket Panel diagnostics requires bot permissions for private staff threads", () => {
  const panel = createPanel();
  panel.ticketTypes[0]!.anonymousSupportEnabled = true;
  const service = createTicketPanelService({
    store: createStore([panel]),
    entitlements: premiumEntitlements(),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
  });
  const requiredWithoutThreads = (1n << 4n) | (1n << 10n) | (1n << 11n) | (1n << 15n);
  const diagnose = (permissions: bigint) =>
    service.diagnose({
      guildId: "guild-1",
      panel,
      context: {
        guildId: "guild-1",
        botUserId: "bot",
        channels: validResources().channels,
        roles: [
          { id: "guild-1", name: "@everyone", permissions: "0", position: 0 },
          { id: "bot-role", name: "HAF Bot", permissions: String(permissions), position: 2 },
          ...validResources().roles,
        ],
        member: { roles: ["bot-role"] },
      },
      isPremiumGuild: true,
      aiSummariesAvailable: true,
    });

  const missing = diagnose(requiredWithoutThreads).checks.find(
    (check) => check.id === "ticket-category",
  );
  assert.equal(missing?.status, "error");
  assert.match(missing?.detail ?? "", /Create Private Threads and Send Messages in Threads/);

  const ready = diagnose(requiredWithoutThreads | (1n << 36n) | (1n << 38n)).checks.find(
    (check) => check.id === "ticket-category",
  );
  assert.equal(ready?.status, "ok");
});

test("Ticket Lifecycle owns effective configuration and creator eligibility", async () => {
  const panel = { ...createPanel(), panelMessageId: "published-panel" };
  panel.ticketTypes[0].allowedCreatorRoleIds = ["vip-role"];
  panel.ticketTypes[0].responseRules = [
    { id: "paid-rule", conditions: [], message: "Premium automation" },
  ];
  const tickets = createStore([panel]);
  const blocklist = {
    readConfig: async () => ({ guilds: {}, botUserId: "bot" }),
    readGuildConfig: async () => ({ guilds: {}, botUserId: "bot" }),
    applyGuildEmojiMutation: async () => ({ guilds: {}, botUserId: "bot" }),
    readGuildNotificationChannel: async () => null,
    upsertGuildNotificationChannel: async () => {},
  };
  const premium = createTicketLifecycle({
    tickets,
    blocklist,
    entitlements: {
      readGuildEntitlement: async (guildId) => ({ guildId, tier: "premium", updatedAtMs: 1 }),
    },
  });
  const free = createTicketLifecycle({
    tickets,
    blocklist,
    entitlements: {
      readGuildEntitlement: async (guildId) => ({ guildId, tier: "free", updatedAtMs: 1 }),
    },
  });

  const denied = await premium.prepareOpen({
    guildId: "guild-1",
    panelId: "panel-1",
    ticketTypeId: "support",
    memberRoleIds: [],
  });
  const allowed = await free.prepareOpen({
    guildId: "guild-1",
    panelId: "panel-1",
    ticketTypeId: "support",
    memberRoleIds: [],
  });

  assert.deepEqual(denied, {
    ok: false,
    code: "permission",
    message: "You do not have access to this ticket type.",
  });
  assert.equal(allowed.ok, true);
  if (allowed.ok) {
    assert.deepEqual(allowed.ticketType.allowedCreatorRoleIds, []);
    assert.deepEqual(allowed.ticketType.responseRules, []);
    assert.equal(allowed.panel.ticketCreationLimit, 1);
  }
});

test("Ticket Lifecycle resolves opening and claiming against the requested non-main panel", async () => {
  const main = {
    ...createPanel(),
    panelId: "main",
    panelName: "Main",
    panelMessageId: "published-main",
    enableTicketClaiming: false,
  };
  const escalation = {
    ...createPanel(),
    panelId: "panel-escalation",
    panelName: "Escalation",
    panelMessageId: "published-escalation",
    enableTicketClaiming: true,
  };
  const store = createStore([main, escalation]);
  const lifecycle = createLifecycle(store);

  const prepared = await lifecycle.prepareOpen({
    guildId: "guild-1",
    panelId: "panel-escalation",
    ticketTypeId: "support",
    memberRoleIds: [],
  });

  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    assert.equal(prepared.panel.panelId, "panel-escalation");
    assert.equal(prepared.ticketType.id, "support");
  }

  await store.createTicketInstance({
    ...createTicket(),
    panelId: "panel-escalation",
  });
  const claim = await lifecycle.claim({
    guildId: "guild-1",
    channelId: "ticket-channel",
    actorUserId: "staff-user",
    actorRoleIds: ["support-role"],
    nowMs: 10,
  });

  assert.equal(claim.ok, true);
  if (claim.ok) assert.equal(claim.claimedByUserId, "staff-user");
});

test("Ticket Lifecycle revalidates configuration inside the open command", async () => {
  const lifecycle = createLifecycle(createStore([]));
  let adaptersCreated = false;

  const result = await lifecycle.open(
    () => {
      adaptersCreated = true;
      throw new Error("must not create adapters");
    },
    {
      guildId: "guild-1",
      panelId: "deleted-panel",
      ticketTypeId: "support",
      openerUserId: "member",
      openerRoleIds: [],
      answers: [],
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "stale-config");
  assert.equal(adaptersCreated, false);
});

test("Ticket Lifecycle persists the opening message for later slash claims", async () => {
  const store = createStore([{ ...createPanel(), panelMessageId: "published-panel" }]);
  const result = await createLifecycle(store).open(
    () => ({
      createChannel: async () => ({ id: "ticket-channel" }),
      deleteChannel: async () => {},
      createOpeningMessage: async () => ({ id: "opening-message" }),
      createAutoReplyMessage: async () => {},
    }),
    {
      guildId: "guild-1",
      panelId: "panel-1",
      ticketTypeId: "support",
      openerUserId: "member",
      openerRoleIds: [],
      answers: [],
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.ticket.openingMessageId, "opening-message");
  assert.equal(
    (await store.readOpenTicketByChannel("guild-1", "ticket-channel"))?.openingMessageId,
    "opening-message",
  );
});

test("Ticket Lifecycle exposes incomplete open rollback through its public interface", async () => {
  const store = createStore([{ ...createPanel(), panelMessageId: "published-panel" }]);
  store.deleteTicketInstance = async () => {
    throw new Error("D1 rollback failed");
  };
  const lifecycle = createLifecycle(store);

  const result = await lifecycle.open(
    () => ({
      createChannel: async () => ({ id: "ticket-channel" }),
      deleteChannel: async () => {
        throw new Error("Discord cleanup failed");
      },
      createOpeningMessage: async () => {
        throw new Error("opening message failed");
      },
      createAutoReplyMessage: async () => {},
    }),
    {
      guildId: "guild-1",
      panelId: "panel-1",
      ticketTypeId: "support",
      openerUserId: "member",
      openerRoleIds: [],
      answers: [],
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "partial-success");
    assert.deepEqual(result.recovery?.failedSteps, ["ticket-record", "ticket-channel"]);
    store.deleteTicketInstance = async () => {};
    const recovered = await lifecycle.resumeOpenCleanup(
      { deleteChannel: async () => {} },
      result.recovery!,
    );
    assert.equal(recovered.ok, true);
  }
});

test("Ticket Lifecycle rolls back a persisted-resource failure through its public interface", async () => {
  const store = createStore([{ ...createPanel(), panelMessageId: "published-panel" }]);
  store.createTicketInstance = async () => {
    throw new Error("D1 unavailable");
  };
  const events: ProductAnalyticsEvent[] = [];
  const lifecycle = createLifecycle(store, {
    report: async (event) => void events.push(event),
  });
  const deleted: string[] = [];

  const result = await lifecycle.open(
    () => ({
      createChannel: async () => ({ id: "ticket-channel" }),
      deleteChannel: async (channelId) => {
        deleted.push(channelId);
      },
      createOpeningMessage: async () => {},
      createAutoReplyMessage: async () => {},
    }),
    {
      guildId: "guild-1",
      panelId: "panel-1",
      ticketTypeId: "support",
      openerUserId: "member",
      openerRoleIds: [],
      answers: [],
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "provider-failure");
  assert.deepEqual(deleted, ["ticket-channel"]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    name: "feature_outcome",
    insertionId: events[0]!.insertionId,
    guildId: "guild-1",
    feature: "tickets",
    action: "ticket_opened",
    status: "failure",
    reasonCode: "storage_unavailable",
  });
});

test("Ticket Lifecycle reports close and transcript archive only after successful completion", async () => {
  const store = createStore([createPanel()]);
  const events: ProductAnalyticsEvent[] = [];
  const lifecycle = createLifecycle(store, {
    report: async (event) => void events.push(event),
  });
  const ticket = createTicket();
  await store.createTicketInstance(ticket);

  const result = await lifecycle.close(
    {
      deleteChannel: async () => {},
      uploadTranscript: async () => ({ id: "transcript-message" }),
      buildTranscriptArtifacts: async () => ({ messages: [], presentation: {} }),
    },
    { ticket, closedByUserId: "staff", closerDisplayName: "Staff" },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    events.map(({ name, ...event }) => ({ name, ...event, insertionId: "omitted" })),
    [
      {
        name: "feature_outcome",
        insertionId: "omitted",
        guildId: "guild-1",
        feature: "tickets",
        action: "ticket_closed",
        status: "success",
      },
      {
        name: "feature_outcome",
        insertionId: "omitted",
        guildId: "guild-1",
        feature: "tickets",
        action: "transcript_archived",
        status: "success",
      },
    ],
  );
});

test("Ticket Lifecycle returns and resumes partial close cleanup", async () => {
  const panel = createPanel();
  const store = createStore([panel]);
  const lifecycle = createLifecycle(store);
  const ticket = {
    guildId: "guild-1",
    channelId: "ticket-channel",
    panelId: "panel-1",
    ticketTypeId: "support",
    ticketTypeLabel: "Support",
    openerUserId: "member",
    supportRoleId: "support-role",
    status: "open" as const,
    answers: [],
    openedAtMs: 1,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
    claimedByUserId: null,
    claimedAtMs: null,
  };
  await store.createTicketInstance(ticket);
  const result = await lifecycle.close(
    {
      deleteChannel: async () => {
        throw new Error("Discord unavailable");
      },
      uploadTranscript: async () => ({ id: "transcript-message" }),
      buildTranscriptArtifacts: async () => ({ messages: [], presentation: {} }),
    },
    { ticket, closedByUserId: "staff", closerDisplayName: "Staff" },
  );

  assert.equal(result.ok, false);
  if (!result.ok && result.recovery) {
    assert.equal(result.code, "partial-success");
    const resumed = await lifecycle.resumeCloseCleanup(
      { deleteChannel: async () => {} },
      result.recovery,
    );
    assert.equal(resumed.ok, true);
  } else {
    assert.fail("expected close recovery state");
  }
});

test("Ticket Lifecycle keeps a ticket open when transcript construction or upload fails", async () => {
  for (const failedStep of ["build", "upload"] as const) {
    const store = createStore([createPanel()]);
    let closeWrites = 0;
    store.closeTicketInstance = async () => {
      closeWrites += 1;
    };
    const lifecycle = createLifecycle(store);
    const result = await lifecycle.close(
      {
        deleteChannel: async () => assert.fail("must not delete an open ticket"),
        uploadTranscript: async () => {
          if (failedStep === "upload") throw new Error("upload unavailable");
          return { id: "transcript-message" };
        },
        buildTranscriptArtifacts: async () => {
          if (failedStep === "build") throw new Error("history unavailable");
          return { messages: [], presentation: {} };
        },
      },
      { ticket: createTicket(), closedByUserId: "staff", closerDisplayName: "Staff" },
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "transcript-failure");
    assert.equal(closeWrites, 0);
  }
});

test("Ticket Lifecycle resumes close persistence without uploading a second transcript", async () => {
  const panel = createPanel();
  const store = createStore([panel]);
  let closeAttempts = 0;
  const normalClose = store.closeTicketInstance;
  store.closeTicketInstance = async (input) => {
    closeAttempts += 1;
    if (closeAttempts === 1) throw new Error("D1 unavailable");
    await normalClose(input);
  };
  const lifecycle = createLifecycle(store);
  const ticket = createTicket();
  await store.createTicketInstance(ticket);
  let uploads = 0;
  const result = await lifecycle.close(
    {
      deleteChannel: async () => {},
      uploadTranscript: async () => {
        uploads += 1;
        return { id: "transcript-message" };
      },
      buildTranscriptArtifacts: async () => ({ messages: [], presentation: {} }),
    },
    { ticket, closedByUserId: "staff", closerDisplayName: "Staff" },
  );

  assert.equal(result.ok, false);
  if (!result.ok && result.recovery) {
    assert.equal(result.recovery.remainingSteps[0], "close-persistence");
    const recovered = await lifecycle.resumeCloseCleanup(
      { deleteChannel: async () => {} },
      result.recovery,
    );
    assert.equal(recovered.ok, true);
  }
  assert.equal(uploads, 1);
});

test("Ticket Lifecycle resumes after staff cleanup without repeating thread deletion", async () => {
  const store = createStore([createPanel()]);
  let cleanupAttempts = 0;
  const normalCleanup = store.cleanupStaffMessages;
  store.cleanupStaffMessages = async (input) => {
    cleanupAttempts += 1;
    if (cleanupAttempts === 1) throw new Error("D1 unavailable");
    await normalCleanup(input);
  };
  const lifecycle = createLifecycle(store);
  const ticket = { ...createTicket(), staffThreadId: "staff-thread" };
  await store.createTicketInstance(ticket);
  let threadDeletes = 0;
  const result = await lifecycle.close(
    {
      deleteChannel: async () => {},
      deleteStaffThread: async () => {
        threadDeletes += 1;
      },
      uploadTranscript: async () => ({ id: "transcript-message" }),
      buildTranscriptArtifacts: async () => ({ messages: [], presentation: {} }),
    },
    { ticket, closedByUserId: "staff", closerDisplayName: "Staff" },
  );

  assert.equal(result.ok, false);
  if (!result.ok && result.recovery) {
    assert.equal(result.recovery.remainingSteps[0], "staff-message-cleanup");
    const recovered = await lifecycle.resumeCloseCleanup(
      {
        deleteChannel: async () => {},
        deleteStaffThread: async () => {
          threadDeletes += 1;
        },
      },
      result.recovery,
    );
    assert.equal(recovered.ok, true);
  }
  assert.equal(threadDeletes, 1);
});

test("Ticket Lifecycle resumes staff-thread persistence at its exact failed phase", async () => {
  const store = createStore([createPanel()]);
  let persistenceAttempts = 0;
  const normalUpdateStaffThread = store.updateTicketInstanceStaffThreadId;
  store.updateTicketInstanceStaffThreadId = async (input) => {
    persistenceAttempts += 1;
    if (persistenceAttempts === 1) throw new Error("D1 unavailable");
    await normalUpdateStaffThread(input);
  };
  const lifecycle = createLifecycle(store);
  const ticket = { ...createTicket(), staffThreadId: "staff-thread" };
  await store.createTicketInstance(ticket);
  let threadDeletes = 0;
  const result = await lifecycle.close(
    {
      deleteChannel: async () => {},
      deleteStaffThread: async () => {
        threadDeletes += 1;
      },
      uploadTranscript: async () => ({ id: "transcript-message" }),
      buildTranscriptArtifacts: async () => ({ messages: [], presentation: {} }),
    },
    {
      ticket,
      closedByUserId: "staff",
      closerDisplayName: "Staff",
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok && result.recovery) {
    assert.equal(result.recovery.remainingSteps[0], "staff-thread-persistence");
    assert.equal(
      (
        await lifecycle.resumeCloseCleanup(
          { deleteChannel: async () => {}, deleteStaffThread: async () => {} },
          result.recovery,
        )
      ).ok,
      true,
    );
  }
  assert.equal(threadDeletes, 1);
});

test("Ticket Lifecycle resumes template completion after Discord delivery", async () => {
  const store = createStore([createPanel()]);
  const ticket = createTicket();
  store.readOpenTicketByChannel = async () => ticket;
  store.claimTicketTemplateReply = async () => true;
  let completionAttempts = 0;
  store.completeTicketTemplateReply = async () => {
    completionAttempts += 1;
    if (completionAttempts === 1) throw new Error("D1 unavailable");
  };
  const template = {
    id: "template-1",
    guildId: "guild-1",
    internalName: "Greeting",
    embeds: [],
    availableForTicketReplies: true,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
  const lifecycle = createTicketLifecycle({
    tickets: store,
    blocklist: {
      readConfig: async () => ({ guilds: {}, botUserId: "bot" }),
      readGuildConfig: async () => ({ guilds: {}, botUserId: "bot" }),
      applyGuildEmojiMutation: async () => ({ guilds: {}, botUserId: "bot" }),
      readGuildNotificationChannel: async () => null,
      upsertGuildNotificationChannel: async () => {},
    },
    entitlements: premiumEntitlements(),
    messageTemplates: {
      readById: async () => template,
      listByGuild: async () => [template],
      listTicketReplyTemplates: async () => [template],
      countByGuild: async () => 1,
      upsert: async () => {},
      delete: async () => {},
    },
  });
  let deliveries = 0;
  const result = await lifecycle.deliverTemplateReply(
    {
      deliver: async () => {
        deliveries += 1;
        return "message-1";
      },
    },
    {
      guildId: "guild-1",
      channelId: "ticket-channel",
      actorRoleIds: ["support-role"],
      isAdmin: false,
      templateId: "template-1",
      templateUpdatedAtMs: 2,
      interactionId: "interaction-1",
      staffUserId: "staff",
      nowMs: 3,
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok && result.recovery) {
    assert.equal(result.code, "partial-success");
    assert.equal((await lifecycle.resumeTemplateReplyCompletion(result.recovery)).ok, true);
  }
  assert.equal(deliveries, 1);
});

test("Ticket Lifecycle durably defers unresolved recovery", async () => {
  const queued: unknown[] = [];
  const lifecycle = createTicketLifecycle({
    tickets: createStore([createPanel()]),
    blocklist: {
      readConfig: async () => ({ guilds: {}, botUserId: "bot" }),
      readGuildConfig: async () => ({ guilds: {}, botUserId: "bot" }),
      applyGuildEmojiMutation: async () => ({ guilds: {}, botUserId: "bot" }),
      readGuildNotificationChannel: async () => null,
      upsertGuildNotificationChannel: async () => {},
    },
    entitlements: premiumEntitlements(),
    recoveryQueue: {
      async send(body) {
        queued.push(body);
      },
    },
  });
  const recovery = {
    kind: "open-cleanup" as const,
    recovery: {
      guildId: "guild-1",
      channelId: "ticket-channel",
      staffThreadId: null,
      failedSteps: ["ticket-channel" as const],
    },
  };

  assert.equal(await lifecycle.deferRecovery(recovery), true);
  assert.deepEqual(queued, [recovery]);
});

test("Ticket Panel save rejects foreign resources before persistence or Discord", async () => {
  const panels: TicketPanelConfig[] = [];
  const store = createStore(panels);
  let auditCalls = 0;
  const service = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    guildResources: createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [
            testChannel("category", 4, "guild-1"),
            testChannel("transcripts", 0, "guild-1"),
          ],
          roles: [testRole("support-role")],
        },
        "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
      },
    }),
    discord: createDiscordAdapter({
      async recordConfigChange() {
        auditCalls += 1;
      },
    }),
  });

  await assert.rejects(
    service.savePanel({ ...createPanel(), panelChannelId: "foreign-text" }),
    GuildResourceValidationError,
  );
  assert.deepEqual(await store.listTicketPanelConfigs("guild-1"), []);
  assert.equal(auditCalls, 0);
});

test("Ticket Panel publish rejects foreign resources before Discord or publication persistence", async () => {
  const panel = { ...createPanel(), panelChannelId: "foreign-text" };
  const store = createStore([panel]);
  let publishCalls = 0;
  const service = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    guildResources: createStaticGuildResourceValidator({
      guilds: {
        "guild-1": {
          channels: [
            testChannel("category", 4, "guild-1"),
            testChannel("transcripts", 0, "guild-1"),
          ],
          roles: [testRole("support-role")],
        },
        "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
      },
    }),
    discord: createDiscordAdapter({
      async publish() {
        publishCalls += 1;
        return "message-foreign";
      },
    }),
  });

  await assert.rejects(
    service.publishPanel({ panel, resources: validResources() }),
    GuildResourceValidationError,
  );
  assert.equal(publishCalls, 0);
  assert.equal((await store.readTicketPanelConfigById("guild-1", "panel-1"))?.panelMessageId, null);
});

test("Ticket Panel test actions validate only the selected resource", async () => {
  const panel = {
    ...createPanel(),
    panelChannelId: "foreign-text",
    transcriptChannelId: "transcripts",
  };
  const service = createTicketPanelService({
    store: createStore([panel]),
    entitlements: premiumEntitlements(),
    guildResources: createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [testChannel("transcripts", 0, "guild-1")], roles: [] },
        "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
      },
    }),
    discord: createDiscordAdapter(),
  });
  let panelPosts = 0;
  let transcripts = 0;
  const adapters = {
    async postPanelMessage() {
      panelPosts += 1;
    },
    async uploadTranscript() {
      transcripts += 1;
    },
    aiSummariesAvailable: true,
    async testAiSummary() {
      return true;
    },
    formatError(error: unknown) {
      return error instanceof Error ? error.message : "failed";
    },
  };

  const transcriptResult = await service.testAction(
    { guildId: "guild-1", panelId: "panel-1", action: "transcript-upload" },
    adapters,
  );
  const panelResult = service.testAction(
    { guildId: "guild-1", panelId: "panel-1", action: "panel-post" },
    adapters,
  );

  assert.equal(transcriptResult.status, "success");
  await assert.rejects(panelResult, GuildResourceValidationError);
  assert.equal(transcripts, 1);
  assert.equal(panelPosts, 0);
});

test("Ticket Panel unpublish treats a persisted channel from another Guild as already absent", async () => {
  const panel = { ...createPanel(), panelChannelId: "foreign-text", panelMessageId: "message-1" };
  const store = createStore([panel]);
  let discordCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    discordCalls += 1;
    return new Response("{}", { status: 204 });
  };
  try {
    const validator = createStaticGuildResourceValidator({
      guilds: {
        "guild-1": { channels: [], roles: [] },
        "guild-2": { channels: [testChannel("foreign-text", 0, "guild-2")], roles: [] },
      },
    });
    const service = createTicketPanelService({
      store,
      entitlements: premiumEntitlements(),
      guildResources: validator,
      discord: createDiscordTicketPanelAdapter({
        discordBotToken: "token",
        auditStore: {} as never,
        guildResources: validator,
      }),
    });

    const result = await service.unpublishPanel({ guildId: "guild-1", panelId: "panel-1" });
    assert.equal(result.ok, true);
    assert.equal(discordCalls, 0);
    assert.equal(
      (await store.readTicketPanelConfigById("guild-1", "panel-1"))?.panelMessageId,
      null,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ticket Lifecycle lets support staff add a Ticket participant without naming the actor", async () => {
  const panel = createPanel();
  panel.ticketTypes[0]!.participantManagementEnabled = true;
  const store = createStore([panel]);
  await store.createTicketInstance(createTicket());
  const lifecycle = createLifecycle(store);
  const granted: string[] = [];
  const messages: string[] = [];

  const result = await lifecycle.addParticipant(
    {
      readAccess: async () => null,
      grantAccess: async (_channelId, userId) => {
        granted.push(userId);
      },
      revokeAccess: async () => {},
      postNeutralMessage: async (_channelId, content) => {
        messages.push(content);
      },
    },
    {
      guildId: "guild-1",
      channelId: "ticket-channel",
      actorUserId: "staff-user",
      actorRoleIds: ["support-role"],
      isAdmin: false,
      targetUserId: "participant-user",
      targetIsGuildMember: true,
      targetIsBot: false,
      nowMs: 10,
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(granted, ["participant-user"]);
  assert.deepEqual(messages, ["An additional participant has been added to this Ticket."]);
  assert.equal(messages[0]?.includes("staff-user"), false);
  assert.equal(
    (await store.readTicketParticipant("guild-1", "ticket-channel", "participant-user"))
      ?.addedByUserId,
    "staff-user",
  );
});

test("Ticket Lifecycle lets a Guild administrator remove an added participant", async () => {
  const panel = createPanel();
  panel.ticketTypes[0]!.participantManagementEnabled = true;
  const store = createStore([panel]);
  const ticket = createTicket();
  await store.createTicketInstance(ticket);
  await store.addTicketParticipant({
    guildId: ticket.guildId,
    ticketChannelId: ticket.channelId,
    ticketTypeId: ticket.ticketTypeId,
    userId: "participant-user",
    addedByUserId: "first-staff",
    addedAtMs: 5,
  });
  const lifecycle = createLifecycle(store);
  const revoked: string[] = [];
  const messages: string[] = [];

  const result = await lifecycle.removeParticipant(
    {
      readAccess: async () => ({
        allow: String((1n << 10n) | (1n << 11n) | (1n << 16n)),
        deny: "0",
      }),
      grantAccess: async () => {},
      revokeAccess: async (_channelId, userId) => {
        revoked.push(userId);
      },
      postNeutralMessage: async (_channelId, content) => {
        messages.push(content);
      },
    },
    {
      guildId: "guild-1",
      channelId: "ticket-channel",
      actorUserId: "admin-user",
      actorRoleIds: [],
      isAdmin: true,
      targetUserId: "participant-user",
      nowMs: 10,
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(revoked, ["participant-user"]);
  assert.deepEqual(messages, ["A participant has been removed from this Ticket."]);
  assert.equal(
    await store.readTicketParticipant("guild-1", "ticket-channel", "participant-user"),
    null,
  );
  assert.equal(
    (await store.listTicketParticipantEvents("guild-1", "ticket-channel")).at(-1)?.actorUserId,
    "admin-user",
  );
});

test("Ticket Lifecycle makes concurrent participant additions share access and notification state", async () => {
  const panel = createPanel();
  panel.ticketTypes[0]!.participantManagementEnabled = true;
  const store = createStore([panel]);
  await store.createTicketInstance(createTicket());
  const lifecycle = createLifecycle(store);
  let grants = 0;
  let revokes = 0;
  let notifications = 0;
  let releaseGrants!: () => void;
  const bothGranted = new Promise<void>((resolve) => {
    releaseGrants = resolve;
  });
  const adapters = {
    readAccess: async () => null,
    grantAccess: async () => {
      grants += 1;
      if (grants === 2) releaseGrants();
      await bothGranted;
    },
    revokeAccess: async () => {
      revokes += 1;
    },
    postNeutralMessage: async () => {
      notifications += 1;
    },
  };
  const command = {
    guildId: "guild-1",
    channelId: "ticket-channel",
    actorUserId: "staff-user",
    actorRoleIds: ["support-role"],
    isAdmin: false,
    targetUserId: "participant-user",
    targetIsGuildMember: true,
    targetIsBot: false,
    nowMs: 10,
  };

  const results = await Promise.all([
    lifecycle.addParticipant(adapters, command),
    lifecycle.addParticipant(adapters, { ...command, actorUserId: "staff-user-2" }),
  ]);

  assert.equal(
    results.every((result) => result.ok),
    true,
  );
  assert.equal(results.filter((result) => result.ok && result.duplicate).length, 1);
  assert.equal(revokes, 0);
  assert.equal(notifications, 1);
  assert.equal((await store.listTicketParticipantEvents("guild-1", "ticket-channel")).length, 1);
});

test("Ticket Lifecycle refuses to replace an existing member permission overwrite", async () => {
  const panel = createPanel();
  panel.ticketTypes[0]!.participantManagementEnabled = true;
  const store = createStore([panel]);
  await store.createTicketInstance(createTicket());
  const lifecycle = createLifecycle(store);
  let grants = 0;

  const result = await lifecycle.addParticipant(
    {
      readAccess: async () => ({ allow: "1024", deny: "2048" }),
      grantAccess: async () => {
        grants += 1;
      },
      revokeAccess: async () => {},
      postNeutralMessage: async () => {},
    },
    {
      guildId: "guild-1",
      channelId: "ticket-channel",
      actorUserId: "staff-user",
      actorRoleIds: ["support-role"],
      isAdmin: false,
      targetUserId: "participant-user",
      targetIsGuildMember: true,
      targetIsBot: false,
      nowMs: 10,
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid-target");
  assert.equal(grants, 0);
});

test("Ticket Lifecycle retries a missing participant notification on duplicate add", async () => {
  const panel = createPanel();
  panel.ticketTypes[0]!.participantManagementEnabled = true;
  const store = createStore([panel]);
  await store.createTicketInstance(createTicket());
  const lifecycle = createLifecycle(store);
  let attempts = 0;
  const adapters = {
    readAccess: async () => null,
    grantAccess: async () => {},
    revokeAccess: async () => {},
    postNeutralMessage: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Discord unavailable");
    },
  };
  const command = {
    guildId: "guild-1",
    channelId: "ticket-channel",
    actorUserId: "staff-user",
    actorRoleIds: ["support-role"],
    isAdmin: false,
    targetUserId: "participant-user",
    targetIsGuildMember: true,
    targetIsBot: false,
    nowMs: 10,
  };

  const first = await lifecycle.addParticipant(adapters, command);
  const retry = await lifecycle.addParticipant(adapters, { ...command, nowMs: 11 });

  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.code, "partial-success");
  assert.equal(retry.ok, true);
  assert.equal(attempts, 2);
  assert.equal(
    (await store.listTicketParticipantEvents("guild-1", "ticket-channel"))[0]?.notificationState,
    "delivered",
  );
});

test("Ticket participant commands recognize the configured HAF admin role", async () => {
  const fixture = createProductionRuntimeStores();
  await fixture.stores.guildRbac.upsertGuildAdminRoleId("guild-1", "haf-admin-role");
  const lifecycle = createTicketLifecycle({
    tickets: fixture.stores.tickets,
    blocklist: fixture.stores.blocklist,
    entitlements: fixture.stores.guildEntitlements,
  });
  let isAdmin = false;
  const injected = {
    ...lifecycle,
    async addParticipant(
      _adapters: Parameters<typeof lifecycle.addParticipant>[0],
      command: Parameters<typeof lifecycle.addParticipant>[1],
    ) {
      isAdmin = command.isAdmin;
      return { ok: false as const, code: "permission" as const, message: "stop" };
    },
  };

  await handleTicketSlashCommandInteraction(
    {
      guild_id: "guild-1",
      channel_id: "ticket-channel",
      member: {
        user: { id: "admin-user" },
        roles: ["haf-admin-role"],
        permissions: "0",
      },
      data: {
        resolved: {
          members: { "participant-user": { roles: [] } },
          users: { "participant-user": { id: "participant-user", bot: false } },
        },
      },
    } as never,
    fixture.stores,
    "token",
    "https://runtime.example",
    "add-user",
    undefined,
    undefined,
    undefined,
    undefined,
    injected,
    "participant-user",
  );

  assert.equal(isAdmin, true);
  fixture.close();
});

function createPanel(): TicketPanelConfig {
  return {
    guildId: "guild-1",
    panelId: "panel-1",
    panelName: "Main panel",
    panelChannelId: "panel-channel",
    categoryChannelId: "category",
    transcriptChannelId: "transcripts",
    panelEmoji: "🎫",
    panelTitle: "Support",
    panelDescription: "Choose a request type.",
    panelFooter: "Private support",
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    aiTranscriptSummariesEnabled: false,
    ticketTypes: [
      {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "support-role",
        channelNamePrefix: "ticket",
        questions: [],
        responseRules: [],
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        ticketHistoryPromptVisibility: "off",
        participantManagementEnabled: false,
        limitExclusion: false,
        mentionSupportRole: false,
      },
    ],
  };
}

function createTicket() {
  return {
    guildId: "guild-1",
    channelId: "ticket-channel",
    panelId: "panel-1",
    ticketTypeId: "support",
    ticketTypeLabel: "Support",
    openerUserId: "member",
    supportRoleId: "support-role",
    status: "open" as const,
    answers: [],
    openedAtMs: 1,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
    claimedByUserId: null,
    claimedAtMs: null,
  };
}

function createDiscordAdapter(
  overrides: Partial<TicketPanelDiscordAdapter> = {},
): TicketPanelDiscordAdapter {
  return {
    publish: async () => "message-1",
    deleteMessage: async () => {},
    recordConfigChange: async () => {},
    ...overrides,
  };
}

function premiumEntitlements() {
  const fixture = createProductionRuntimeStores();
  fixture.database.execRaw(
    "INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ('guild-1', 'premium', 1)",
  );
  return fixture.stores.guildEntitlements;
}

function freeEntitlements() {
  const fixture = createProductionRuntimeStores();
  fixture.database.execRaw(
    "INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ('guild-1', 'free', 1)",
  );
  return fixture.stores.guildEntitlements;
}

function createLifecycle(tickets: TicketStore, productAnalytics?: ProductAnalyticsReporter) {
  const fixture = createProductionRuntimeStores();
  fixture.database.execRaw(
    "INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ('guild-1', 'premium', 1)",
  );
  return createTicketLifecycle({
    tickets,
    blocklist: fixture.stores.blocklist,
    entitlements: fixture.stores.guildEntitlements,
    productAnalytics,
  });
}

function validResources() {
  return {
    channels: [
      { id: "panel-channel", name: "tickets", type: 0, parent_id: null, position: 1 },
      { id: "category", name: "Tickets", type: 4, parent_id: null, position: 0 },
      { id: "transcripts", name: "transcripts", type: 0, parent_id: null, position: 2 },
    ],
    roles: [{ id: "support-role", name: "Support", permissions: "0", position: 1 }],
  };
}

function createStore(panels: TicketPanelConfig[]): TicketStore {
  const fixture = createProductionRuntimeStores();
  ticketFixtures.set(panels, fixture);
  const rawStore = fixture.stores.tickets;
  return afterStoreSeed(
    rawStore,
    Promise.all(panels.map((panel) => rawStore.upsertTicketPanelConfig(panel))),
  );
}

function createTestConfigurationRevisionStore(panels: TicketPanelConfig[]) {
  const fixture = ticketFixtures.get(panels);
  if (!fixture) throw new Error("Create the Ticket store before its revision store.");
  return fixture.stores.configurationRevisions!;
}

test("Ticket Lifecycle rejects an open form after its panel is unpublished", async () => {
  const panel = { ...createPanel(), panelMessageId: "published-panel" };
  const store = createStore([panel]);
  const lifecycle = createLifecycle(store);
  const command = {
    guildId: "guild-1",
    panelId: "panel-1",
    ticketTypeId: "support",
    memberRoleIds: [],
  };
  assert.equal((await lifecycle.prepareOpen(command)).ok, true);
  const panelService = createTicketPanelService({
    store,
    entitlements: premiumEntitlements(),
    guildResources: createPermissiveGuildResourceValidator(),
    discord: createDiscordAdapter(),
  });
  assert.equal(
    (await panelService.unpublishPanel({ guildId: "guild-1", panelId: "panel-1" })).ok,
    true,
  );
  let opened = false;
  const result = await lifecycle.open(
    () => {
      opened = true;
      throw new Error("Unexpected Discord creation");
    },
    {
      guildId: "guild-1",
      panelId: "panel-1",
      ticketTypeId: "support",
      openerUserId: "member",
      openerRoleIds: [],
      answers: [],
    },
  );
  assert.equal(result.ok, false);
  assert.equal(opened, false);
  assert.equal(
    (await store.readTicketPanelConfigById("guild-1", "panel-1"))?.ticketTypes.length,
    1,
  );
});

test("disabled Ticket Types are retained but neither rendered nor accepted", async () => {
  const panel = { ...createPanel(), panelMessageId: "published-panel" };
  panel.ticketTypes[0]!.enabled = false;
  const store = createStore([panel]);
  assert.deepEqual(buildTicketPanelMessage(panel).components, []);
  assert.equal(
    (
      await createLifecycle(store).prepareOpen({
        guildId: "guild-1",
        panelId: "panel-1",
        ticketTypeId: "support",
        memberRoleIds: [],
      })
    ).ok,
    false,
  );
  const retained = await store.readTicketPanelConfigById("guild-1", "panel-1");
  assert.equal(retained?.ticketTypes[0]?.enabled, false);
  retained!.ticketTypes[0]!.enabled = true;
  await store.upsertTicketPanelConfig(retained!);
  assert.equal(
    (
      await createLifecycle(store).prepareOpen({
        guildId: "guild-1",
        panelId: "panel-1",
        ticketTypeId: "support",
        memberRoleIds: [],
      })
    ).ok,
    true,
  );
});
