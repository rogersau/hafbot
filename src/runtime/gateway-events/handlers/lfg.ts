import { LfgService } from "../../../services/lfg-service";
import type { GatewayEventCapabilities } from "../contracts";
import { defineGatewayEventHandler } from "../define-handler";

export const lfgGatewayHandler = defineGatewayEventHandler(
  ["env", "features", "discord", "operations"],
  ["lfg"],
  {
    key: "lfg-voice-cleanup",
    eventTypes: ["VOICE_STATE_UPDATE"],
    order: 10,
    isEnabled: ({ stores, features }, envelope) =>
      Boolean(features.lfg && stores && envelope.emptiedVoiceChannelId),
    async handle({ stores, discord, operations }, envelope) {
      const service = new LfgService(
        stores.lfg,
        createLfgGatewayDiscordAdapters(discord),
        undefined,
        undefined,
        discord.guildResources,
      );
      await operations.run("voice-state:delete-empty-lfg-channel", () =>
        service.deletePrivateVoiceChannelForDiscordChannel(envelope.emptiedVoiceChannelId!),
      );
    },
  },
);

function createLfgGatewayDiscordAdapters(discord: GatewayEventCapabilities["discord"]) {
  return {
    ...discord,
    modifyChannel: async () => {},
  };
}
