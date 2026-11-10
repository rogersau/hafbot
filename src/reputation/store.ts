import type {
  PostgresDatabaseCapability,
  PostgresExecutor,
} from "../runtime/postgres/postgres-capability";
import {
  assertReputationEligibility,
  defaultReputationConfig,
  ReputationError,
  reputationSettingsSchema,
  type ReputationAwardInput,
  type ReputationConfig,
  type ReputationSettings,
  type ReputationStore,
} from "./types";

type ConfigRow = { settings_json: unknown; revision: number };
type AwardRow = { giver_id: string | null; recipient_id: string | null; total_score: number };
const configFromRow = (guildId: string, row: ConfigRow): ReputationConfig => ({
  ...reputationSettingsSchema.parse(row.settings_json),
  guildId,
  revision: Number(row.revision),
});

export function createPostgresReputationStore(
  database: PostgresDatabaseCapability,
): ReputationStore {
  async function getConfig(guildId: string) {
    const [row] = await database.query<ConfigRow>(
      "SELECT settings_json, revision FROM reputation_configs WHERE guild_id = $1",
      [guildId],
    );
    return row ? configFromRow(guildId, row) : defaultReputationConfig(guildId);
  }
  return {
    getConfig,
    async saveConfig(guildId, input, expectedRevision) {
      const settings = reputationSettingsSchema.parse(input);
      return database.transaction(async (tx) => {
        const initial = defaultReputationConfig(guildId);
        await tx.execute(
          "INSERT INTO reputation_configs(guild_id, settings_json) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING",
          [guildId, JSON.stringify(initial)],
        );
        const [row] = await tx.query<ConfigRow>(
          `UPDATE reputation_configs SET settings_json = $2::jsonb, revision = revision + 1
          WHERE guild_id = $1 AND revision = $3 RETURNING settings_json, revision`,
          [guildId, JSON.stringify(settings), expectedRevision],
        );
        if (!row)
          throw new ReputationError(
            "Reputation settings changed. Reload the page before saving.",
            "conflict",
          );
        await tx.execute(
          `DELETE FROM reputation_reward_jobs WHERE guild_id = $1 AND role_id NOT IN
          (SELECT value->>'roleId' FROM jsonb_array_elements($2::jsonb) AS value)`,
          [guildId, JSON.stringify(settings.rewards)],
        );
        await enqueueEligibleRewards(tx, guildId, settings);
        return configFromRow(guildId, row);
      });
    },
    async award(input) {
      return database.transaction(async (tx) => {
        const [configRow] = await tx.query<ConfigRow>(
          "SELECT settings_json, revision FROM reputation_configs WHERE guild_id = $1 FOR SHARE",
          [input.guildId],
        );
        const config = configRow
          ? configFromRow(input.guildId, configRow)
          : defaultReputationConfig(input.guildId);
        const [existing] = await tx.query<AwardRow>(
          "SELECT giver_id, recipient_id, total_score FROM reputation_awards WHERE guild_id = $1 AND interaction_id = $2",
          [input.guildId, input.interactionId],
        );
        if (existing) return duplicateAward(existing, input);
        assertReputationEligibility(config, input);
        const inserted = await tx.query<{ interaction_id: string }>(
          `INSERT INTO reputation_awards
          (guild_id, interaction_id, giver_id, recipient_id, reason, created_at_ms) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT DO NOTHING RETURNING interaction_id`,
          [
            input.guildId,
            input.interactionId,
            input.giver.userId,
            input.recipient.userId,
            input.reason,
            input.nowMs,
          ],
        );
        if (!inserted.length) {
          const [previous] = await tx.query<AwardRow>(
            "SELECT giver_id, recipient_id, total_score FROM reputation_awards WHERE guild_id = $1 AND interaction_id = $2",
            [input.guildId, input.interactionId],
          );
          if (!previous)
            throw new ReputationError(
              "This reputation request could not be recovered.",
              "conflict",
            );
          return duplicateAward(previous, input);
        }
        const cooldown = await tx.query<{ giver_id: string }>(
          `INSERT INTO reputation_cooldowns(guild_id, giver_id, next_award_at_ms)
          VALUES ($1,$2,$3) ON CONFLICT (guild_id, giver_id) DO UPDATE SET next_award_at_ms = EXCLUDED.next_award_at_ms
          WHERE reputation_cooldowns.next_award_at_ms <= $4 RETURNING giver_id`,
          [
            input.guildId,
            input.giver.userId,
            input.nowMs + config.cooldownSeconds * 1000,
            input.nowMs,
          ],
        );
        if (!cooldown.length)
          throw new ReputationError(
            "Wait for your reputation cooldown before thanking another member.",
            "cooldown",
          );
        const [score] = await tx.query<{ score: number }>(
          `INSERT INTO reputation_scores(guild_id, user_id, score) VALUES ($1,$2,1)
          ON CONFLICT (guild_id,user_id) DO UPDATE SET score = reputation_scores.score + 1, current_member = TRUE RETURNING score`,
          [input.guildId, input.recipient.userId],
        );
        const total = Number(score!.score);
        await tx.execute(
          "UPDATE reputation_awards SET total_score = $3 WHERE guild_id = $1 AND interaction_id = $2",
          [input.guildId, input.interactionId, total],
        );
        await enqueueEligibleRewards(tx, input.guildId, config, input.recipient.userId);
        return {
          interactionId: input.interactionId,
          recipientId: input.recipient.userId,
          total,
          duplicate: false,
        };
      });
    },
    async score(guildId, userId) {
      const [row] = await database.query<{ score: number }>(
        "SELECT score FROM reputation_scores WHERE guild_id = $1 AND user_id = $2",
        [guildId, userId],
      );
      return Number(row?.score ?? 0);
    },
    async topScores(guildId, limit) {
      const rows = await database.query<{ user_id: string; score: number }>(
        "SELECT user_id, score FROM reputation_scores WHERE guild_id = $1 AND current_member ORDER BY score DESC, user_id LIMIT $2",
        [guildId, Math.min(100, Math.max(1, limit))],
      );
      return rows.map((row) => ({ userId: row.user_id, total: Number(row.score) }));
    },
    async setMembership(guildId, userId, current) {
      await database.execute(
        "UPDATE reputation_scores SET current_member = $3 WHERE guild_id = $1 AND user_id = $2",
        [guildId, userId, current],
      );
    },
    async pendingRewards(nowMs, limit, guildId) {
      const rows = await database.query<{
        guild_id: string;
        user_id: string;
        role_id: string;
        threshold: number;
      }>(
        `SELECT jobs.guild_id, jobs.user_id, jobs.role_id, jobs.threshold
        FROM reputation_reward_jobs jobs JOIN reputation_configs config ON config.guild_id = jobs.guild_id
        WHERE jobs.delivered_at_ms IS NULL AND jobs.next_attempt_at_ms <= $1 AND config.settings_json->>'enabled' = 'true'
          AND ($3::text IS NULL OR jobs.guild_id = $3) ORDER BY jobs.next_attempt_at_ms, jobs.guild_id, jobs.user_id LIMIT $2`,
        [nowMs, Math.min(100, Math.max(1, limit)), guildId ?? null],
      );
      return rows.map((row) => ({
        guildId: row.guild_id,
        userId: row.user_id,
        roleId: row.role_id,
        threshold: Number(row.threshold),
      }));
    },
    async completeReward(job, nowMs) {
      await database.execute(
        "UPDATE reputation_reward_jobs SET delivered_at_ms = $4 WHERE guild_id = $1 AND user_id = $2 AND role_id = $3",
        [job.guildId, job.userId, job.roleId, nowMs],
      );
    },
    async deferReward(job, nextAttemptAtMs) {
      await database.execute(
        "UPDATE reputation_reward_jobs SET next_attempt_at_ms = $4 WHERE guild_id = $1 AND user_id = $2 AND role_id = $3 AND delivered_at_ms IS NULL",
        [job.guildId, job.userId, job.roleId, nextAttemptAtMs],
      );
    },
    async eraseMember(guildId, userId) {
      await database.transaction(async (tx) => {
        await tx.execute("DELETE FROM reputation_scores WHERE guild_id = $1 AND user_id = $2", [
          guildId,
          userId,
        ]);
        await tx.execute("DELETE FROM reputation_cooldowns WHERE guild_id = $1 AND giver_id = $2", [
          guildId,
          userId,
        ]);
        await tx.execute(
          "DELETE FROM reputation_reward_jobs WHERE guild_id = $1 AND user_id = $2",
          [guildId, userId],
        );
        // Keep event receipts as anonymous tombstones so old interactions cannot award again.
        await tx.execute(
          "UPDATE reputation_awards SET giver_id = NULL, recipient_id = NULL, reason = NULL WHERE guild_id = $1 AND (giver_id = $2 OR recipient_id = $2)",
          [guildId, userId],
        );
      });
    },
  };
}

async function enqueueEligibleRewards(
  tx: PostgresExecutor,
  guildId: string,
  settings: ReputationSettings,
  userId?: string,
) {
  for (const reward of settings.rewards) {
    await tx.execute(
      `INSERT INTO reputation_reward_jobs(guild_id,user_id,role_id,threshold)
      SELECT guild_id,user_id,$2,$3 FROM reputation_scores WHERE guild_id = $1 AND score >= $3 AND current_member
      AND ($4::text IS NULL OR user_id = $4) ON CONFLICT (guild_id,user_id,role_id) DO UPDATE SET threshold = EXCLUDED.threshold`,
      [guildId, reward.roleId, reward.threshold, userId ?? null],
    );
  }
}

function duplicateAward(previous: AwardRow, input: ReputationAwardInput) {
  if (previous.giver_id !== input.giver.userId || previous.recipient_id !== input.recipient.userId)
    throw new ReputationError(
      "This reputation request has already been used or erased.",
      "conflict",
    );
  return {
    interactionId: input.interactionId,
    recipientId: previous.recipient_id,
    total: Number(previous.total_score),
    duplicate: true,
  };
}
