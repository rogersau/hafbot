import { createChannelMessage, editChannelMessage, suppressMentions } from "../discord/messages";
import type { ComponentIdSigner } from "../security/component-id-signer";
import { signSensitiveComponentId } from "../security/sensitive-component-ids";
import type {
  CommerceConnectedAccount,
  CommerceSellerProfile,
  CommerceSellerReviewRequest,
} from "./types";
import type { CommerceSellerLifecycleService } from "./seller-lifecycle";
import type { CommerceSellerStore } from "./store";

const DAY_MS = 24 * 60 * 60 * 1_000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

export interface CommerceSellerReviewNotificationOptions {
  store: CommerceSellerStore;
  lifecycle: CommerceSellerLifecycleService;
  discordBotToken: string;
  reviewChannelId: string;
  signingGuildId?: string;
  componentIdSigner?: ComponentIdSigner;
  now?: () => number;
  createId?: () => string;
}

export function parseCommerceSellerReviewCustomId(
  customId: string,
): { connectedAccountId: string; state: "approved" | "rejected" } | null {
  const match = /^commerce-review:(acct_[A-Za-z0-9]+):(approve|reject)$/.exec(customId);
  if (!match) return null;
  return {
    connectedAccountId: match[1],
    state: match[2] === "approve" ? "approved" : "rejected",
  };
}

/** Durable, idempotent delivery of HAF operator seller review requests. */
export class CommerceSellerReviewNotificationService {
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: CommerceSellerReviewNotificationOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  async syncSeller(input: {
    account: CommerceConnectedAccount;
    profile: CommerceSellerProfile;
  }): Promise<CommerceSellerReviewRequest | null> {
    if (!input.account.detailsSubmitted || input.profile.approvalState !== "pending") return null;
    const request = await this.options.store.ensureSellerReviewRequest({
      id: `seller-review:${input.account.id}`,
      connectedAccountId: input.account.id,
      guildId: input.account.guildId,
      sellerOwnerUserId: input.profile.sellerOwnerUserId,
      guildCreatedAtMs: input.profile.guildCreatedAtMs,
      stripeDetailsSubmitted: input.account.detailsSubmitted,
      stripeChargesEnabled: input.account.chargesEnabled,
      stripePayoutsEnabled: input.account.payoutsEnabled,
      nowMs: this.now(),
    });
    if (!request) return null;
    await this.deliver(request);
    return (await this.options.store.readSellerReviewRequest(input.account.id)) ?? request;
  }

  async retryPending(limit = 50): Promise<number> {
    let delivered = 0;
    for (const request of await this.options.store.listPendingSellerReviewNotifications(limit)) {
      if (await this.deliver(request)) delivered += 1;
    }
    for (const request of await this.options.store.listExpiredSellerReviewDecisions(
      this.now(),
      limit,
    )) {
      const leaseToken = this.createId();
      const claimed = await this.options.store.reclaimExpiredSellerReviewDecision({
        connectedAccountId: request.connectedAccountId,
        leaseToken,
        nowMs: this.now(),
        leaseMs: 60_000,
      });
      if (claimed && (await this.applyDecision(claimed, leaseToken))) delivered += 1;
    }
    for (const request of await this.options.store.listUnnotifiedSellerReviewDecisions(limit)) {
      if (await this.notifyDecision(request)) delivered += 1;
    }
    return delivered;
  }

  async decide(input: {
    connectedAccountId: string;
    state: "approved" | "rejected";
    actorUserId: string;
    reason: string;
    channelId: string;
    messageId?: string;
  }): Promise<CommerceSellerReviewRequest | null> {
    const request = await this.options.store.readSellerReviewRequest(input.connectedAccountId);
    if (
      !request ||
      request.state !== "pending" ||
      request.reviewChannelId !== input.channelId ||
      (input.messageId && request.reviewMessageId !== input.messageId)
    )
      return null;
    const leaseToken = this.createId();
    const claimed = await this.options.store.claimSellerReviewDecision({
      connectedAccountId: input.connectedAccountId,
      state: input.state,
      actorUserId: input.actorUserId,
      reason: input.reason,
      leaseToken,
      nowMs: this.now(),
      leaseMs: 60_000,
    });
    if (!claimed) return null;
    return this.applyDecision(claimed, leaseToken);
  }

  private async applyDecision(
    request: CommerceSellerReviewRequest,
    leaseToken: string,
  ): Promise<CommerceSellerReviewRequest | null> {
    if (!request.decisionState || !request.decisionActorUserId || !request.decisionReason)
      return null;
    // A failed review preserves the processing lease for a safe scheduled retry.
    await this.options.lifecycle.reviewSeller({
      guildId: request.guildId,
      approvalState: request.decisionState,
      actorUserId: request.decisionActorUserId,
      reasonCode: request.decisionReason,
    });
    const decided = await this.options.store.completeSellerReviewDecision({
      connectedAccountId: request.connectedAccountId,
      state: request.decisionState,
      leaseToken,
      nowMs: this.now(),
    });
    if (!decided) return null;
    await this.notifyDecision(decided);
    return decided;
  }

