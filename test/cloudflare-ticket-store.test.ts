/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createSqliteTicketStore } from "./support/sqlite/runtime/sqlite-ticket-store";
import type { TicketInstance, TicketPanelConfig } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("ticket panel config can be upserted, read, and replaced", async () => {
  const store = createStore();

  assert.equal(await store.readTicketPanelConfig("guild-1"), null);

  const panel = createPanel();
  await store.upsertTicketPanelConfig(panel);
  assert.deepEqual(await store.readTicketPanelConfig("guild-1"), panel);

  const updatedPanel: TicketPanelConfig = {
    ...panel,
    panelChannelId: "panel-updated",
    panelEmoji: "ticket",
    panelTitle: "Open a ticket",
    panelDescription: "Pick a type",
    panelFooter: "Support footer",
    panelMessageId: "message-1",
    ticketCreationLimit: 3,
    ticketLimitRejectionMessage: "Too many tickets",
    enableTicketClaiming: true,
  };
  await store.upsertTicketPanelConfig(updatedPanel);

  assert.deepEqual(await store.readTicketPanelConfig("guild-1"), updatedPanel);
});

test("ticket panel config defaults aiTranscriptSummariesEnabled to false", async () => {
  const store = createStore();
  const panel = createPanel();

  assert.equal(panel.aiTranscriptSummariesEnabled, false);
  await store.upsertTicketPanelConfig(panel);

  const read = await store.readTicketPanelConfig("guild-1");
  assert.equal(read?.aiTranscriptSummariesEnabled, false);
});

test("legacy ticket panel rows are normalized into responseRules on read", async () => {
  const store = createStore();
  const panel = createPanel();
  const { responseRules: _unused, ...legacyTicketType } = panel.ticketTypes[0]!;

  await store.upsertTicketPanelConfig({
    ...panel,
    ticketTypes: [
      {
        ...legacyTicketType,
        responseRules: [{ id: "welcome", conditions: [], message: "Please link Steam first." }],
      },
    ],
  });

  const stored = await store.readTicketPanelConfig("guild-1");
  assert.deepEqual(stored?.ticketTypes[0]?.responseRules, [
    {
      id: "welcome",
      conditions: [],
      message: "Please link Steam first.",
    },
  ]);
});

test("multiple ticket panels can be listed and read independently", async () => {
  const store = createStore();
  const mainPanel = createPanel();
  const escalationPanel: TicketPanelConfig = {
    ...createPanel(),
    panelId: "panel-escalation",
    panelName: "Escalation",
    panelChannelId: "panel-escalation-channel",
    categoryChannelId: "category-escalation",
    transcriptChannelId: "transcripts-escalation",
    panelMessageId: null,
    ticketTypes: [
      {
        ...createPanel().ticketTypes[0]!,
        id: "support",
        label: "Escalation",
      },
    ],
  };

  await store.upsertTicketPanelConfig(mainPanel);
  await store.upsertTicketPanelConfig(escalationPanel);

  assert.deepEqual(await store.listTicketPanelConfigs?.("guild-1"), [mainPanel, escalationPanel]);
  assert.deepEqual(
    await store.readTicketPanelConfigById?.("guild-1", "panel-escalation"),
    escalationPanel,
  );
  assert.deepEqual(await store.readTicketPanelConfig("guild-1"), mainPanel);
});

