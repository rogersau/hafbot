import assert from "node:assert/strict";
import type { TicketStore } from "../../src/runtime/contracts/ticket-store";

export async function verifyTicketClaimDelivery(store: TicketStore) {
  await store.createTicketInstance({
    guildId: "claim-guild",
    channelId: "claim-channel",
    ticketTypeId: "support",
    ticketTypeLabel: "Support",
    openerUserId: "member-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
  });
  await store.updateTicketOpeningMessageId({
    guildId: "claim-guild",
    channelId: "claim-channel",
    openingMessageId: "opening-1",
  });
  await store.updateTicketOpeningMessageId({
    guildId: "another-guild",
    channelId: "claim-channel",
    openingMessageId: "foreign-opening",
  });
  assert.equal(
    (await store.readOpenTicketByChannel("claim-guild", "claim-channel"))?.openingMessageId,
    "opening-1",
  );
  const delivery = {
    guildId: "claim-guild",
    channelId: "claim-channel",
    claimedByUserId: "staff-1",
    claimedAtMs: 1,
    phase: "announcement" as const,
    nowMs: 10,
    leaseUntilMs: 100,
  };
  assert.deepEqual(
    (
      await Promise.all([
        store.claimTicketClaimDelivery(delivery),
        store.claimTicketClaimDelivery(delivery),
      ])
    ).sort(),
    [false, true],
  );
  const reclaimed = { ...delivery, nowMs: 100, leaseUntilMs: 200 };
  assert.equal(await store.claimTicketClaimDelivery(reclaimed), true);
  await store.completeTicketClaimDelivery(delivery);
  await store.releaseTicketClaimDelivery(delivery);
  assert.equal(await store.claimTicketClaimDelivery({ ...reclaimed, nowMs: 150 }), false);
  await store.releaseTicketClaimDelivery(reclaimed);
  assert.equal(await store.claimTicketClaimDelivery(reclaimed), true);
  await store.completeTicketClaimDelivery(reclaimed);
  assert.equal(
    await store.claimTicketClaimDelivery({ ...reclaimed, nowMs: 300, leaseUntilMs: 400 }),
    false,
  );
  assert.equal(await store.claimTicketClaimDelivery({ ...delivery, phase: "audit" }), true);
  assert.equal(
    await store.claimTicketClaimDelivery({
      ...delivery,
      claimedByUserId: "staff-2",
      claimedAtMs: 2,
    }),
    true,
  );
  assert.equal(
    await store.claimTicketClaimDelivery({ ...delivery, guildId: "another-guild" }),
    true,
  );
}
