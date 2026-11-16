/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { TicketService, type CreateTicketChannelConfig } from "../src/services/ticket-service";
import type { TicketInstance, TicketPanelConfig } from "../src/types";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

function panel(anonymousEnabled = false): TicketPanelConfig {
  return {
    guildId: "guild-1",
    panelId: "main",
    panelChannelId: "channel-panel",
    categoryChannelId: "category-1",
    transcriptChannelId: "channel-transcript",
    panelEmoji: null,
    panelTitle: null,
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    ticketTypes: [
      {
        id: "type-1",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        channelNamePrefix: "ticket",
        supportRoleId: "role-support",
        anonymousSupportEnabled: anonymousEnabled,
        staffDiscussionThreadEnabled: anonymousEnabled,
        limitExclusion: false,
        questions: [],
        responseRules: [],
      },
    ],
  };
}

function openTicketInstance(channelId = "channel-123"): TicketInstance {
  return {
    guildId: "guild-1",
    channelId,
    panelId: "main",
    ticketTypeId: "type-1",
    ticketTypeLabel: "Support",
    openerUserId: "user-1",
    supportRoleId: "role-support",
    status: "open",
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

test("TicketService.openTicket creates a channel and persists the caller-visible ticket", async () => {
  const fixture = createProductionRuntimeStores();
  const createdChannels: CreateTicketChannelConfig[] = [];
  const service = new TicketService(
    fixture.stores.blocklist,
    fixture.stores.tickets,
    "bot-token",
    async (config) => {
      createdChannels.push(config);
      return { id: "channel-new", name: config.name };
    },
  );

  try {
    const config = panel();
    const result = await service.openTicket({
      guildId: "guild-1",
      openerUserId: "user-1",
      panel: config,
      ticketType: config.ticketTypes[0],
      answers: [],
    });

    assert.equal(createdChannels[0]?.name, "ticket-001");
    assert.equal(result.channelId, "channel-new");
    const persisted = await fixture.stores.tickets.readOpenTicketByChannel(
      "guild-1",
      "channel-new",
    );
    assert.equal(persisted?.openerUserId, "user-1");
    assert.equal(persisted?.ticketTypeLabel, "Support");
  } finally {
    fixture.close();
  }
});

test("TicketService.openTicket persists the staff thread for an anonymous ticket", async () => {
  const fixture = createProductionRuntimeStores();
  const createdThreads: Array<{ channelId: string; name: string }> = [];
  const service = new TicketService(
    fixture.stores.blocklist,
    fixture.stores.tickets,
    "bot-token",
    async (config) => ({ id: "channel-new", name: config.name }),
    undefined,
    async (channelId, name) => {
      createdThreads.push({ channelId, name });
      return { id: "thread-new" };
    },
  );

  try {
    const config = panel(true);
    const result = await service.openTicket({
      guildId: "guild-1",
      openerUserId: "user-1",
      panel: config,
      ticketType: config.ticketTypes[0],
      answers: [],
    });

    assert.deepEqual(createdThreads, [{ channelId: "channel-new", name: "staff-discussion" }]);
    assert.equal(result.staffThreadId, "thread-new");
    assert.equal(
      (await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "channel-new"))
        ?.staffThreadId,
      "thread-new",
    );
  } finally {
    fixture.close();
  }
});

test("TicketService.closeTicket deletes the Discord channel and closes persisted state", async () => {
  const fixture = createProductionRuntimeStores();
  await fixture.stores.tickets.createTicketInstance(openTicketInstance());
  const deletedChannels: string[] = [];
  const service = new TicketService(
    fixture.stores.blocklist,
    fixture.stores.tickets,
    "bot-token",
    undefined,
    async (channelId) => {
      deletedChannels.push(channelId);
    },
  );

  try {
    await service.closeTicket({ guildId: "guild-1", channelId: "channel-123" });
    assert.deepEqual(deletedChannels, ["channel-123"]);
    assert.equal(
      await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "channel-123"),
      null,
    );
    const closed = await fixture.stores.tickets.listClosedTicketInstances({
      guildId: "guild-1",
      limit: 10,
      beforeOpenedAtMs: null,
    });
    assert.equal(closed.tickets[0]?.channelId, "channel-123");
  } finally {
    fixture.close();
  }
});

test("TicketService.openTicket compensates the Discord channel when persistence fails", async () => {
  const fixture = createProductionRuntimeStores();
  const deletedChannels: string[] = [];
  const failingTickets = new Proxy(fixture.stores.tickets, {
    get(target, property, receiver) {
      if (property === "createTicketInstance") {
        return async () => {
          throw new Error("persistence failed");
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const service = new TicketService(
    fixture.stores.blocklist,
    failingTickets,
    "bot-token",
    async (config) => ({ id: "channel-new", name: config.name }),
    async (channelId) => {
      deletedChannels.push(channelId);
    },
  );

  try {
    const config = panel();
    await assert.rejects(
      service.openTicket({
        guildId: "guild-1",
        openerUserId: "user-1",
        panel: config,
        ticketType: config.ticketTypes[0],
        answers: [],
      }),
      /persistence failed/,
    );
    assert.deepEqual(deletedChannels, ["channel-new"]);
    assert.equal(
      await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "channel-new"),
      null,
    );
  } finally {
    fixture.close();
  }
});

test("TicketService.openTicket leaves persisted state intact after a successful workflow", async () => {
  const fixture = createProductionRuntimeStores();
  const deletedChannels: string[] = [];
  const service = new TicketService(
    fixture.stores.blocklist,
    fixture.stores.tickets,
    "bot-token",
    async (config) => ({ id: "channel-new", name: config.name }),
    async (channelId) => {
      deletedChannels.push(channelId);
    },
  );

  try {
    const config = panel();
    await service.openTicket({
      guildId: "guild-1",
      openerUserId: "user-1",
      panel: config,
      ticketType: config.ticketTypes[0],
      answers: [],
    });
    assert.deepEqual(deletedChannels, []);
    assert.ok(await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "channel-new"));
  } finally {
    fixture.close();
  }
});
