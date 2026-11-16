import { eq } from "drizzle-orm";
import { guildAuditLogConfigs } from "../../db/postgres/app-schema";
import type { AuditEventGroupId, GuildAuditLogConfig, AuditEventStates } from "../../types";
import type { GuildAuditLogStore } from "../contracts/guild-audit-log-store";
import type { PostgresDatabaseCapability } from "./postgres-capability";
import { isRecord } from "../../unknown-parse";

type ConfigRow = typeof guildAuditLogConfigs.$inferSelect;
type ConfigInsert = typeof guildAuditLogConfigs.$inferInsert;

export function createPostgresGuildAuditLogStore(
  database: PostgresDatabaseCapability,
): GuildAuditLogStore {
  const db = database.drizzle;
  const store: GuildAuditLogStore = {
    async readConfig(guildId) {
      const row = await db
        .select()
        .from(guildAuditLogConfigs)
        .where(eq(guildAuditLogConfigs.guildId, guildId))
        .limit(1)
        .then((rows) => rows[0]);
      return row ? mapConfigRow(row) : null;
    },

    async upsertConfig(config) {
      const values = configToRow(config);
      await db
        .insert(guildAuditLogConfigs)
        .values(values)
        .onConflictDoUpdate({
          target: guildAuditLogConfigs.guildId,
          set: {
            auditChannelId: values.auditChannelId,
            groupChannelIdsJson: values.groupChannelIdsJson,
            eventStatesJson: values.eventStatesJson,
            excludedChannelIdsJson: values.excludedChannelIdsJson,
            excludedRoleIdsJson: values.excludedRoleIdsJson,
            updatedAtMs: values.updatedAtMs,
          },
        })
        .execute();
    },
  };

  return store;
}

function mapConfigRow(row: ConfigRow): GuildAuditLogConfig {
  return {
    guildId: row.guildId,
    auditChannelId: row.auditChannelId,
    groupChannelIds: parseGroupChannelIds(row.groupChannelIdsJson),
    eventStates: parseEventStates(row.eventStatesJson),
    excludedChannelIds: parseIdList(row.excludedChannelIdsJson),
    excludedRoleIds: parseIdList(row.excludedRoleIdsJson),
    updatedAtMs: row.updatedAtMs,
  };
}

function configToRow(config: GuildAuditLogConfig): ConfigInsert {
  return {
    guildId: config.guildId,
    auditChannelId: config.auditChannelId,
    groupChannelIdsJson: JSON.stringify(config.groupChannelIds),
    eventStatesJson: JSON.stringify(config.eventStates),
    excludedChannelIdsJson: JSON.stringify(config.excludedChannelIds ?? []),
    excludedRoleIdsJson: JSON.stringify(config.excludedRoleIds ?? []),
    updatedAtMs: config.updatedAtMs,
  };
}

function parseIdList(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed.filter(
              (value): value is string => typeof value === "string" && value.length > 0,
            ),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

function parseGroupChannelIds(json: string): Partial<Record<AuditEventGroupId, string>> {
  try {
    const parsed = JSON.parse(json) as Partial<Record<AuditEventGroupId, string>>;
    if (!isRecord(parsed)) return {};
    const result: Partial<Record<AuditEventGroupId, string>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.length > 0) {
        result[key as AuditEventGroupId] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function parseEventStates(json: string): AuditEventStates {
  try {
    const parsed = JSON.parse(json) as AuditEventStates;
    return {
      groups: isRecord(parsed.groups) ? (parsed.groups as AuditEventStates["groups"]) : {},
      overrides: isRecord(parsed.overrides)
        ? (parsed.overrides as AuditEventStates["overrides"])
        : {},
    };
  } catch {
    return { groups: {}, overrides: {} };
  }
}
