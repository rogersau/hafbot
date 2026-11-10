import { and, eq, lt } from "drizzle-orm";
import {
  mentionProtectionActionOutcomes,
  mentionProtectionBreaches,
  mentionProtectionBurstEvents,
  mentionProtectionConfigs,
} from "../db/app-schema";
import type {
  MentionProtectionBreach,
  MentionProtectionConfig,
  MentionProtectionResponsePolicy,
} from "../types";
import { isRecord } from "../unknown-parse";
import { createDefaultMentionProtectionConfig } from "../services/mention-protection/message-handler";
import type { MentionProtectionStore } from "./contracts/mention-protection-store";
import { createD1DrizzleDatabase } from "./drizzle-db";

type ConfigRow = typeof mentionProtectionConfigs.$inferSelect;

const storeCache = new WeakMap<D1Database, MentionProtectionStore>();
const ENFORCEMENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export function createCloudflareMentionProtectionStore(
  database: D1Database,
): MentionProtectionStore {
  const cached = storeCache.get(database);
  if (cached) return cached;
  const db = createD1DrizzleDatabase(database);

  const store: MentionProtectionStore = {
    async readConfig(guildId) {
      const row = await db
        .select()
        .from(mentionProtectionConfigs)
        .where(eq(mentionProtectionConfigs.guildId, guildId))
        .limit(1)
        .get();
      return row ? rowToConfig(row) : createDefaultMentionProtectionConfig(guildId);
    },

    async upsertConfig(config) {
      const previous = await store.readConfig(config.guildId);
      const values = configToRow(config);
      await db
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
        .run();
      if (previous && burstConfigurationChanged(previous, config)) {
        await store.clearBurstWindow(config.guildId);
      }
    },

    async deleteConfig(guildId) {
      await db
        .delete(mentionProtectionConfigs)
        .where(eq(mentionProtectionConfigs.guildId, guildId))
        .run();
      await store.clearBurstWindow(guildId);
    },

    async clearBurstWindow(guildId) {
      await db
        .delete(mentionProtectionBurstEvents)
        .where(eq(mentionProtectionBurstEvents.guildId, guildId))
        .run();
    },

    async recordBurstMessage(input) {
      const cutoff = input.messageTimestampMs - input.windowMs;
      await database.batch([
        database
          .prepare(
            "INSERT OR IGNORE INTO mention_protection_burst_events " +
              "(guild_id, user_id, message_id, message_timestamp_ms) VALUES (?, ?, ?, ?)",
          )
          .bind(input.guildId, input.userId, input.messageId, input.messageTimestampMs),
        database
          .prepare(
            "DELETE FROM mention_protection_burst_events " +
              "WHERE guild_id = ? AND user_id = ? AND message_timestamp_ms < ?",
          )
          .bind(input.guildId, input.userId, cutoff),
      ]);
      const row = await database
        .prepare(
          "SELECT COUNT(*) AS count FROM mention_protection_burst_events " +
            "WHERE guild_id = ? AND user_id = ? AND message_timestamp_ms >= ? " +
            "AND message_timestamp_ms <= ?",
        )
        .bind(input.guildId, input.userId, cutoff, input.messageTimestampMs)
        .first<{ count?: unknown }>();
      return typeof row?.count === "number" ? row.count : Number(row?.count ?? 0);
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
        .run();
      await db
        .delete(mentionProtectionBreaches)
        .where(
          and(
            eq(mentionProtectionBreaches.guildId, input.guildId),
            lt(mentionProtectionBreaches.breachedAtMs, retentionCutoff),
          ),
        )
        .run();
      const statements: D1PreparedStatement[] = [];
      for (const detection of input.detections) {
        const cutoff = input.nowMs - detection.repeatPeriodMs;
        statements.push(
          database
            .prepare(
              `INSERT OR IGNORE INTO mention_protection_breaches (
                guild_id, message_id, user_id, channel_id, protection, condition, stage,
                response_policy_json, evidence_json, content_snapshot,
                message_created_at_ms, breached_at_ms
              )
              SELECT ?, ?, ?, ?, ?, ?,
                CASE WHEN EXISTS (
                  SELECT 1 FROM mention_protection_escalations
                  WHERE guild_id = ? AND user_id = ? AND protection = ?
                    AND last_breach_at_ms >= ?
                ) THEN 'repeat' ELSE 'initial' END,
                CASE WHEN EXISTS (
                  SELECT 1 FROM mention_protection_escalations
                  WHERE guild_id = ? AND user_id = ? AND protection = ?
                    AND last_breach_at_ms >= ?
                ) THEN ? ELSE ? END,
                ?, ?, ?, ?`,
            )
            .bind(
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
            ),
          database
            .prepare(
              `INSERT INTO mention_protection_escalations
                (guild_id, user_id, protection, last_breach_at_ms)
              SELECT ?, ?, ?, ? WHERE changes() > 0
              ON CONFLICT (guild_id, user_id, protection) DO UPDATE SET
                last_breach_at_ms = MAX(last_breach_at_ms, excluded.last_breach_at_ms)`,
            )
            .bind(input.guildId, input.userId, detection.protection, input.nowMs),
        );
      }
      await database.batch(statements);
      const result = await database
        .prepare(
          `SELECT * FROM mention_protection_breaches
           WHERE guild_id = ? AND message_id = ?
           ORDER BY CASE protection WHEN 'admin' THEN 0 ELSE 1 END`,
        )
        .bind(input.guildId, input.messageId)
        .all();
      return (result.results ?? []).map(rowToBreach).filter(isPresent);
    },

    async claimAction(guildId, messageId, action, nowMs = Date.now()) {
      const row = await database
        .prepare(
          `INSERT INTO mention_protection_action_outcomes
            (guild_id, message_id, action, status, updated_at_ms)
           VALUES (?, ?, ?, 'pending', ?)
           ON CONFLICT (guild_id, message_id, action) DO UPDATE SET
             status = 'pending', detail = NULL, updated_at_ms = excluded.updated_at_ms,
             attempt_count = mention_protection_action_outcomes.attempt_count + 1
           WHERE mention_protection_action_outcomes.attempt_count < 3 AND (
             (mention_protection_action_outcomes.status = 'failed' AND
              mention_protection_action_outcomes.retryable = 1) OR
             (mention_protection_action_outcomes.status = 'pending' AND
              mention_protection_action_outcomes.updated_at_ms <= ?)
           )
           RETURNING action`,
        )
        .bind(guildId, messageId, action, nowMs, nowMs - 60_000)
        .first();
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
        .get();
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
        .run();
    },
  };

  storeCache.set(database, store);
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