test("closed tickets can be listed for one panel while open ticket limits stay guild-wide", async () => {
  const store = createStore();
  await store.upsertTicketPanelConfig(createPanel());
  await store.upsertTicketPanelConfig({
    ...createPanel(),
    panelId: "staff",
    panelName: "Staff panel",
  });
  await store.createTicketInstance(
    createTicket("guild-1", "main-open", "open", 300, null, "support", "main"),
  );
  await store.createTicketInstance(
    createTicket("guild-1", "main-closed", "closed", 200, null, "support", "main"),
  );
  await store.createTicketInstance(
    createTicket("guild-1", "staff-open", "open", 250, null, "support", "staff"),
  );
  await store.createTicketInstance(
    createTicket("guild-1", "staff-closed", "closed", 100, null, "support", "staff"),
  );

  const staffTickets = await store.listClosedTicketInstances({
    guildId: "guild-1",
    panelId: "staff",
    limit: 20,
    beforeOpenedAtMs: null,
  });

  assert.deepEqual(
    staffTickets.tickets.map((ticket) => ticket.channelId),
    ["staff-closed"],
  );
  assert.equal(staffTickets.total, 1);
  assert.equal(await store.countOpenTicketsByUser("guild-1", "user-1"), 2);
});

test("ticket panel deletion is blocked while the panel has open tickets", async () => {
  const store = createStore();
  assert.ok(store.countOpenTicketsForPanel);
  assert.ok(store.deleteTicketPanelConfig);
  const countOpenTicketsForPanel = store.countOpenTicketsForPanel;
  const deleteTicketPanelConfig = store.deleteTicketPanelConfig;
  await store.upsertTicketPanelConfig(createPanel());
  await store.createTicketInstance(createTicket("guild-1", "open-channel", "open", 100));

  assert.equal(await countOpenTicketsForPanel("guild-1", "main"), 1);
  await assert.rejects(() => deleteTicketPanelConfig("guild-1", "main"), /open tickets/);

  await store.closeTicketInstance({
    guildId: "guild-1",
    channelId: "open-channel",
    closedByUserId: "staff-1",
    closedAtMs: 200,
    transcriptMessageId: null,
  });
  await deleteTicketPanelConfig("guild-1", "main");

  assert.equal(await store.readTicketPanelConfigById?.("guild-1", "main"), null);
});

test("updateTicketInstanceStaffThreadId updates staff_thread_id for a ticket", async () => {
  const store = createStore();
  await store.createTicketInstance(createTicket("guild-1", "channel-1", "open", 100));

  await store.updateTicketInstanceStaffThreadId({
    guildId: "guild-1",
    channelId: "channel-1",
    staffThreadId: "thread-1",
  });

  const ticket = await store.readOpenTicketByChannel("guild-1", "channel-1");
  assert.equal(ticket?.staffThreadId, "thread-1");

  await store.updateTicketInstanceStaffThreadId({
    guildId: "guild-1",
    channelId: "channel-1",
    staffThreadId: null,
  });

  const ticketAfterClear = await store.readOpenTicketByChannel("guild-1", "channel-1");
  assert.equal(ticketAfterClear?.staffThreadId, null);
});

test("readOpenTicketByStaffThread finds open ticket by staff thread id", async () => {
  const store = createStore();
  await store.createTicketInstance(createTicket("guild-1", "channel-1", "open", 100, "thread-1"));
  await store.createTicketInstance(createTicket("guild-1", "channel-2", "closed", 200, "thread-2"));

  const ticket = await store.readOpenTicketByStaffThread("guild-1", "thread-1");
  const closedTicket = await store.readOpenTicketByStaffThread("guild-1", "thread-2");

  assert.equal(ticket?.channelId, "channel-1");
  assert.equal(closedTicket, null);
});

test("recordStaffMessageMapping and readStaffMessageMapping round-trip", async () => {
  const store = createStore();

  await store.recordStaffMessageMapping({
    guildId: "guild-1",
    ticketChannelId: "channel-1",
    staffThreadId: "thread-1",
    staffMessageId: "staff-msg-1",
    botMessageId: "bot-msg-1",
    staffUserId: "staff-1",
    staffDisplayName: "Staff One",
    content: "Hello",
    createdAtMs: 1_700_000_000_000,
  });

  const mapping = await store.readStaffMessageMapping({
    guildId: "guild-1",
    ticketChannelId: "channel-1",
    botMessageId: "bot-msg-1",
  });

  assert.deepEqual(mapping, { staffUserId: "staff-1", staffDisplayName: "Staff One" });

  const staffMapping = await store.readStaffMessageMappingByStaffMessage({
    guildId: "guild-1",
    staffThreadId: "thread-1",
    staffMessageId: "staff-msg-1",
  });
  assert.deepEqual(staffMapping, {
    ticketChannelId: "channel-1",
    botMessageId: "bot-msg-1",
    staffUserId: "staff-1",
    staffDisplayName: "Staff One",
    content: "Hello",
  });
});

