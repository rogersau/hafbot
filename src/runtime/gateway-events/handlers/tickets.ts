import {
  handleAnonymousStaffThreadMessageCreate,
  handleAnonymousStaffThreadMessageDelete,
  handleAnonymousStaffThreadMessageUpdate,
} from "../../../services/tickets/anonymous-staff-thread";
import type {
  DiscordMessageCreate,
  DiscordMessageDelete,
  DiscordMessageUpdate,
} from "../../../types";
import type { GatewayEventCapabilities } from "../contracts";
import { defineGatewayEventHandler } from "../define-handler";
import { hasGatewayMessageAdminAccess } from "../../gateway-message-admin-access";
import type { GuildRbacStore } from "../../contracts";

export const ticketGatewayHandler = defineGatewayEventHandler(
  ["env", "features", "discord", "operations"],
  ["guildRbac", "ticket"],
  {
    key: "tickets",
    eventTypes: ["MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE"],
    order: 40,
    isEnabled: ({ env, features }) => Boolean(features.tickets && env.HAF_DB),
    async handle({ stores, discord, operations }, envelope) {
      const store = stores!.ticket;
      const adapters = createAnonymousStaffThreadAdapters(discord, stores!.guildRbac);
      if (envelope.type === "MESSAGE_CREATE") {
        await operations.run("message-create:ticket-anonymous-mirror", () =>
          handleAnonymousStaffThreadMessageCreate(
            store,
            adapters,
            envelope.data as DiscordMessageCreate | null,
          ),
        );
      } else if (envelope.type === "MESSAGE_UPDATE") {
        await operations.run("message-update:ticket-anonymous-mirror", () =>
          handleAnonymousStaffThreadMessageUpdate(
            store,
            adapters,
            envelope.data as DiscordMessageUpdate | null,
          ),
        );
      } else {
        await operations.run("message-delete:ticket-anonymous-mirror", () =>
          handleAnonymousStaffThreadMessageDelete(
            store,
            adapters,
            envelope.data as DiscordMessageDelete | null,
          ),
        );
      }
    },
  },
);

function createAnonymousStaffThreadAdapters(
  discord: GatewayEventCapabilities["discord"],
  guildRbac: Pick<GuildRbacStore, "readGuildAdminRoleId" | "readManageServerAdminEnabled">,
) {
  return {
    ...discord,
    fetchAttachment: (url: string) => fetch(url),
    hasAdminAccess: (message: DiscordMessageCreate) => {
      const guildId = message.guild_id;
      const userId = message.author?.id;
      if (!guildId || !userId) {
        return Promise.resolve(false);
      }
      return hasGatewayMessageAdminAccess({
        guildId,
        userId,
        memberRoleIds: message.member?.roles ?? [],
        memberPermissions: message.member?.permissions,
        store: guildRbac,
        discord,
      });
    },
    now: () => Date.now(),
  };
}
