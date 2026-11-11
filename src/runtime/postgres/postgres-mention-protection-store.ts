import type { PostgresDatabaseCapability } from "./postgres-capability";
import type { PostgresCommand } from "./postgres-statements";
import { and, eq, gte, lt, lte, sql } from "drizzle-orm";
import {
  mentionProtectionActionOutcomes,
  mentionProtectionBreaches,
  mentionProtectionBurstEvents,
  mentionProtectionConfigs,
} from "../../db/postgres/app-schema";
import type {
  MentionProtectionBreach,
  MentionProtectionConfig,
  MentionProtectionResponsePolicy,
} from "../../types";
import { isRecord } from "../../unknown-parse";
import { createDefaultMentionProtectionConfig } from "../../services/mention-protection/message-handler";
import type { MentionProtectionStore } from "../contracts/mention-protection-store";

type ConfigRow = typeof mentionProtectionConfigs.$inferSelect;

const ENFORCEMENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const CONFIG_LOCK_NAMESPACE = 7_308_201;
const BURST_LOCK_NAMESPACE = 7_308_203;

export function createPostgresMentionProtectionStore(
  database: PostgresDatabaseCapability,
): MentionProtectionStore {
  const db = database.drizzle;

  const store: MentionProtectionStore = {
    async readConfig(guildId) {
      const row = await db
        .select()
        .from(mentionProtectionConfigs)
        .where(eq(mentionProtectionConfigs.guildId, guildId))
        .limit(1)
        .then((rows) => rows[0]);
      return row ? rowToConfig(row) : createDefaultMentionProtectionConfig(guildId);
    },

    async upsertConfig(config) {
      const values = configToRow(config);
      await db.transaction(async (transaction) => {
        await lockConfig(transaction, config.guildId);
        const row = await transaction
          .select()
          .from(mentionProtectionConfigs)
          .where(eq(mentionProtectionConfigs.guildId, config.guildId))
          .limit(1)
          .then((rows) => rows[0]);
        const previous = row
          ? rowToConfig(row)
          : createDefaultMentionProtectionConfig(config.guildId);
        await transaction
          .insert(mentionProtectionConfigs)
          .values(values)
          .onConflictDoUpdate({
            target: mentionProtectionConfigs.guildId,
            set: {
              adminEnabled: values.adminEnabled,
              spamEnabled: values.spamEnabled,
              protectedAdminRoleIdsJson: values.protectedAdminRoleIdsJson,
              channelMode: values.channelMode,
              channelIdsJson: values.channelIdsJson,
              excludedRoleIdsJson: values.excludedRoleIdsJson,
              massMentionThreshold: values.massMentionThreshold,
              burstMessageThreshold: values.burstMessageThreshold,
              burstWindowSeconds: values.burstWindowSeconds,
              adminRepeatPeriodMs: values.adminRepeatPeriodMs,
              spamRepeatPeriodMs: values.spamRepeatPeriodMs,
              adminInitialResponseJson: values.adminInitialResponseJson,
              adminRepeatResponseJson: values.adminRepeatResponseJson,
              spamInitialResponseJson: values.spamInitialResponseJson,
              spamRepeatResponseJson: values.spamRepeatResponseJson,
              updatedAtMs: values.updatedAtMs,
            },
          })
          .execute();
        if (burstConfigurationChanged(previous, config)) {
          await clearBurstWindow(transaction, config.guildId);
        }
      });
    },

    async deleteConfig(guildId) {
      await db.transaction(async (transaction) => {
        await lockConfig(transaction, guildId);
        await transaction
          .delete(mentionProtectionConfigs)
          .where(eq(mentionProtectionConfigs.guildId, guildId))
          .execute();
        await clearBurstWindow(transaction, guildId);
      });
    },

    async clearBurstWindow(guildId) {
      await db.transaction(async (transaction) => {
        await lockConfig(transaction, guildId);
        await clearBurstWindow(transaction, guildId);
      });
    },

    async recordBurstMessage(input) {
      const cutoff = input.messageTimestampMs - input.windowMs;
      return db.transaction(async (transaction) => {
        // Configuration replacement clears every member's burst window.
        // Burst recordings share the guild lock; replacements take it exclusively.
        await lockConfig(transaction, input.guildId, "shared");
        await lockBurstWindow(transaction, input.guildId, input.userId);
        await transaction
          .insert(mentionProtectionBurstEvents)
          .values({
            guildId: input.guildId,
            userId: input.userId,
            messageId: input.messageId,
            messageTimestampMs: input.messageTimestampMs,
          })
          .onConflictDoNothing()
          .execute();
        await transaction
          .delete(mentionProtectionBurstEvents)
          .where(
            and(
              eq(mentionProtectionBurstEvents.guildId, input.guildId),
              eq(mentionProtectionBurstEvents.userId, input.userId),
              lt(mentionProtectionBurstEvents.messageTimestampMs, cutoff),
            ),
          )
          .execute();
        const row = await transaction
          .select({ count: sql<number>`count(*)::integer` })
          .from(mentionProtectionBurstEvents)
          .where(
            and(
              eq(mentionProtectionBurstEvents.guildId, input.guildId),
              eq(mentionProtectionBurstEvents.userId, input.userId),
              gte(mentionProtectionBurstEvents.messageTimestampMs, cutoff),
              lte(mentionProtectionBurstEvents.messageTimestampMs, input.messageTimestampMs),
            ),
          )
          .then((rows) => rows[0] ?? null);
        return row?.count ?? 0;
      });
    },

    async claimMessageBreaches(input) {
      const retentionCutoff = input.nowMs - ENFORCEMENT_RETENTION_MS;
      await db
        .delete(mentionProtectionActionOutcomes)
        .where(
          and(
            eq(mentionProtectionActionOutcomes.guildId, input.guildId),
            lt(mentionProtectionActionOutcomes.updatedAtMs, retentionCutoff),
          ),
        )
        .execute();
      await db
        .delete(mentionProtectionBreaches)
        .where(
          and(
            eq(mentionProtectionBreaches.guildId, input.guildId),
            lt(mentionProtectionBreaches.breachedAtMs, retentionCutoff),
          ),
        )
        .execute();
      await database.transaction(async (transaction) => {
        for (const detection of input.detections) {
          const cutoff = input.nowMs - detection.repeatPeriodMs;
          const [breach, escalation]: PostgresCommand[] = [
            {
              statement: `INSERT INTO mention_protection_breaches (
                guild_id, message_id, user_id, channel_id, protection, condition, stage,
                response_policy_json, evidence_json, content_snapshot,
                message_created_at_ms, breached_at_ms
              )
              SELECT $1, $2, $3, $4, $5, $6,
                CASE WHEN EXISTS (
                  SELECT 1 FROM mention_protection_escalations
                  WHERE guild_id = $7 AND user_id = $8 AND protection = $9
                    AND last_breach_at_ms >= $10
                ) THEN 'repeat' ELSE 'initial' END,
                CASE WHEN EXISTS (
                  SELECT 1 FROM mention_protection_escalations
                  WHERE guild_id = $11 AND user_id = $12 AND protection = $13
                    AND last_breach_at_ms >= $14
                ) THEN $15 ELSE $16 END,
                $17, $18, $19, $20 ON CONFLICT DO NOTHING`,
              values: [
                input.guildId,
                input.messageId,
                input.userId,
                input.channelId,
                detection.protection,
                detection.condition,
                input.guildId,
                input.userId,
                detection.protection,
                cutoff,
                input.guildId,
                input.userId,
                detection.protection,
                cutoff,
                JSON.stringify(detection.repeatResponse),
                JSON.stringify(detection.initialResponse),
                JSON.stringify(detection.evidence),
                input.contentSnapshot,
                input.messageCreatedAtMs,
                input.nowMs,
              ],
            },
            {
              statement: `INSERT INTO mention_protection_escalations
                (guild_id, user_id, protection, last_breach_at_ms)
              SELECT $1, $2, $3, $4
              ON CONFLICT (guild_id, user_id, protection) DO UPDATE SET
                last_breach_at_ms = GREATEST(mention_protection_escalations.last_breach_at_ms, excluded.last_breach_at_ms)`,
              values: [input.guildId, input.userId, detection.protection, input.nowMs],
            },
          ];
          await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `${input.guildId}:${input.userId}:${detection.protection}`,
          ]);
          const changed = await transaction.execute(breach!.statement, breach!.values);
          if (changed > 0) await transaction.execute(escalation!.statement, escalation!.values);
        }
      });
      const result = await database.queryResult(
        `SELECT * FROM mention_protection_breaches
           WHERE guild_id = $1 AND message_id = $2
           ORDER BY CASE protection WHEN 'admin' THEN 0 ELSE 1 END`,
        [input.guildId, input.messageId],
      );
      return (result.rows ?? []).map(rowToBreach).filter(isPresent);
    },

    async claimAction(guildId, messageId, action, nowMs = Date.now()) {
      const row = await database
        .query(
          `INSERT INTO mention_protection_action_outcomes
            (guild_id, message_id, action, status, updated_at_ms)
           VALUES ($1, $2, $3, 'pending', $4)
           ON CONFLICT (guild_id, message_id, action) DO UPDATE SET
             status = 'pending', detail = NULL, updated_at_ms = excluded.updated_at_ms,
             attempt_count = mention_protection_action_outcomes.attempt_count + 1
           WHERE mention_protection_action_outcomes.attempt_count < 3 AND (
             (mention_protection_action_outcomes.status = 'failed' AND
              mention_protection_action_outcomes.retryable = 1) OR
             (mention_protection_action_outcomes.status = 'pending' AND
              mention_protection_action_outcomes.updated_at_ms <= $5)
           )
           RETURNING action`,
          [guildId, messageId, action, nowMs, nowMs - 60_000],
        )
        .then((rows) => rows[0] ?? null);
      if (row !== null) return "claimed";
      const outcome = await db
        .select({
          status: mentionProtectionActionOutcomes.status,
          updatedAtMs: mentionProtectionActionOutcomes.updatedAtMs,
          attemptCount: mentionProtectionActionOutcomes.attemptCount,
          retryable: mentionProtectionActionOutcomes.retryable,
        })
        .from(mentionProtectionActionOutcomes)
        .where(
          and(
            eq(mentionProtectionActionOutcomes.guildId, guildId),
            eq(mentionProtectionActionOutcomes.messageId, messageId),
            eq(mentionProtectionActionOutcomes.action, action),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      return outcome?.status === "pending" && outcome.updatedAtMs > nowMs - 60_000
        ? "deferred"
        : "satisfied";
    },

    async recordActionOutcome(outcome) {
      await db
        .insert(mentionProtectionActionOutcomes)
        .values({
          guildId: outcome.guildId,
          messageId: outcome.messageId,
          action: outcome.action,
          status: outcome.status,
          detail: outcome.detail ?? null,
          retryable: outcome.retryable ?? false,
          updatedAtMs: outcome.updatedAtMs,
        })
        .onConflictDoUpdate({
          target: [
            mentionProtectionActionOutcomes.guildId,
            mentionProtectionActionOutcomes.messageId,
            mentionProtectionActionOutcomes.action,
          ],
          set: {
            status: outcome.status,
            detail: outcome.detail ?? null,
            retryable: outcome.retryable ?? false,
            updatedAtMs: outcome.updatedAtMs,
          },
        })
        .execute();
    },
  };

  return store;
}