test("staff message delivery claims are atomic and become readable only after completion", async () => {
  const store = createStore();
  const claim = {
    guildId: "guild-1",
    ticketChannelId: "channel-1",
    staffThreadId: "thread-1",
    staffMessageId: "staff-msg-claim",
    staffUserId: "staff-1",
    staffDisplayName: "Staff One",
    content: "Hello",
    createdAtMs: 1_700_000_000_000,
  };

  const results = await Promise.all([
    store.claimStaffMessageDelivery(claim),
    store.claimStaffMessageDelivery(claim),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(
    await store.readStaffMessageMappingByStaffMessage({
      guildId: claim.guildId,
      staffThreadId: claim.staffThreadId,
      staffMessageId: claim.staffMessageId,
    }),
    null,
  );

  await store.completeStaffMessageDelivery({
    guildId: claim.guildId,
    staffThreadId: claim.staffThreadId,
    staffMessageId: claim.staffMessageId,
    botMessageId: "bot-msg-claim",
    claimedAtMs: claim.createdAtMs,
  });

  assert.deepEqual(
    await store.readStaffMessageMappingByStaffMessage({
      guildId: claim.guildId,
      staffThreadId: claim.staffThreadId,
      staffMessageId: claim.staffMessageId,
    }),
    {
      ticketChannelId: "channel-1",
      botMessageId: "bot-msg-claim",
      staffUserId: "staff-1",
      staffDisplayName: "Staff One",
      content: "Hello",
    },
  );
  assert.equal(await store.claimStaffMessageDelivery(claim), false);
});

test("released staff message delivery claims can be retried", async () => {
  const store = createStore();
  const claim = {
    guildId: "guild-1",
    ticketChannelId: "channel-1",
    staffThreadId: "thread-1",
    staffMessageId: "staff-msg-retry",
    staffUserId: "staff-1",
    staffDisplayName: "Staff One",
    content: "Retry me",
    createdAtMs: 1_700_000_000_000,
  };

  assert.equal(await store.claimStaffMessageDelivery(claim), true);
  await store.releaseStaffMessageDelivery({
    guildId: claim.guildId,
    staffThreadId: claim.staffThreadId,
    staffMessageId: claim.staffMessageId,
    claimedAtMs: claim.createdAtMs,
  });
  assert.equal(await store.claimStaffMessageDelivery(claim), true);
});

test("abandoned staff message delivery claims can be reclaimed after the lease", async () => {
  const store = createStore();
  const claim = {
    guildId: "guild-1",
    ticketChannelId: "channel-1",
    staffThreadId: "thread-1",
    staffMessageId: "staff-msg-abandoned",
    staffUserId: "staff-1",
    staffDisplayName: "Staff One",
    content: "Resume me",
    createdAtMs: 1_700_000_000_000,
  };

  assert.equal(await store.claimStaffMessageDelivery(claim), true);
  assert.equal(
    await store.claimStaffMessageDelivery({ ...claim, createdAtMs: claim.createdAtMs + 119_999 }),
    false,
  );
  assert.equal(
    await store.claimStaffMessageDelivery({ ...claim, createdAtMs: claim.createdAtMs + 120_000 }),
    true,
  );

  await store.releaseStaffMessageDelivery({
    guildId: claim.guildId,
    staffThreadId: claim.staffThreadId,
    staffMessageId: claim.staffMessageId,
    claimedAtMs: claim.createdAtMs,
  });
  await store.completeStaffMessageDelivery({
    guildId: claim.guildId,
    staffThreadId: claim.staffThreadId,
    staffMessageId: claim.staffMessageId,
    botMessageId: "bot-msg-reclaimed",
    claimedAtMs: claim.createdAtMs + 120_000,
  });
  assert.equal(
    (
      await store.readStaffMessageMappingByStaffMessage({
        guildId: claim.guildId,
        staffThreadId: claim.staffThreadId,
        staffMessageId: claim.staffMessageId,
      })
    )?.botMessageId,
    "bot-msg-reclaimed",
  );
});

test("updateStaffMessageMapping updates content and display name", async () => {
  const store = createStore();
  await store.recordStaffMessageMapping({
    guildId: "guild-1",
    ticketChannelId: "channel-1",
    staffThreadId: "thread-1",
    staffMessageId: "staff-msg-1",
    botMessageId: "bot-msg-1",
    staffUserId: "staff-1",
    staffDisplayName: "Old Name",
    content: "Old content",
    createdAtMs: 1_700_000_000_000,
  });

  await store.updateStaffMessageMapping({
    guildId: "guild-1",
    staffThreadId: "thread-1",
    staffMessageId: "staff-msg-1",
    staffDisplayName: "New Name",
    content: "New content",
  });

  const mapping = await store.readStaffMessageMappingByStaffMessage({
    guildId: "guild-1",
    staffThreadId: "thread-1",
    staffMessageId: "staff-msg-1",
  });
  assert.equal(mapping?.staffDisplayName, "New Name");
  assert.equal(mapping?.content, "New content");
});

test("deleteStaffMessageMapping removes mapping by staff message", async () => {
  const store = createStore();
  await store.recordStaffMessageMapping({
    guildId: "guild-1",
    ticketChannelId: "channel-1",
    staffThreadId: "thread-1",
    staffMessageId: "staff-msg-1",
    botMessageId: "bot-msg-1",
    staffUserId: "staff-1",
    staffDisplayName: "Staff One",
    content: "Hello",
    createdAtMs: 1_700_000_000_000,
  });

  await store.deleteStaffMessageMapping({
    guildId: "guild-1",
    staffThreadId: "thread-1",
    staffMessageId: "staff-msg-1",
  });

  const mapping = await store.readStaffMessageMappingByStaffMessage({
    guildId: "guild-1",
    staffThreadId: "thread-1",
    staffMessageId: "staff-msg-1",
  });
  assert.equal(mapping, null);
});

test("readStaffMessageMapping returns null for unknown message", async () => {
  const store = createStore();

  const mapping = await store.readStaffMessageMapping({
    guildId: "guild-1",
    ticketChannelId: "channel-1",
    botMessageId: "unknown-msg",
  });

  assert.equal(mapping, null);
});

test("cleanupStaffMessages removes all messages for a ticket channel", async () => {
  const store = createStore();

  await store.recordStaffMessageMapping(
    createStaffMessage(
      "guild-1",
      "channel-1",
      "thread-1",
      "staff-msg-1",
      "bot-msg-1",
      "staff-1",
      "Staff One",
      "Hello",
      1_700_000_000_000,
    ),
  );
  await store.recordStaffMessageMapping(
    createStaffMessage(
      "guild-1",
      "channel-1",
      "thread-1",
      "staff-msg-2",
      "bot-msg-2",
      "staff-2",
      "Staff Two",
      "World",
      1_700_000_000_001,
    ),
  );
  await store.recordStaffMessageMapping(
    createStaffMessage(
      "guild-1",
      "channel-2",
      "thread-2",
      "staff-msg-3",
      "bot-msg-3",
      "staff-3",
      "Staff Three",
      "Other",
      1_700_000_000_002,
    ),
  );

  await store.cleanupStaffMessages({ guildId: "guild-1", ticketChannelId: "channel-1" });

  const mapping1 = await store.readStaffMessageMapping({
    guildId: "guild-1",
    ticketChannelId: "channel-1",
    botMessageId: "bot-msg-1",
  });
  const mapping2 = await store.readStaffMessageMapping({
    guildId: "guild-1",
    ticketChannelId: "channel-1",
    botMessageId: "bot-msg-2",
  });
  const mapping3 = await store.readStaffMessageMapping({
    guildId: "guild-1",
    ticketChannelId: "channel-2",
    botMessageId: "bot-msg-3",
  });

  assert.equal(mapping1, null);
  assert.equal(mapping2, null);
  assert.deepEqual(mapping3, { staffUserId: "staff-3", staffDisplayName: "Staff Three" });
});

test("createSqliteTicketStore lists closed tickets by guild with cursor pagination", async () => {
  const store = createStore();
  await store.createTicketInstance(createTicket("guild-1", "closed-older", "closed", 100));
  await store.createTicketInstance(createTicket("guild-1", "open-ticket", "open", 400));
  await store.createTicketInstance(createTicket("guild-2", "other-guild", "closed", 500));
  await store.createTicketInstance(createTicket("guild-1", "closed-newest", "closed", 300));
  await store.createTicketInstance(createTicket("guild-1", "closed-middle", "closed", 200));

  const firstPage = await store.listClosedTicketInstances({
    guildId: "guild-1",
    limit: 2,
    beforeOpenedAtMs: null,
  });
  const secondPage = await store.listClosedTicketInstances({
    guildId: "guild-1",
    limit: 2,
    beforeOpenedAtMs: firstPage.nextCursor,
  });

  assert.deepEqual(
    firstPage.tickets.map((ticket) => ticket.channelId),
    ["closed-newest", "closed-middle"],
  );
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.nextCursor, 200);
  assert.deepEqual(
    secondPage.tickets.map((ticket) => ticket.channelId),
    ["closed-older"],
  );
  assert.equal(secondPage.total, 3);
  assert.equal(secondPage.nextCursor, null);
});

test("ticket history lists a member's open and closed tickets across panels newest first", async () => {
  const store = createStore();
  assert.ok(store.listMemberTicketHistory);

  await store.createTicketInstance(
    createTicket("guild-1", "current", "open", 500, null, "support", "main"),
  );
  await store.createTicketInstance(
    createTicket("guild-1", "staff-open", "open", 400, null, "appeal", "staff"),
  );
  await store.createTicketInstance(
    createTicket("guild-1", "main-closed", "closed", 300, null, "support", "main"),
  );
  await store.createTicketInstance({
    ...createTicket("guild-1", "other-member", "closed", 450, null, "support", "main"),
    openerUserId: "user-2",
  });
  await store.createTicketInstance(
    createTicket("guild-2", "other-guild", "closed", 600, null, "support", "main"),
  );

  const firstPage = await store.listMemberTicketHistory!({
    guildId: "guild-1",
    openerUserId: "user-1",
    excludeChannelId: "current",
    limit: 1,
    beforeOpenedAtMs: null,
  });
  const secondPage = await store.listMemberTicketHistory!({
    guildId: "guild-1",
    openerUserId: "user-1",
    excludeChannelId: "current",
    limit: 1,
    beforeOpenedAtMs: firstPage.nextCursor,
  });

  assert.deepEqual(
    firstPage.tickets.map((ticket) => ticket.channelId),
    ["staff-open"],
  );
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.nextCursor, 400);
  assert.deepEqual(
    secondPage.tickets.map((ticket) => ticket.channelId),
    ["main-closed"],
  );
  assert.equal(secondPage.nextCursor, null);
});

