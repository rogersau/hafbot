import { moderateBotDefenseMessageCreate } from "../../../services/bot-defense/message-filter";
import { moderateMessageCreate } from "../../../services/blocklist/message-filter";
import { moderateReactionAdd } from "../../../services/blocklist/reaction-filter";
import { postMessageAuditEvent } from "../../../services/guild-audit-log-service";
import { moderateImageRulesMessageCreate } from "../../../services/image-rules/message-filter";
import { moderateMentionProtectionMessage } from "../../../services/mention-protection/message-handler";
import type { DiscordMessageCreate, DiscordMessageUpdate, DiscordReaction } from "../../../types";
import { deriveGatewayOperationNonce } from "../../gateway-event-idempotency";
import { withGatewayMessageNonce } from "../capabilities";
import { defineGatewayEventHandler } from "../define-handler";

export const moderationGatewayHandlers = [
  defineGatewayEventHandler(
    ["botEnv", "features", "operations", "productAnalytics"],
    ["blocklist"],
    {
      key: "reaction-blocklist",
      eventTypes: ["MESSAGE_REACTION_ADD"],
      order: 10,
      isEnabled: ({ features }) => features.blocklist,
      async handle({ botEnv, operations, productAnalytics, stores }, envelope) {
        await operations.run("reaction-add:blocklist", async () => {
          const reaction = envelope.data as DiscordReaction | null;
          const blocklistStore = stores?.blocklist;
          const outcome = await moderateReactionAdd(
            reaction,
            botEnv,
            blocklistStore
              ? {
                  readBlocklist: () => blocklistStore.readConfig(),
                  readBlocklistForGuild: (guildId) => blocklistStore.readGuildConfig(guildId),
                }
              : {},
          );
          if (outcome === "removed" && reaction?.guild_id) {
            void productAnalytics.report({
              name: "feature_outcome",
              insertionId: deriveGatewayOperationNonce(envelope.eventKey, "analytics:blocklist"),
              guildId: reaction.guild_id,
              feature: "reaction_rules",
              action: "blocked_reaction_removed",
              status: "success",
            });
          }
        });
      },
    },
  ),
  defineGatewayEventHandler(["env", "features", "mentionProtection", "operations"], [], {
    key: "mention-protection",
    eventTypes: ["MESSAGE_CREATE", "MESSAGE_UPDATE"],
    order: 10,
    isEnabled: ({ env, features }) => Boolean(features.mentionProtection && env.HAF_DB),
    async handle({ mentionProtection, operations }, envelope) {
      const key = envelope.type === "MESSAGE_CREATE" ? "message-create" : "message-update";
      await operations.run(`${key}:mention-protection`, () =>
        moderateMentionProtectionMessage(
          envelope.data as DiscordMessageCreate | DiscordMessageUpdate | null,
          mentionProtection!,
        ),
      );
    },
  }),
  defineGatewayEventHandler(
    ["botEnv", "features", "operations", "discord", "resolveBotDisplayName"],
    ["blocklist"],
    {
      key: "message-blocklist",
      eventTypes: ["MESSAGE_CREATE"],
      order: 20,
      isEnabled: ({ features }) => features.blocklist,
      async handle({ botEnv, operations, resolveBotDisplayName, discord, stores }, envelope) {
        await operations.run("message-create:blocklist", () =>
          moderateMessageCreate(
            envelope.data as DiscordMessageCreate | null,
            botEnv,
            {
              ...(stores
                ? {
                    readBlocklist: () => stores.blocklist.readConfig(),
                    readBlocklistForGuild: (guildId: string) =>
                      stores.blocklist.readGuildConfig(guildId),
                  }
                : {}),
              createUserDmMessage: (userId, body, _token) =>
                discord.createUserDmMessage(
                  userId,
                  withGatewayMessageNonce(
                    body,
                    envelope.eventKey,
                    "message-create:blocklist:dm",
                    userId,
                  ),
                ),
            },
            resolveBotDisplayName,
          ),
        );
      },
    },
  ),
  defineGatewayEventHandler(
    ["env", "botEnv", "features", "operations", "discord", "resolveBotDisplayName"],
    ["audit"],
    {
      key: "image-rules",
      eventTypes: ["MESSAGE_CREATE"],
      order: 30,
      isEnabled: ({ env, features }) => Boolean(features.imageRules && env.HAF_DB),
      async handle({ env, botEnv, operations, resolveBotDisplayName, stores, discord }, envelope) {
        await operations.run("message-create:image-rules", () =>
          moderateImageRulesMessageCreate(
            envelope.data as DiscordMessageCreate | null,
            botEnv,
            {
              createUserDmMessage: (userId, body, _token) =>
                discord.createUserDmMessage(
                  userId,
                  withGatewayMessageNonce(
                    body,
                    envelope.eventKey,
                    "message-create:image-rules:dm",
                    userId,
                  ),
                ),
              postAuditEvent: (eventId, data) =>
                postMessageAuditEvent(
                  eventId,
                  data,
                  stores!.audit,
                  botEnv.DISCORD_BOT_TOKEN,
                  env.BOT_USER_ID,
                  true,
                  deriveGatewayOperationNonce(
                    envelope.eventKey,
                    `message-create:image-rules:${eventId}`,
                  ),
                ),
            },
            resolveBotDisplayName,
          ),
        );
      },
    },
  ),
  defineGatewayEventHandler(
    ["env", "botEnv", "features", "operations", "resolveBotDisplayName"],
    ["audit"],
    {
      key: "bot-defense",
      eventTypes: ["MESSAGE_CREATE"],
      order: 35,
      isEnabled: ({ env, features }) => Boolean(features.botDefense && env.HAF_DB),
      async handle({ env, botEnv, operations, resolveBotDisplayName, stores }, envelope) {
        await operations.run("message-create:bot-defense", () =>
          moderateBotDefenseMessageCreate(
            envelope.data as DiscordMessageCreate | null,
            botEnv,
            {
              postAuditEvent: (eventId, data) =>
                postMessageAuditEvent(
                  eventId,
                  data,
                  stores!.audit,
                  botEnv.DISCORD_BOT_TOKEN,
                  env.BOT_USER_ID,
                  true,
                  deriveGatewayOperationNonce(
                    envelope.eventKey,
                    `message-create:bot-defense:${eventId}`,
                  ),
                ),
            },
            resolveBotDisplayName,
          ),
        );
      },
    },
  ),
];
