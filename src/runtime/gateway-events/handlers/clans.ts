import { isRecord } from "../../../unknown-parse";
import { defineGatewayEventHandler } from "../define-handler";

export const clanGatewayHandler = defineGatewayEventHandler(
  ["env", "features", "operations", "clanService"],
  [],
  {
    key: "clan-reconciliation",
    eventTypes: ["GUILD_MEMBER_REMOVE", "GUILD_ROLE_DELETE", "CHANNEL_DELETE"],
    order: 9,
    isEnabled: ({ clanService, features }) => Boolean(clanService && features.clans !== false),
    async handle({ clanService, operations }, envelope) {
      if (!clanService || !isRecord(envelope.data)) return;
      const data = envelope.data;
      const guildId = stringField(data, "guild_id");
      if (!guildId) return;
      await operations.run(`clan:${envelope.type.toLowerCase()}`, async () => {
        if (envelope.type === "GUILD_MEMBER_REMOVE") {
          const user = isRecord(data.user) ? data.user : null;
          const userId = user ? stringField(user, "id") : null;
          if (!userId) return;
          await clanService.handleGuildMemberDeparture(guildId, userId);
          return;
        }
        const resourceId =
          envelope.type === "GUILD_ROLE_DELETE"
            ? stringField(data, "role_id")
            : stringField(data, "id");
        if (!resourceId) return;
        await clanService.handleManagedResourceDeleted(guildId, resourceId);
      });
    },
  },
);

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field ? field : null;
}