test("countOpenTicketsByUser excludes open tickets for limit-excluded ticket types", async () => {
  const store = createStore();
  await store.upsertTicketPanelConfig(createPanel());
  await store.createTicketInstance(
    createTicket("guild-1", "support-1", "open", 100, null, "support"),
  );
  await store.createTicketInstance(
    createTicket("guild-1", "appeal-1", "open", 200, null, "appeal"),
  );
  await store.createTicketInstance(
    createTicket("guild-1", "closed-1", "closed", 300, null, "support"),
  );
  await store.createTicketInstance(
    createTicket("guild-2", "other-1", "open", 400, null, "support"),
  );

  const count = await store.countOpenTicketsByUser("guild-1", "user-1");

  assert.equal(count, 1);
});

test("Ticket claim delivery leases fence stale retries and preserve completed phases", async () => {
  const { verifyTicketClaimDelivery } = await import("./helpers/ticket-claim-delivery");
  await verifyTicketClaimDelivery(createStore());
});

test("updateTicketClaim persists and clears claim state", async () => {
  const store = createStore();
  await store.createTicketInstance(createTicket("guild-1", "channel-1", "open", 100));

  await store.updateTicketClaim({
    guildId: "guild-1",
    channelId: "channel-1",
    claimedByUserId: "staff-1",
    claimedAtMs: 123,
  });
  const claimedTicket = await store.readOpenTicketByChannel("guild-1", "channel-1");
  assert.equal(claimedTicket?.claimedByUserId, "staff-1");
  assert.equal(claimedTicket?.claimedAtMs, 123);

  await store.updateTicketClaim({
    guildId: "guild-1",
    channelId: "channel-1",
    claimedByUserId: null,
    claimedAtMs: null,
  });
  const unclaimedTicket = await store.readOpenTicketByChannel("guild-1", "channel-1");
  assert.equal(unclaimedTicket?.claimedByUserId, null);
  assert.equal(unclaimedTicket?.claimedAtMs, null);
});

