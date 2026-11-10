/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";
import { handleCommerceSellerReviewInteraction } from "../src/runtime/commerce-seller-review-interaction-handler";

const interaction = {
  type: 3,
  guild_id: "haf-guild",
  channel_id: "review-channel",
  member: { roles: ["haf-admin-role"], user: { id: "operator-1" } },
  message: { id: "review-message", channel_id: "review-channel" },
  data: { custom_id: "commerce-review:acct_123:approve" },
};

test("seller reviews require the HAF admin role and bind the decision to the source message", async () => {
  let decision: Record<string, unknown> | undefined;
  const response = await handleCommerceSellerReviewInteraction(interaction, {
    hafAdminGuildId: "haf-guild",
    hafAdminRoleId: "haf-admin-role",
    sellerReviews: {
      async decide(input) {
        decision = input;
        return {};
      },
    },
  });

  assert.deepEqual(decision, {
    connectedAccountId: "acct_123",
    state: "approved",
    actorUserId: "operator-1",
    reason: "discord_button_approved",
    channelId: "review-channel",
    messageId: "review-message",
  });
  assert.match(await response.text(), /Seller approved/);
});

test("seller reviews reject operators outside the HAF admin role", async () => {
  const response = await handleCommerceSellerReviewInteraction(
    { ...interaction, member: { roles: [], user: { id: "operator-1" } } },
    {
      hafAdminGuildId: "haf-guild",
      hafAdminRoleId: "haf-admin-role",
      sellerReviews: {
        async decide() {
          throw new Error("must not run");
        },
      },
    },
  );
  assert.match(await response.text(), /not authorised/i);
});
