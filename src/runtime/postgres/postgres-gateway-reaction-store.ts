import type { PostgresDatabaseCapability } from "./postgres-capability";
import { executePostgresCommands } from "./postgres-statements";
import type { DiscordReaction } from "../../types";
import type { GatewayReactionStore } from "../contracts/gateway-reaction-store";
export function createPostgresGatewayReactionStore(
  database: PostgresDatabaseCapability,
): GatewayReactionStore {
  return {
    incrementCounters: (eventKey, reaction) =>
      incrementReactionCountersOnce(database, eventKey, reaction),
    incrementBreach: (eventKey, guildId, userId) =>
      incrementReactionBreachOnce(database, eventKey, guildId, userId),
    resolveTimedRoleExpiry: (eventKey, durationMs) =>
      resolveReactionTimedRoleExpiryOnce(database, eventKey, durationMs),
  };
}

async function incrementReactionCountersOnce(
  database: PostgresDatabaseCapability,
  eventKey: string,
  reaction: DiscordReaction,
): Promise<{ totalReactions: number; userReactions: number }> {
  const guildId = reaction.guild_id!;
  const kind = "counters";
  const nowMs = Date.now();
  await executePostgresCommands(database, [
    {
      statement: `INSERT INTO gateway_reaction_limit_mutations
           (event_key, mutation_kind, result_one, result_two, created_at_ms)
         VALUES ($1, $2, NULL, NULL, $3) ON CONFLICT DO NOTHING`,
      values: [eventKey, kind, nowMs],
    },
    {
      statement: `INSERT INTO reaction_limit_message_reaction_counts
            (guild_id, channel_id, message_id, reaction_count, updated_at_ms)
          SELECT $1, $2, $3, 1, $4 WHERE EXISTS (
            SELECT 1 FROM gateway_reaction_limit_mutations
            WHERE event_key = $5 AND mutation_kind = $6 AND result_one IS NULL
          ) ON CONFLICT(guild_id, channel_id, message_id) DO UPDATE
          SET reaction_count = reaction_limit_message_reaction_counts.reaction_count + 1,
              updated_at_ms = excluded.updated_at_ms`,
      values: [guildId, reaction.channel_id, reaction.message_id, nowMs, eventKey, kind],
    },
    {
      statement: `INSERT INTO reaction_limit_user_message_reaction_counts
            (guild_id, channel_id, message_id, user_id, reaction_count, updated_at_ms)
          SELECT $1, $2, $3, $4, 1, $5 WHERE EXISTS (
            SELECT 1 FROM gateway_reaction_limit_mutations
            WHERE event_key = $6 AND mutation_kind = $7 AND result_one IS NULL
          ) ON CONFLICT(guild_id, channel_id, message_id, user_id) DO UPDATE
          SET reaction_count = reaction_limit_user_message_reaction_counts.reaction_count + 1,
              updated_at_ms = excluded.updated_at_ms`,
      values: [
        guildId,
        reaction.channel_id,
        reaction.message_id,
        reaction.user_id,
        nowMs,
        eventKey,
        kind,
      ],
    },
    {
      statement: `UPDATE gateway_reaction_limit_mutations SET
           result_one = (SELECT reaction_count FROM reaction_limit_message_reaction_counts
             WHERE guild_id = $1 AND channel_id = $2 AND message_id = $3),
           result_two = (SELECT reaction_count FROM reaction_limit_user_message_reaction_counts
             WHERE guild_id = $4 AND channel_id = $5 AND message_id = $6 AND user_id = $7)
         WHERE event_key = $8 AND mutation_kind = $9 AND result_one IS NULL`,
      values: [
        guildId,
        reaction.channel_id,
        reaction.message_id,
        guildId,
        reaction.channel_id,
        reaction.message_id,
        reaction.user_id,
        eventKey,
        kind,
      ],
    },
  ]);
  const result = await database
    .query<{ result_one: number; result_two: number }>(
      `SELECT result_one, result_two FROM gateway_reaction_limit_mutations
       WHERE event_key = $1 AND mutation_kind = $2`,
      [eventKey, kind],
    )
    .then((rows) => rows[0] ?? null);
  if (!result) throw new Error("Reaction counter mutation result was not persisted.");
  return { totalReactions: result.result_one, userReactions: result.result_two };
}

async function incrementReactionBreachOnce(
  database: PostgresDatabaseCapability,
  eventKey: string,
  guildId: string,
  userId: string,
): Promise<number> {
  const kind = "breach";
  await executePostgresCommands(database, [
    {
      statement: `INSERT INTO gateway_reaction_limit_mutations
           (event_key, mutation_kind, result_one, result_two, created_at_ms)
         VALUES ($1, $2, NULL, NULL, $3) ON CONFLICT DO NOTHING`,
      values: [eventKey, kind, Date.now()],
    },
    {
      statement: `INSERT INTO reaction_limit_breach_counters (guild_id, user_id, breach_count)
         SELECT $1, $2, 1 WHERE EXISTS (
           SELECT 1 FROM gateway_reaction_limit_mutations
           WHERE event_key = $3 AND mutation_kind = $4 AND result_one IS NULL
         ) ON CONFLICT(guild_id, user_id) DO UPDATE
         SET breach_count = reaction_limit_breach_counters.breach_count + 1`,
      values: [guildId, userId, eventKey, kind],
    },
    {
      statement: `UPDATE gateway_reaction_limit_mutations SET result_one = (
           SELECT breach_count FROM reaction_limit_breach_counters
           WHERE guild_id = $1 AND user_id = $2
         ) WHERE event_key = $3 AND mutation_kind = $4 AND result_one IS NULL`,
      values: [guildId, userId, eventKey, kind],
    },
  ]);
  const result = await database
    .query<{ result_one: number }>(
      `SELECT result_one FROM gateway_reaction_limit_mutations
       WHERE event_key = $1 AND mutation_kind = $2`,
      [eventKey, kind],
    )
    .then((rows) => rows[0] ?? null);
  if (!result) throw new Error("Reaction breach mutation result was not persisted.");
  return result.result_one;
}

async function resolveReactionTimedRoleExpiryOnce(
  database: PostgresDatabaseCapability,
  eventKey: string,
  durationMs: number,
): Promise<number> {
  const kind = "timed-role-expiry";
  await database.queryResult(
    `INSERT INTO gateway_reaction_limit_mutations
         (event_key, mutation_kind, result_one, result_two, created_at_ms)
       VALUES ($1, $2, $3, NULL, $4) ON CONFLICT DO NOTHING`,
    [eventKey, kind, Date.now() + durationMs, Date.now()],
  );
  const result = await database
    .query<{ result_one: number }>(
      `SELECT result_one FROM gateway_reaction_limit_mutations
       WHERE event_key = $1 AND mutation_kind = $2`,
      [eventKey, kind],
    )
    .then((rows) => rows[0] ?? null);
  if (!result) throw new Error("Reaction timed-role expiry was not persisted.");
  return result.result_one;
}
