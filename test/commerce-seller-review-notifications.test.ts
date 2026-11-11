/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  CommerceSellerReviewNotificationService,
  type CommerceConnectedAccount,
  type CommerceSellerProfile,
  type CommerceSellerReviewRequest,
  type CommerceSellerStore,
} from "../src/commerce";

const NOW = 1_800_000_000_000;

test("seller review notifications use a stable Discord-sized nonce", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  try {
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ id: "review-message", channel_id: "review-channel", content: "" });
    };
    const request = reviewRequest({ guildCreatedAtMs: NOW - 10 * 24 * 60 * 60 * 1_000 });
    const service = new CommerceSellerReviewNotificationService({
      store: notificationStore(request),
      lifecycle: {} as never,
      discordBotToken: "token",
      reviewChannelId: "review-channel",
      now: () => NOW,
      createId: () => "lease-1",
    });

    await service.syncSeller({ account: account(), profile: profile() });
    assert.ok(body);
    const nonce = body.nonce;
    assert.ok(typeof nonce === "string");
    assert.ok(nonce.length <= 25);
    assert.match(nonce, /^review_[a-f0-9]{16}$/);
    assert.match(
      String(body.content),
      /Guild age: 10 days \[REVIEW WARNING: guild is under 30 days old\]/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("seller review decision stays processing when approval persistence fails", async () => {
  const request = reviewRequest({
    reviewChannelId: "review-channel",
    reviewMessageId: "review-message",
  });
  const store = notificationStore(request);
  const service = new CommerceSellerReviewNotificationService({
    store,
    lifecycle: {
      async reviewSeller() {
        throw new Error("transient D1 failure");
      },
    } as never,
    discordBotToken: "token",
    reviewChannelId: "review-channel",
    now: () => NOW,
    createId: () => "decision-lease",
  });

  await assert.rejects(
    () =>
      service.decide({
        connectedAccountId: request.connectedAccountId,
        state: "approved",
        actorUserId: "operator-1",
        reason: "discord_button_approved",
        channelId: "review-channel",
        messageId: "review-message",
      }),
    /transient D1 failure/,
  );
  assert.equal(request.state, "processing");
  assert.equal(request.decisionState, "approved");
});

test("seller review decision retries a failed terminal message update", async () => {
  const originalFetch = globalThis.fetch;
  let edits = 0;
  try {
    globalThis.fetch = async () => {
      edits += 1;
      return edits === 1
        ? new Response("discord unavailable", { status: 500 })
        : Response.json({ id: "review-message", channel_id: "review-channel", content: "" });
    };
    const request = reviewRequest({
      reviewChannelId: "review-channel",
      reviewMessageId: "review-message",
    });
    const service = new CommerceSellerReviewNotificationService({
      store: notificationStore(request),
      lifecycle: { async reviewSeller() {} } as never,
      discordBotToken: "token",
      reviewChannelId: "review-channel",
      now: () => NOW,
      createId: () => `lease-${edits}`,
    });

    const decided = await service.decide({
      connectedAccountId: request.connectedAccountId,
      state: "approved",
      actorUserId: "operator-1",
      reason: "discord_button_approved",
      channelId: "review-channel",
      messageId: "review-message",
    });
    assert.equal(decided?.state, "approved");
    assert.equal(request.decisionNotifiedAtMs, null);

    await service.retryPending();
    assert.equal(edits, 2);
    assert.equal(request.decisionNotifiedAtMs, NOW);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function notificationStore(request: CommerceSellerReviewRequest): CommerceSellerStore {
  return {
    async readSellerReviewRequest() {
      return request;
    },
    async ensureSellerReviewRequest() {
      return request;
    },
    async claimSellerReviewNotification(
      input: Parameters<CommerceSellerStore["claimSellerReviewNotification"]>[0],
    ) {
      request.notificationLeaseToken = input.leaseToken;
      return request;
    },
    async completeSellerReviewNotification(
      input: Parameters<CommerceSellerStore["completeSellerReviewNotification"]>[0],
    ) {
      request.reviewChannelId = input.channelId;
      request.reviewMessageId = input.messageId;
      request.notificationLeaseToken = null;
      return true;
    },
    async claimSellerReviewDecision(
      input: Parameters<CommerceSellerStore["claimSellerReviewDecision"]>[0],
    ) {
      request.state = "processing";
      request.notificationLeaseToken = input.leaseToken;
      request.decisionActorUserId = input.actorUserId;
      request.decisionState = input.state;
      request.decisionReason = input.reason;
      return request;
    },
    async reclaimExpiredSellerReviewDecision() {
      return null;
    },
    async completeSellerReviewDecision(
      input: Parameters<CommerceSellerStore["completeSellerReviewDecision"]>[0],
    ) {
      request.state = input.state;
      request.decisionState = null;
      request.notificationLeaseToken = null;
      return request;
    },
    async listPendingSellerReviewNotifications() {
      return [];
    },
    async listExpiredSellerReviewDecisions() {
      return [];
    },
    async claimSellerReviewDecisionNotification(
      input: Parameters<CommerceSellerStore["claimSellerReviewDecisionNotification"]>[0],
    ) {
      if (request.decisionNotifiedAtMs !== null) return null;
      request.notificationLeaseToken = input.leaseToken;
      return request;
    },
    async completeSellerReviewDecisionNotification(
      input: Parameters<CommerceSellerStore["completeSellerReviewDecisionNotification"]>[0],
    ) {
      request.decisionNotifiedAtMs = input.nowMs;
      request.notificationLeaseToken = null;
      return true;
    },
    async listUnnotifiedSellerReviewDecisions() {
      return request.decisionNotifiedAtMs === null && request.state !== "pending" ? [request] : [];
    },
  } as unknown as CommerceSellerStore;
}

function account(): CommerceConnectedAccount {
  return {
    id: "acct_123456789012345678901234567890",
    guildId: "guild-1",
    stripeAccountId: "acct_123456789012345678901234567890",
    status: "active",
    country: "AU",
    defaultCurrency: "AUD",
    chargesEnabled: true,
    payoutsEnabled: true,
    detailsSubmitted: true,
    providerCreatedAtMs: NOW,
    archivedAtMs: null,
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
}

function profile(): CommerceSellerProfile {
  return {
    connectedAccountId: account().id,
    guildId: "guild-1",
    sellerOwnerUserId: "seller-1",
    lifecycleState: "pending_review",
    approvalState: "pending",
    supportContact: "seller@example.test",
    adultAttestedAtMs: NOW,
    twoFactorEvidence: "seller_attested",
    guildCreatedAtMs: NOW,
    ownershipTransferredAtMs: null,
    guildGoodStanding: true,
    sellerGoodStanding: true,
    requirementsCurrentlyDueJson: "[]",
    requirementsEventuallyDueJson: "[]",
    requirementsPendingVerificationJson: "[]",
    disabledReason: null,
    reviewedByUserId: null,
    reviewedAtMs: null,
    capabilitiesUpdatedAtMs: NOW,
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
}

function reviewRequest(
  overrides: Partial<CommerceSellerReviewRequest> = {},
): CommerceSellerReviewRequest {
  return {
    id: "seller-review:acct_123456789012345678901234567890",
    connectedAccountId: account().id,
    guildId: "guild-1",
    sellerOwnerUserId: "seller-1",
    guildCreatedAtMs: NOW - 45 * 24 * 60 * 60 * 1_000,
    state: "pending",
    stripeDetailsSubmitted: true,
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
    reviewChannelId: null,
    reviewMessageId: null,
    notificationLeaseToken: null,
    notificationLeaseExpiresAtMs: null,
    decisionActorUserId: null,
    decisionState: null,
    decisionReason: null,
    decidedAtMs: null,
    decisionNotifiedAtMs: null,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...overrides,
  };
}