function configToRow(
  config: MentionProtectionConfig,
): typeof mentionProtectionConfigs.$inferInsert {
  return {
    guildId: config.guildId,
    adminEnabled: config.adminEnabled,
    spamEnabled: config.spamEnabled,
    protectedAdminRoleIdsJson: JSON.stringify(config.protectedAdminRoleIds),
    channelMode: config.channelMode,
    channelIdsJson: JSON.stringify(config.channelIds),
    excludedRoleIdsJson: JSON.stringify(config.excludedRoleIds),
    massMentionThreshold: config.massMentionThreshold,
    burstMessageThreshold: config.burstMessageThreshold,
    burstWindowSeconds: config.burstWindowSeconds,
    adminRepeatPeriodMs: config.adminRepeatPeriodMs,
    spamRepeatPeriodMs: config.spamRepeatPeriodMs,
    adminInitialResponseJson: JSON.stringify(config.adminInitialResponse),
    adminRepeatResponseJson: JSON.stringify(config.adminRepeatResponse),
    spamInitialResponseJson: JSON.stringify(config.spamInitialResponse),
    spamRepeatResponseJson: JSON.stringify(config.spamRepeatResponse),
    createdAtMs: config.createdAtMs,
    updatedAtMs: config.updatedAtMs,
  };
}