test("create, read, close, and delete Ticket Instance preserves observable state", async () => {
  const store = createStore();
  const ticket = createTicket("guild-1", "channel-1", "open", 100, null, "support");

  await store.createTicketInstance(ticket);
  assert.deepEqual(await store.readOpenTicketByChannel("guild-1", "channel-1"), {
    ...ticket,
    openingMessageId: null,
  });

  await store.closeTicketInstance({
    guildId: "guild-1",
    channelId: "channel-1",
    closedByUserId: "staff-2",
    closedAtMs: 200,
    transcriptMessageId: "transcript-2",
  });
  assert.equal(await store.readOpenTicketByChannel("guild-1", "channel-1"), null);

  const closedTickets = await store.listClosedTicketInstances({
    guildId: "guild-1",
    limit: 10,
    beforeOpenedAtMs: null,
  });
  assert.equal(closedTickets.tickets[0]?.status, "closed");
  assert.equal(closedTickets.tickets[0]?.closedByUserId, "staff-2");
  assert.equal(closedTickets.tickets[0]?.closedAtMs, 200);
  assert.equal(closedTickets.tickets[0]?.transcriptMessageId, "transcript-2");

  await store.deleteTicketInstance({ guildId: "guild-1", channelId: "channel-1" });
  const afterDelete = await store.listClosedTicketInstances({
    guildId: "guild-1",
    limit: 10,
    beforeOpenedAtMs: null,
  });
  assert.deepEqual(afterDelete.tickets, []);
});

