import type { TicketStore } from "../../runtime/contracts";
import type { TicketInstance } from "../../types";

export class TicketClaimPermissionError extends Error {
  constructor() {
    super("Only the configured support role can claim this ticket.");
    this.name = "TicketClaimPermissionError";
  }
}

export async function claimTicket(
  store: Pick<TicketStore, "updateTicketClaim">,
  options: {
    ticket: TicketInstance;
    actorUserId: string;
    actorRoleIds: string[];
    nowMs: number;
  },
): Promise<{ claimedByUserId: string; claimedAtMs: number; alreadyClaimed: boolean }> {
  if (
    !options.ticket.supportRoleId ||
    !options.actorRoleIds.includes(options.ticket.supportRoleId)
  ) {
    throw new TicketClaimPermissionError();
  }

  if (options.ticket.claimedByUserId === options.actorUserId) {
    return {
      claimedByUserId: options.actorUserId,
      claimedAtMs: options.ticket.claimedAtMs ?? options.nowMs,
      alreadyClaimed: true,
    };
  }

  await store.updateTicketClaim({
    guildId: options.ticket.guildId,
    channelId: options.ticket.channelId,
    claimedByUserId: options.actorUserId,
    claimedAtMs: options.nowMs,
  });

  return {
    claimedByUserId: options.actorUserId,
    claimedAtMs: options.nowMs,
    alreadyClaimed: false,
  };
}

export async function deliverTicketClaim(
  store: Pick<
    TicketStore,
    | "readOpenTicketByChannel"
    | "claimTicketClaimDelivery"
    | "completeTicketClaimDelivery"
    | "releaseTicketClaimDelivery"
  >,
  adapters: {
    refreshOpeningMessage(ticket: TicketInstance): Promise<void>;
    announce(nonce: string): Promise<void>;
    audit(nonce: string): Promise<void>;
  },
  claim: { ticket: TicketInstance; claimedByUserId: string; claimedAtMs: number },
) {
  await reconcileTicketClaimOpeningMessage(store, adapters.refreshOpeningMessage, claim.ticket);
  for (const phase of ["announcement", "audit"] as const) {
    const nowMs = Date.now();
    const delivery = {
      guildId: claim.ticket.guildId,
      channelId: claim.ticket.channelId,
      claimedByUserId: claim.claimedByUserId,
      claimedAtMs: claim.claimedAtMs,
      phase,
      leaseUntilMs: nowMs + 2 * 60 * 1000,
    };
    if (!(await store.claimTicketClaimDelivery({ ...delivery, nowMs }))) continue;
    try {
      // Discord enforces this nonce for recent retries after an ambiguous response.
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([
            delivery.guildId,
            delivery.channelId,
            delivery.claimedByUserId,
            delivery.claimedAtMs,
            phase,
          ]),
        ),
      );
      const nonce = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 25);
      await (phase === "announcement" ? adapters.announce : adapters.audit)(nonce);
      await store.completeTicketClaimDelivery(delivery);
    } catch (error) {
      await store.releaseTicketClaimDelivery(delivery).catch(() => undefined);
      throw error;
    }
  }
}

async function reconcileTicketClaimOpeningMessage(
  store: Pick<TicketStore, "readOpenTicketByChannel">,
  refreshOpeningMessage: (ticket: TicketInstance) => Promise<void>,
  ticket: TicketInstance,
): Promise<void> {
  let current = await store.readOpenTicketByChannel(ticket.guildId, ticket.channelId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!current) return;
    let refreshFailed = false;
    let refreshError: unknown;
    try {
      await refreshOpeningMessage(current);
    } catch (error) {
      // A failed response can still mean Discord applied this older owner's PATCH.
      refreshFailed = true;
      refreshError = error;
    }
    const latest = await store.readOpenTicketByChannel(ticket.guildId, ticket.channelId);
    if (
      !latest ||
      (latest.claimedByUserId === current.claimedByUserId &&
        latest.claimedAtMs === current.claimedAtMs)
    ) {
      if (refreshFailed) throw refreshError;
      return;
    }
    // Another runtime may have saved and displayed a newer claim while our PATCH
    // was in flight. Repair from persistence after the write, not just before it.
    current = latest;
  }
  // Keep persistent contention retryable through the existing incomplete-updates response.
  throw new Error("Ticket ownership kept changing while refreshing its opening message.");
}
