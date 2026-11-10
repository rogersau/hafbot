import { parseCommerceSellerReviewCustomId } from "../commerce/seller-review-notifications";
import { editOriginalInteractionResponse } from "../discord";
import { buildEphemeralMessage } from "../discord-interactions";
import {
  DISCORD_DEFERRED_CHANNEL_MESSAGE_RESPONSE,
  DISCORD_EPHEMERAL_FLAG,
} from "../discord/constants";
import type { DiscordInteraction } from "./app-types";
import { getInteractionCustomId, getInteractionUserId } from "./discord-interaction-parsers";

export function isCommerceSellerReviewInteraction(interaction: DiscordInteraction): boolean {
  const customId = getInteractionCustomId(interaction);
  return typeof customId === "string" && parseCommerceSellerReviewCustomId(customId) !== null;
}

export function handleCommerceSellerReviewInteraction(
  interaction: DiscordInteraction,
  input: {
    hafAdminGuildId?: string;
    hafAdminRoleId?: string;
    sellerReviews?: {
      decide(input: {
        connectedAccountId: string;
        state: "approved" | "rejected";
        actorUserId: string;
        reason: string;
        channelId: string;
        messageId?: string;
      }): Promise<unknown | null>;
    };
    waitUntil?: (promise: Promise<unknown>) => void;
  },
): Promise<Response> {
  const parsed = parseCommerceSellerReviewCustomId(getInteractionCustomId(interaction) ?? "");
  const actorUserId = getInteractionUserId(interaction);
  const channelId = interaction.channel_id ?? interaction.message?.channel_id;
  const roles = interaction.member?.roles;
  if (!parsed || !actorUserId || !channelId || !input.sellerReviews) {
    return Promise.resolve(
      Response.json(buildEphemeralMessage("This seller review is unavailable.")),
    );
  }
  if (
    interaction.guild_id !== input.hafAdminGuildId ||
    !input.hafAdminRoleId ||
    !Array.isArray(roles) ||
    !roles.includes(input.hafAdminRoleId)
  ) {
    return Promise.resolve(
      Response.json(buildEphemeralMessage("You are not authorised to review sellers.")),
    );
  }

  const action = async (): Promise<string> => {
    const decided = await input.sellerReviews!.decide({
      connectedAccountId: parsed.connectedAccountId,
      state: parsed.state,
      actorUserId,
      reason: `discord_button_${parsed.state}`,
      channelId,
      messageId: interaction.message?.id,
    });
    return decided
      ? `Seller ${parsed.state === "approved" ? "approved" : "rejected"}.`
      : "This seller review has already been completed or is no longer available.";
  };
  if (!input.waitUntil) {
    return action()
      .then((content) => Response.json(buildEphemeralMessage(content)))
      .catch(() => Response.json(buildEphemeralMessage("Unable to complete this seller review.")));
  }
  input.waitUntil(
    action()
      .then((content) => updateDeferred(interaction, content))
      .catch(() => updateDeferred(interaction, "Unable to complete this seller review.")),
  );
  return Promise.resolve(
    Response.json({
      type: DISCORD_DEFERRED_CHANNEL_MESSAGE_RESPONSE,
      data: { flags: DISCORD_EPHEMERAL_FLAG },
    }),
  );
}

async function updateDeferred(interaction: DiscordInteraction, content: string): Promise<void> {
  if (!interaction.application_id || !interaction.token) return;
  await editOriginalInteractionResponse(interaction.application_id, interaction.token, {
    content,
    allowed_mentions: { parse: [] },
  });
}
