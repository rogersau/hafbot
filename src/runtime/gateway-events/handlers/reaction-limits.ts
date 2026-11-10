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
  ["env", "botEnv", "operations", "discord", "productAnalytics"],
  ["reactionLimit", "timedRole", "blocklist", "entitlement"],
  {
    key: "reaction-limits",
    eventTypes: ["MESSAGE_REACTION_ADD"],
    order: 20,
    isEnabled: ({ env }) => Boolean(env.HAF_DB),
    async handle({ botEnv: env, operations, stores, discord, productAnalytics }, envelope) {
      const reaction = envelope.data as DiscordReaction | null;
      if (!reaction?.guild_id || !env.HAF_DB) return;
      const reactionStore = stores!.reactionLimit;
      const timedRoleStore = stores!.timedRole;
      const notificationStore = stores!.blocklist;
      await moderateReactionLimitAdd(reaction, {
        readConfig: (guildId) => reactionStore.readReactionLimitConfig(guildId),
        readGuildEntitlement: (guildId) => stores!.entitlement.readGuildEntitlement(guildId),
        incrementReactionCounters: (nextReaction) =>
          operations.runResult("reaction-add:reaction-limit:counters", () =>
            incrementReactionCountersOnce(env.HAF_DB!, envelope.eventKey, nextReaction),
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
            incrementReactionBreachOnce(env.HAF_DB!, envelope.eventKey, guildId, userId),
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
            const expiresAtMs = await resolveReactionTimedRoleExpiryOnce(
              env.HAF_DB!,
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

async function incrementReactionCountersOnce(
  database: D1Database,
  eventKey: string,
  reaction: DiscordReaction,
): Promise<{ totalReactions: number; userReactions: number }> {
  const guildId = reaction.guild_id!;
  const kind = "counters";
  const nowMs = Date.now();
  await database.batch([
    database
      .prepare(
        `INSERT OR IGNORE INTO gateway_reaction_limit_mutations
           (event_key, mutation_kind, result_one, result_two, created_at_ms)
         VALUES (?, ?, NULL, NULL, ?)`,
      )
      .bind(eventKey, kind, nowMs),
    database
      .prepare(
        `INSERT INTO reaction_limit_message_reaction_counts
            (guild_id, channel_id, message_id, reaction_count, updated_at_ms)
          SELECT ?, ?, ?, 1, ? WHERE EXISTS (
            SELECT 1 FROM gateway_reaction_limit_mutations
            WHERE event_key = ? AND mutation_kind = ? AND result_one IS NULL
          ) ON CONFLICT(guild_id, channel_id, message_id) DO UPDATE
          SET reaction_count = reaction_limit_message_reaction_counts.reaction_count + 1,
              updated_at_ms = excluded.updated_at_ms`,
      )
      .bind(guildId, reaction.channel_id, reaction.message_id, nowMs, eventKey, kind),
    database
      .prepare(
        `INSERT INTO reaction_limit_user_message_reaction_counts
            (guild_id, channel_id, message_id, user_id, reaction_count, updated_at_ms)
          SELECT ?, ?, ?, ?, 1, ? WHERE EXISTS (
            SELECT 1 FROM gateway_reaction_limit_mutations
            WHERE event_key = ? AND mutation_kind = ? AND result_one IS NULL
          ) ON CONFLICT(guild_id, channel_id, message_id, user_id) DO UPDATE
          SET reaction_count = reaction_limit_user_message_reaction_counts.reaction_count + 1,
              updated_at_ms = excluded.updated_at_ms`,
      )
      .bind(
        guildId,
        reaction.channel_id,
        reaction.message_id,
        reaction.user_id,
        nowMs,
        eventKey,
        kind,
      ),
    database
      .prepare(
        `UPDATE gateway_reaction_limit_mutations SET
           result_one = (SELECT reaction_count FROM reaction_limit_message_reaction_counts
             WHERE guild_id = ? AND channel_id = ? AND message_id = ?),
           result_two = (SELECT reaction_count FROM reaction_limit_user_message_reaction_counts
             WHERE guild_id = ? AND channel_id = ? AND message_id = ? AND user_id = ?)
         WHERE event_key = ? AND mutation_kind = ? AND result_one IS NULL`,
      )
      .bind(
        guildId,
        reaction.channel_id,
        reaction.message_id,
        guildId,
        reaction.channel_id,
        reaction.message_id,
        reaction.user_id,
        eventKey,
        kind,
      ),
  ]);
  const result = await database
    .prepare(
      `SELECT result_one, result_two FROM gateway_reaction_limit_mutations
       WHERE event_key = ? AND mutation_kind = ?`,
    )
    .bind(eventKey, kind)
    .first<{ result_one: number; result_two: number }>();
  if (!result) throw new Error("Reaction counter mutation result was not persisted.");
  return { totalReactions: result.result_one, userReactions: result.result_two };
}

async function incrementReactionBreachOnce(
  database: D1Database,
  eventKey: string,
  guildId: string,
  userId: string,
): Promise<number> {
  const kind = "breach";
  await database.batch([
    database
      .prepare(
        `INSERT OR IGNORE INTO gateway_reaction_limit_mutations
           (event_key, mutation_kind, result_one, result_two, created_at_ms)
         VALUES (?, ?, NULL, NULL, ?)`,
      )
      .bind(eventKey, kind, Date.now()),
    database
      .prepare(
        `INSERT INTO reaction_limit_breach_counters (guild_id, user_id, breach_count)
         SELECT ?, ?, 1 WHERE EXISTS (
           SELECT 1 FROM gateway_reaction_limit_mutations
           WHERE event_key = ? AND mutation_kind = ? AND result_one IS NULL
         ) ON CONFLICT(guild_id, user_id) DO UPDATE
         SET breach_count = reaction_limit_breach_counters.breach_count + 1`,
      )
      .bind(guildId, userId, eventKey, kind),
    database
      .prepare(
        `UPDATE gateway_reaction_limit_mutations SET result_one = (
           SELECT breach_count FROM reaction_limit_breach_counters
           WHERE guild_id = ? AND user_id = ?
         ) WHERE event_key = ? AND mutation_kind = ? AND result_one IS NULL`,
      )
      .bind(guildId, userId, eventKey, kind),
  ]);
  const result = await database
    .prepare(
      `SELECT result_one FROM gateway_reaction_limit_mutations
       WHERE event_key = ? AND mutation_kind = ?`,
    )
    .bind(eventKey, kind)
    .first<{ result_one: number }>();
  if (!result) throw new Error("Reaction breach mutation result was not persisted.");
  return result.result_one;
}

async function resolveReactionTimedRoleExpiryOnce(
  database: D1Database,
  eventKey: string,
  durationMs: number,
): Promise<number> {
  const kind = "timed-role-expiry";
  await database
    .prepare(
      `INSERT OR IGNORE INTO gateway_reaction_limit_mutations
         (event_key, mutation_kind, result_one, result_two, created_at_ms)
       VALUES (?, ?, ?, NULL, ?)`,
    )
    .bind(eventKey, kind, Date.now() + durationMs, Date.now())
    .run();
  const result = await database
    .prepare(
      `SELECT result_one FROM gateway_reaction_limit_mutations
       WHERE event_key = ? AND mutation_kind = ?`,
    )
    .bind(eventKey, kind)
    .first<{ result_one: number }>();
  if (!result) throw new Error("Reaction timed-role expiry was not persisted.");
  return result.result_one;
}
