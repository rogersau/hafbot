/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  claimTicket,
  deliverTicketClaim,
  TicketClaimPermissionError,
} from "../src/services/tickets/claim-ticket";
import type { TicketInstance } from "../src/types";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

test("support role holder can claim an unclaimed ticket", async () => {
  const updates: Array<{ claimedByUserId: string | null; claimedAtMs: number | null }> = [];
  const ticket = createTicket({ claimedByUserId: null, claimedAtMs: null });

  const claim = await claimTicket(
    {
      updateTicketClaim: async (body) => {
        updates.push({ claimedByUserId: body.claimedByUserId, claimedAtMs: body.claimedAtMs });
      },
    },
    {
      ticket,
      actorUserId: "staff-1",
      actorRoleIds: ["role-1"],
      nowMs: 123,
    },
  );

  assert.deepEqual(claim, { claimedByUserId: "staff-1", claimedAtMs: 123, alreadyClaimed: false });
  assert.deepEqual(updates, [{ claimedByUserId: "staff-1", claimedAtMs: 123 }]);
});

test("support role holder can transfer a claimed ticket", async () => {
  const updates: Array<{ claimedByUserId: string | null; claimedAtMs: number | null }> = [];
  const ticket = createTicket({ claimedByUserId: "staff-1", claimedAtMs: 100 });

  const claim = await claimTicket(
    {
      updateTicketClaim: async (body) => {
        updates.push({ claimedByUserId: body.claimedByUserId, claimedAtMs: body.claimedAtMs });
      },
    },
    {
      ticket,
      actorUserId: "staff-2",
      actorRoleIds: ["role-1"],
      nowMs: 200,
    },
  );

  assert.deepEqual(claim, { claimedByUserId: "staff-2", claimedAtMs: 200, alreadyClaimed: false });
  assert.deepEqual(updates, [{ claimedByUserId: "staff-2", claimedAtMs: 200 }]);
});

test("user without support role cannot claim", async () => {
  await assert.rejects(
    claimTicket(
      {
        updateTicketClaim: async () => {
          throw new Error("should not update");
        },
      },
      {
        ticket: createTicket(),
        actorUserId: "user-2",
        actorRoleIds: [],
        nowMs: 123,
      },
    ),
    TicketClaimPermissionError,
  );
});

test("claim refresh bounds repeated ownership changes and a retry completes delivery once", async () => {
  const fixture = createProductionRuntimeStores();
  const ticket = createTicket({ claimedByUserId: "staff-1", claimedAtMs: 1 });
  const projected: Array<number | null | undefined> = [];
  const notifications: string[] = [];
  let churn = true;
  const adapters = {
    refreshOpeningMessage: async (current: TicketInstance) => {
      projected.push(current.claimedAtMs);
      if (churn) {
        // Two transfers can restore the same owner while advancing the claim revision.
        await fixture.stores.tickets.updateTicketClaim({
          guildId: ticket.guildId,
          channelId: ticket.channelId,
          claimedByUserId: "staff-1",
          claimedAtMs: current.claimedAtMs! + 1,
        });
      }
    },
    announce: async () => {
      notifications.push("announcement");
    },
    audit: async () => {
      notifications.push("audit");
    },
  };
  try {
    await fixture.stores.tickets.createTicketInstance(ticket);
    await assert.rejects(
      deliverTicketClaim(fixture.stores.tickets, adapters, {
        ticket,
        claimedByUserId: "staff-1",
        claimedAtMs: 1,
      }),
      /ownership kept changing/,
    );
    assert.deepEqual(projected, [1, 2, 3]);
    assert.deepEqual(notifications, []);
    churn = false;
    const retry = { ticket, claimedByUserId: "staff-1", claimedAtMs: 4 };
    await deliverTicketClaim(fixture.stores.tickets, adapters, retry);
    await deliverTicketClaim(fixture.stores.tickets, adapters, retry);
    assert.deepEqual(projected, [1, 2, 3, 4, 4]);
    assert.deepEqual(notifications, ["announcement", "audit"]);
    assert.equal(
      (await fixture.stores.tickets.readOpenTicketByChannel(ticket.guildId, ticket.channelId))
        ?.claimedAtMs,
      4,
    );
  } finally {
    fixture.close();
  }
});

test("claim refresh readback failures remain retryable before notification delivery", async () => {
  const fixture = createProductionRuntimeStores();
  const ticket = createTicket({ claimedByUserId: "staff-1", claimedAtMs: 1 });
  const read = fixture.stores.tickets.readOpenTicketByChannel.bind(fixture.stores.tickets);
  let reads = 0;
  let refreshes = 0;
  const notifications: string[] = [];
  fixture.stores.tickets.readOpenTicketByChannel = async (...args) => {
    reads += 1;
    if (reads === 2) throw new Error("Fictional readback failure after PATCH");
    return read(...args);
  };
  const adapters = {
    refreshOpeningMessage: async () => {
      refreshes += 1;
    },
    announce: async () => {
      notifications.push("announcement");
    },
    audit: async () => {
      notifications.push("audit");
    },
  };
  const claim = { ticket, claimedByUserId: "staff-1", claimedAtMs: 1 };
  try {
    await fixture.stores.tickets.createTicketInstance(ticket);
    await assert.rejects(
      deliverTicketClaim(fixture.stores.tickets, adapters, claim),
      /readback failure/,
    );
    assert.deepEqual(notifications, []);
    await deliverTicketClaim(fixture.stores.tickets, adapters, claim);
    await deliverTicketClaim(fixture.stores.tickets, adapters, claim);
    assert.equal(refreshes, 3);
    assert.deepEqual(notifications, ["announcement", "audit"]);
  } finally {
    fixture.close();
  }
});

test("claim refresh stops projecting a ticket that closes during the PATCH", async () => {
  const fixture = createProductionRuntimeStores();
  const ticket = createTicket({ claimedByUserId: "staff-1", claimedAtMs: 1 });
  let refreshes = 0;
  try {
    await fixture.stores.tickets.createTicketInstance(ticket);
    const adapters = {
      refreshOpeningMessage: async () => {
        refreshes += 1;
        await fixture.stores.tickets.closeTicketInstance({
          guildId: ticket.guildId,
          channelId: ticket.channelId,
          closedByUserId: "staff-1",
          closedAtMs: 2,
          transcriptMessageId: null,
        });
      },
      announce: async () => {},
      audit: async () => {},
    };
    const claim = { ticket, claimedByUserId: "staff-1", claimedAtMs: 1 };
    await deliverTicketClaim(fixture.stores.tickets, adapters, claim);
    await deliverTicketClaim(fixture.stores.tickets, adapters, claim);
    assert.equal(refreshes, 1);
  } finally {
    fixture.close();
  }
});

function createTicket(overrides: Partial<TicketInstance> = {}): TicketInstance {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    ticketTypeId: "support",
    ticketTypeLabel: "Support",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
    claimedByUserId: null,
    claimedAtMs: null,
    ...overrides,
  };
}
