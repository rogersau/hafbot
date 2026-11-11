import { isRecord } from "../../../unknown-parse";
import { defineGatewayEventHandler } from "../define-handler";

export const communityToolsGatewayHandler = defineGatewayEventHandler(
  ["operations"],
  ["communityTools", "reputationServiceForGuild"],
  {
    key: "community-tools",
    eventTypes: ["MESSAGE_CREATE", "GUILD_MEMBER_ADD", "GUILD_MEMBER_REMOVE"],
    order: 6,
    async handle({ stores, operations }, envelope) {
      const data = envelope.data;
      if (!isRecord(data) || typeof data.guild_id !== "string") return;
      if (envelope.type !== "MESSAGE_CREATE") {
        if (
          stores.reputationServiceForGuild &&
          isRecord(data.user) &&
          typeof data.user.id === "string"
        ) {
          const guildId = data.guild_id;
          const userId = data.user.id;
          const serviceForGuild = stores.reputationServiceForGuild;
          await operations.run("reputation:membership", async () => {
            await (
              await serviceForGuild(guildId)
            ).setMembership(guildId, userId, envelope.type === "GUILD_MEMBER_ADD");
          });
        }
        return;
      }
      if (
        !stores.communityTools ||
        !isRecord(data.author) ||
        typeof data.author.id !== "string" ||
        data.author.bot === true ||
        data.webhook_id ||
        typeof data.channel_id !== "string" ||
        typeof data.id !== "string" ||
        typeof data.content !== "string"
      )
        return;
      await stores.communityTools.onMessage(
        {
          guildId: data.guild_id,
          channelId: data.channel_id,
          messageId: data.id,
          userId: data.author.id,
          content: data.content,
          eventKey: envelope.eventKey,
          receivedAtMs: envelope.receivedAtMs ?? Date.now(),
        },
        operations,
      );
    },
  },
);
