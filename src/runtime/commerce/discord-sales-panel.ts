import {
  createChannelMessage,
  deleteChannelMessage,
  DiscordApiError,
  editChannelMessage,
} from "../../discord";
import {
  GuildResourceValidationError,
  type GuildResourceValidator,
} from "../../discord/guild-resource-validator";
import type { CommerceSalesPanelDiscordAdapter } from "../../commerce/sales-panel";

export function createDiscordCommerceSalesPanelAdapter(options: {
  discordBotToken: string;
  guildResources: GuildResourceValidator;
}): CommerceSalesPanelDiscordAdapter {
  return {
    async publish(input) {
      await options.guildResources.requireTextChannel(input.guildId, input.channelId);
      if (input.messageId) {
        try {
          const refreshed = await editChannelMessage(
            input.channelId,
            input.messageId,
            input.message,
            options.discordBotToken,
          );
          return { messageId: refreshed.id, created: false };
        } catch (error) {
          if (!(error instanceof DiscordApiError) || error.status !== 404) throw error;
        }
      }
      const created = await createChannelMessage(
        input.channelId,
        {
          ...input.message,
          nonce: input.createNonce,
          enforce_nonce: true,
        },
        options.discordBotToken,
      );
      return { messageId: created.id, created: true };
    },

    async deleteMessage(guildId, channelId, messageId) {
      try {
        await options.guildResources.requireTextChannel(guildId, channelId);
        await deleteChannelMessage(channelId, messageId, options.discordBotToken);
      } catch (error) {
        if (error instanceof DiscordApiError && error.status === 404) return;
        if (error instanceof GuildResourceValidationError) return;
        throw error;
      }
    },
  };
}