  private async notifyDecision(request: CommerceSellerReviewRequest): Promise<boolean> {
    if (
      (request.state !== "approved" && request.state !== "rejected") ||
      !request.reviewChannelId ||
      !request.reviewMessageId
    ) {
      return false;
    }
    const leaseToken = this.createId();
    const claimed = await this.options.store.claimSellerReviewDecisionNotification({
      connectedAccountId: request.connectedAccountId,
      leaseToken,
      nowMs: this.now(),
      leaseMs: 60_000,
    });
    if (!claimed) return false;
    try {
      await editChannelMessage(
        claimed.reviewChannelId!,
        claimed.reviewMessageId!,
        await reviewMessageBody(
          claimed,
          this.options.componentIdSigner,
          true,
          this.options.signingGuildId,
        ),
        this.options.discordBotToken,
      );
      return await this.options.store.completeSellerReviewDecisionNotification({
        connectedAccountId: claimed.connectedAccountId,
        leaseToken,
        nowMs: this.now(),
      });
    } catch {
      // Lease expiry makes terminal message updates independently retryable.
      return false;
    }
  }

  private async deliver(request: CommerceSellerReviewRequest): Promise<boolean> {
    if (request.state !== "pending" || request.reviewMessageId) return false;
    const leaseToken = this.createId();
    const claimed = await this.options.store.claimSellerReviewNotification({
      connectedAccountId: request.connectedAccountId,
      leaseToken,
      nowMs: this.now(),
      leaseMs: 60_000,
    });
    if (!claimed) return false;
    try {
      const message = await createChannelMessage(
        this.options.reviewChannelId,
        await reviewMessageBody(
          claimed,
          this.options.componentIdSigner,
          false,
          this.options.signingGuildId,
        ),
        this.options.discordBotToken,
      );
      return await this.options.store.completeSellerReviewNotification({
        connectedAccountId: claimed.connectedAccountId,
        leaseToken,
        channelId: this.options.reviewChannelId,
        messageId: message.id,
        nowMs: this.now(),
      });
    } catch {
      // Lease expiry makes failed delivery retryable without duplicate sends in normal races.
      return false;
    }
  }
}

async function reviewMessageBody(
  request: CommerceSellerReviewRequest,
  signer?: ComponentIdSigner,
  decided = false,
  signingGuildId?: string,
) {
  const guildAge = formatGuildAge(request);
  const body = {
    content: decided
      ? `Commerce seller review **${request.state}** for Guild ${request.guildId}. Decision by <@${request.decisionActorUserId ?? "unknown"}>${request.decisionReason ? ` — ${request.decisionReason}` : ""}`
      : `Commerce seller application submitted for review. Guild: ${request.guildId} · Guild age: ${guildAge} · Owner: <@${request.sellerOwnerUserId}> · Stripe details submitted: yes · Charges: ${request.stripeChargesEnabled ? "enabled" : "pending"} · Payouts: ${request.stripePayoutsEnabled ? "enabled" : "pending"}`,
    allowed_mentions: suppressMentions(),
    nonce: await sellerReviewNonce(request.connectedAccountId),
    enforce_nonce: true,
    components: decided
      ? []
      : [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 3,
                label: "Approve",
                custom_id: `commerce-review:${request.connectedAccountId}:approve`,
              },
              {
                type: 2,
                style: 4,
                label: "Reject",
                custom_id: `commerce-review:${request.connectedAccountId}:reject`,
              },
            ],
          },
        ],
  };
  if (decided || !signer) return body;
  const row = body.components[0] as { components: Array<{ custom_id: string }> };
  for (const component of row.components) {
    component.custom_id = await signSensitiveComponentId(component.custom_id, signer, {
      guildId: signingGuildId ?? request.guildId,
    });
  }
  return body;
}

function formatGuildAge(request: CommerceSellerReviewRequest): string {
  if (request.guildCreatedAtMs === null) return "unknown";
  const ageMs = Math.max(0, request.createdAtMs - request.guildCreatedAtMs);
  const days = Math.floor(ageMs / DAY_MS);
  return ageMs < THIRTY_DAYS_MS
    ? `${days} days [REVIEW WARNING: guild is under 30 days old]`
    : `${days} days`;
}

async function sellerReviewNonce(connectedAccountId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(connectedAccountId),
  );
  return `review_${Array.from(new Uint8Array(digest).slice(0, 8))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}
