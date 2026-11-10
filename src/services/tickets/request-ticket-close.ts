import { buildTicketCloseConfirmCustomId, buildTicketCloseDeclineCustomId } from "../../tickets";
import { allowUserMentions, formatUserMention } from "../../discord";
import type { DiscordAllowedMentions } from "../../discord";
import type { TicketInstance } from "../../types";
import { DISCORD_BUTTON_COMPONENT, DISCORD_MESSAGE_COMPONENT_ROW } from "../../discord/constants";

export async function requestTicketClose(
  adapters: {
    createChannelMessage: (
      channelId: string,
      body: {
        content: string;
        allowed_mentions: DiscordAllowedMentions;
        components: unknown[];
      },
    ) => Promise<void>;
  },
  options: {
    ticket: TicketInstance;
    requesterUserId: string;
  },
): Promise<void> {
  await adapters.createChannelMessage(options.ticket.channelId, {
    content: `${formatUserMention(options.ticket.openerUserId)} ${formatUserMention(options.requesterUserId)} requested to close this ticket. Do you want to close it now?`,
    allowed_mentions: allowUserMentions([options.ticket.openerUserId]),
    components: [
      {
        type: DISCORD_MESSAGE_COMPONENT_ROW,
        components: [
          {
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: buildTicketCloseConfirmCustomId(options.ticket.channelId),
            label: "Yes, close ticket",
            style: 4,
          },
          {
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: buildTicketCloseDeclineCustomId(options.ticket.channelId),
            label: "No, keep open",
            style: 2,
          },
        ],
      },
    ],
  });
}