test("reserveNextTicketNumber increments independently per guild", async () => {
  const store = createStore();

  assert.equal(await store.reserveNextTicketNumber("guild-1"), 1);
  assert.equal(await store.reserveNextTicketNumber("guild-1"), 2);
  assert.equal(await store.reserveNextTicketNumber("guild-2"), 1);
  assert.equal(await store.reserveNextTicketNumber("guild-1"), 3);
});

test("stale participant notification workers cannot mutate a replacement lease", async () => {
  const store = createStore();
  const participant = await store.addTicketParticipant({
    guildId: "guild-1",
    ticketChannelId: "channel-1",
    ticketTypeId: "support",
    userId: "participant-1",
    addedByUserId: "staff-1",
    addedAtMs: 1,
  });
  const firstClaimAtMs = 1_000;
  const replacementClaimAtMs = firstClaimAtMs + 2 * 60 * 1000 + 1;

  assert.equal(
    await store.claimTicketParticipantNotification(participant.eventId, firstClaimAtMs),
    true,
  );
  assert.equal(
    await store.claimTicketParticipantNotification(participant.eventId, replacementClaimAtMs),
    true,
  );
  await store.releaseTicketParticipantNotification(participant.eventId, firstClaimAtMs);
  assert.equal(
    await store.claimTicketParticipantNotification(participant.eventId, replacementClaimAtMs + 1),
    false,
  );
  await store.completeTicketParticipantNotification(participant.eventId, firstClaimAtMs);
  assert.equal(
    (await store.listTicketParticipantEvents("guild-1", "channel-1"))[0]?.notificationState,
    "delivering",
  );
  await store.completeTicketParticipantNotification(participant.eventId, replacementClaimAtMs);
  assert.equal(
    (await store.listTicketParticipantEvents("guild-1", "channel-1"))[0]?.notificationState,
    "delivered",
  );
});

