import {
  buildAuditEmbed,
  formatStaffUserReference,
  suppressMentions,
} from "../../../discord/messages";
import { moderateReactionLimitAdd } from "../../../services/reaction-limits/reaction-limit-service";
import type { DiscordReaction } from "../../../types";
import { withGatewayMessageNonce } from "../capabilities";
import { defineGatewayEventHandler } from "../define-handler";
import { deriveGatewayOperationNonce } from "../../gateway-event-idempotency";

export const reactionLimitGatewayHandler = defineGatewayEventHandler(
  ["operations", "discord", "productAnalytics"],
  ["reactionLimit", "reactionMutations", "timedRole", "blocklist", "entitlement"],
  {
    key: "reaction-limits",
    eventTypes: ["MESSAGE_REACTION_ADD"],
    order: 20,

    async handle({ operations, stores, discord, productAnalytics }, envelope) {
      const reaction = envelope.data as DiscordReaction | null;
      if (!reaction?.guild_id) return;
      const reactionStore = stores.reactionLimit;
      const timedRoleStore = stores.timedRole;
      const notificationStore = stores.blocklist;
      await moderateReactionLimitAdd(reaction, {
        readConfig: (guildId) => reactionStore.readReactionLimitConfig(guildId),
        readGuildEntitlement: (guildId) => stores.entitlement.readGuildEntitlement(guildId),
        incrementReactionCounters: (nextReaction) =>
          operations.runResult("reaction-add:reaction-limit:counters", () =>
            stores.reactionMutations.incrementCounters(envelope.eventKey, nextReaction),
          ),
        removeReaction: (nextReaction) =>
          operations
            .run("reaction-add:reaction-limit:remove", async () => {
              await discord.deleteReaction(
                nextReaction.channel_id,
                nextReaction.message_id,
                nextReaction.emoji,
                nextReaction.user_id,
              );
              void productAnalytics.report({
                name: "feature_outcome",
                insertionId: deriveGatewayOperationNonce(
                  envelope.eventKey,
                  "analytics:reaction-limit",
                ),
                guildId: nextReaction.guild_id!,
                feature: "reaction_rules",
                action: "reaction_limit_enforced",
                status: "success",
              });
            })
            .then(() => undefined),
        incrementBreachCounter: (guildId, userId) =>
          operations.runResult("reaction-add:reaction-limit:breach-increment", () =>
            stores.reactionMutations.incrementBreach(envelope.eventKey, guildId, userId),
          ),
        resetBreachCounter: (guildId, userId) =>
          operations
            .run("reaction-add:reaction-limit:breach-reset", () =>
              reactionStore.resetBreachCounter(guildId, userId),
            )
            .then(() => undefined),
        assignRole: async ({ guildId, userId, roleId, durationMs }) => {
          await operations.run("reaction-add:reaction-limit:role", () =>
            discord.addGuildMemberRole(guildId, userId, roleId),
          );
          if (durationMs !== null) {
            const expiresAtMs = await stores.reactionMutations.resolveTimedRoleExpiry(
              envelope.eventKey,
              durationMs,
            );
            await operations.run("reaction-add:reaction-limit:timed-role", () =>
              timedRoleStore.upsertTimedRole({
                guildId,
                userId,
                roleId,
                durationInput: `${durationMs}ms`,
                expiresAtMs,
              }),
            );
          }
        },
        sendDm: (userId, message) =>
          operations
            .run("reaction-add:reaction-limit:dm", () =>
              discord.createUserDmMessage(
                userId,
                withGatewayMessageNonce(
                  { content: message, allowed_mentions: { parse: [] } },
                  envelope.eventKey,
                  "reaction-add:reaction-limit:dm",
                  userId,
                ),
              ),
            )
            .then(() => undefined),
        logRoleAssignment: (input) =>
          operations
            .run("reaction-add:reaction-limit:audit", async () => {
              const channelId = await notificationStore.readGuildNotificationChannel(
                input.guildId,
                "blocklist",
              );
              if (!channelId) return;
              await discord.createChannelMessage(
                channelId,
                withGatewayMessageNonce(
                  {
                    embeds: [
                      buildAuditEmbed({
                        title: "Reaction Limit Breach",
                        color: 0xed4245,
                        fields: [
                          {
                            name: "Breaching Member",
                            value: formatStaffUserReference(input.userId),
                          },
                          { name: "Assigned Role", value: `<@&${input.roleId}>` },
                          {
                            name: "Breach Context",
                            value: `Channel: <#${input.reaction.channel_id}>\nMessage ID: ${input.reaction.message_id}\nBreach count: ${input.breachCount} / ${input.breachThreshold}\nUser reactions: ${input.userReactions} / ${input.maxReactionsPerUserPerMessage}`,
                          },
                        ],
                      }),
                    ],
                    allowed_mentions: suppressMentions(),
                  },
                  envelope.eventKey,
                  "reaction-add:reaction-limit:audit",
                  channelId,
                ),
              );
            })
            .then(() => undefined),
      });
    },
  },
);
