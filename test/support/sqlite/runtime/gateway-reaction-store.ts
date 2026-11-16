import type { DiscordReaction } from "../../../../src/types";
import type { GatewayReactionStore } from "../../../../src/runtime/contracts/gateway-reaction-store";
export function createGatewayReactionStore(database: D1Database): GatewayReactionStore {
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