function createStore() {
  const database = new SqliteD1Database();
  return createSqliteTicketStore(database as unknown as D1Database);
}

function createPanel(): TicketPanelConfig {
  return {
    guildId: "guild-1",
    panelId: "main",
    panelName: "Main panel",
    panelChannelId: "panel",
    categoryChannelId: "category",
    transcriptChannelId: "transcripts",
    panelEmoji: null,
    panelTitle: null,
    panelDescription: null,
    panelFooter: null,
    panelColor: 0x57f287,
    panelMessageId: null,
    ticketCreationLimit: 2,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    aiTranscriptSummariesEnabled: false,
    ticketTypes: [
      {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        allowedCreatorRoleIds: [],
        channelNamePrefix: "support",
        responseRules: [],
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        ticketHistoryPromptVisibility: "off",
        limitExclusion: false,
        mentionSupportRole: false,
        participantManagementEnabled: false,
        questions: [],
      },
      {
        id: "appeal",
        label: "Appeal",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        allowedCreatorRoleIds: [],
        channelNamePrefix: "appeal",
        responseRules: [],
        anonymousSupportEnabled: false,
        staffDiscussionThreadEnabled: false,
        ticketHistoryPromptVisibility: "off",
        limitExclusion: true,
        mentionSupportRole: false,
        participantManagementEnabled: false,
        questions: [],
      },
    ],
  };
}

function createTicket(
  guildId: string,
  channelId: string,
  status: TicketInstance["status"],
  openedAtMs: number,
  staffThreadId: string | null = null,
  ticketTypeId = "appeals",
  panelId = "main",
): TicketInstance {
  return {
    guildId,
    channelId,
    panelId,
    ticketTypeId,
    ticketTypeLabel: ticketTypeId === "appeal" ? "Appeal" : "Support",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status,
    answers: [],
    openedAtMs,
    closedAtMs: status === "closed" ? openedAtMs + 10 : null,
    closedByUserId: status === "closed" ? "staff-1" : null,
    transcriptMessageId: status === "closed" ? "transcript-1" : null,
    staffThreadId,
    claimedByUserId: null,
    claimedAtMs: null,
  };
}

function createStaffMessage(
  guildId: string,
  ticketChannelId: string,
  staffThreadId: string,
  staffMessageId: string,
  botMessageId: string,
  staffUserId: string,
  staffDisplayName: string,
  content: string,
  createdAtMs: number,
) {
  return {
    guildId,
    ticketChannelId,
    staffThreadId,
    staffMessageId,
    botMessageId,
    staffUserId,
    staffDisplayName,
    content,
    createdAtMs,
  };
}
