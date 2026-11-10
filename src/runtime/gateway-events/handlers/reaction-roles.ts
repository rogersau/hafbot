import { ReactionRoleService } from "../../../services/reaction-role-service";
import { defineGatewayEventHandler } from "../define-handler";

export const reactionRoleGatewayHandler = defineGatewayEventHandler(
  ["env", "features", "discord", "operations"],
  ["reactionRole"],
  {
    key: "reaction-roles",
    eventTypes: ["MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE"],
    order: 80,
    isEnabled: ({ features }) => features.reactionRoles !== false,
    async handle({ env, stores, discord, operations }, envelope) {
      if (!stores?.reactionRole) return;
      const service = new ReactionRoleService(
        stores.reactionRole,
        discord.reactionRoles,
        envelope.botUserId ?? env.BOT_USER_ID ?? "",
      );
      await operations.run("reaction-roles:reconcile", () =>
        service.reconcile(envelope.data, envelope.receivedAtMs),
      );
    },
  },
);