function rowToConfig(row: ConfigRow): MentionProtectionConfig {
  const defaults = createDefaultMentionProtectionConfig(row.guildId, row.createdAtMs);
  return {
    ...defaults,
    guildId: row.guildId,
    adminEnabled: row.adminEnabled,
    spamEnabled: row.spamEnabled,
    protectedAdminRoleIds: parseStringArray(row.protectedAdminRoleIdsJson),
    channelMode: row.channelMode === "include" ? "include" : "exclude",
    channelIds: parseStringArray(row.channelIdsJson),
    excludedRoleIds: parseStringArray(row.excludedRoleIdsJson),
    massMentionThreshold: row.massMentionThreshold,
    burstMessageThreshold: row.burstMessageThreshold,
    burstWindowSeconds: row.burstWindowSeconds,
    adminRepeatPeriodMs: row.adminRepeatPeriodMs,
    spamRepeatPeriodMs: row.spamRepeatPeriodMs,
    adminInitialResponse: parsePolicy(row.adminInitialResponseJson, defaults.adminInitialResponse),
    adminRepeatResponse: parsePolicy(row.adminRepeatResponseJson, defaults.adminRepeatResponse),
    spamInitialResponse: parsePolicy(row.spamInitialResponseJson, defaults.spamInitialResponse),
    spamRepeatResponse: parsePolicy(row.spamRepeatResponseJson, defaults.spamRepeatResponse),
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function rowToBreach(row: Record<string, unknown>): MentionProtectionBreach | null {
  const protection = row.protection;
  const condition = row.condition;
  const stage = row.stage;
  if (
    (protection !== "admin" && protection !== "spam") ||
    !["admin-mention", "mass-mention", "mention-burst", "mass-and-burst"].includes(
      String(condition),
    ) ||
    (stage !== "initial" && stage !== "repeat")
  ) {
    return null;
  }
  return {
    guildId: String(row.guild_id),
    messageId: String(row.message_id),
    userId: String(row.user_id),
    channelId: String(row.channel_id),
    protection,
    condition: condition as MentionProtectionBreach["condition"],
    stage,
    responsePolicy: parsePolicy(String(row.response_policy_json), {
      reply: true,
      delete: false,
      restriction: { type: "none" },
    }),
    evidence: parseRecord(String(row.evidence_json)),
    contentSnapshot: String(row.content_snapshot ?? ""),
    messageCreatedAtMs: Number(row.message_created_at_ms),
    breachedAtMs: Number(row.breached_at_ms),
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parsePolicy(
  value: string,
  fallback: MentionProtectionResponsePolicy,
): MentionProtectionResponsePolicy {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.reply !== "boolean" ||
      typeof parsed.delete !== "boolean"
    ) {
      return fallback;
    }
    const restriction = parsed.restriction;
    if (!isRecord(restriction) || typeof restriction.type !== "string") return fallback;
    if (restriction.type === "none")
      return { reply: parsed.reply, delete: parsed.delete, restriction: { type: "none" } };
    if (restriction.type === "timeout" && typeof restriction.durationMs === "number") {
      return {
        reply: parsed.reply,
        delete: parsed.delete,
        restriction: { type: "timeout", durationMs: restriction.durationMs },
      };
    }
    if (
      restriction.type === "timed-role" &&
      typeof restriction.roleId === "string" &&
      typeof restriction.durationMs === "number"
    ) {
      return {
        reply: parsed.reply,
        delete: parsed.delete,
        restriction: {
          type: "timed-role",
          roleId: restriction.roleId,
          durationMs: restriction.durationMs,
        },
      };
    }
  } catch {
    // Use the safe policy supplied by the caller.
  }
  return fallback;
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

type MentionProtectionTransaction = Parameters<
  Parameters<PostgresDatabaseCapability["drizzle"]["transaction"]>[0]
>[0];

async function lockConfig(
  transaction: MentionProtectionTransaction,
  guildId: string,
  mode: "shared" | "exclusive" = "exclusive",
): Promise<void> {
  const key = `mention-protection-config:${guildId}`;
  await transaction.execute(
    mode === "shared"
      ? sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, ${CONFIG_LOCK_NAMESPACE}))`
      : sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, ${CONFIG_LOCK_NAMESPACE}))`,
  );
}

async function lockBurstWindow(
  transaction: MentionProtectionTransaction,
  guildId: string,
  userId: string,
): Promise<void> {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mention-protection-burst:${guildId}:${userId}`}, ${BURST_LOCK_NAMESPACE}))`,
  );
}

async function clearBurstWindow(
  transaction: MentionProtectionTransaction,
  guildId: string,
): Promise<void> {
  await transaction
    .delete(mentionProtectionBurstEvents)
    .where(eq(mentionProtectionBurstEvents.guildId, guildId))
    .execute();
}

function burstConfigurationChanged(
  previous: MentionProtectionConfig,
  next: MentionProtectionConfig,
): boolean {
  return (
    previous.spamEnabled !== next.spamEnabled ||
    previous.massMentionThreshold !== next.massMentionThreshold ||
    previous.burstMessageThreshold !== next.burstMessageThreshold ||
    previous.burstWindowSeconds !== next.burstWindowSeconds ||
    previous.channelMode !== next.channelMode ||
    JSON.stringify(previous.channelIds) !== JSON.stringify(next.channelIds) ||
    JSON.stringify(previous.excludedRoleIds) !== JSON.stringify(next.excludedRoleIds)
  );
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
