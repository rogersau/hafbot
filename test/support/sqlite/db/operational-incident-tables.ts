import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
export function operationalIncidentTables(prefix = "") {
  const operationalIncidents = sqliteTable(
    `${prefix}operational_incidents`,
    {
      id: text("id").primaryKey().notNull(),
      guildId: text("guild_id").notNull(),
      incidentKey: text("incident_key").notNull(),
      feature: text("feature").notNull(),
      resourceKind: text("resource_kind").notNull(),
      resourceId: text("resource_id").notNull(),
      condition: text("condition").notNull(),
      severity: text("severity").notNull(),
      status: text("status").notNull(),
      summaryCode: text("summary_code").notNull(),
      safeArgsJson: text("safe_args_json").notNull(),
      remediationCode: text("remediation_code").notNull(),
      firstSeenAtMs: integer("first_seen_at_ms").notNull(),
      openSinceMs: integer("open_since_ms").notNull(),
      lastSeenAtMs: integer("last_seen_at_ms").notNull(),
      resolvedAtMs: integer("resolved_at_ms"),
      occurrenceCount: integer("occurrence_count").notNull().default(1),
      lastCorrelationId: text("last_correlation_id"),
      version: integer("version").notNull().default(1),
      createdAtMs: integer("created_at_ms").notNull(),
      updatedAtMs: integer("updated_at_ms").notNull(),
    },
    (table) => [
      uniqueIndex(`${prefix}operational_incidents_guild_key`).on(table.guildId, table.incidentKey),
      index(`${prefix}operational_incidents_guild_status_severity`).on(
        table.guildId,
        table.status,
        table.severity,
        sql`${table.lastSeenAtMs} DESC`,
      ),
      index(`${prefix}operational_incidents_guild_feature_status`).on(
        table.guildId,
        table.feature,
        table.status,
      ),
      index(`${prefix}operational_incidents_retention`).on(table.status, table.resolvedAtMs),
    ],
  );

  const operationalIncidentEvents = sqliteTable(
    `${prefix}operational_incident_events`,
    {
      id: text("id").primaryKey().notNull(),
      incidentId: text("incident_id").notNull(),
      guildId: text("guild_id").notNull(),
      eventType: text("event_type").notNull(),
      observationId: text("observation_id"),
      reasonCode: text("reason_code"),
      safeArgsJson: text("safe_args_json").notNull(),
      correlationId: text("correlation_id"),
      actorUserId: text("actor_user_id"),
      createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
      uniqueIndex(`${prefix}operational_incident_events_observation`).on(
        table.incidentId,
        table.observationId,
      ),
      index(`${prefix}operational_incident_events_incident_created`).on(
        table.incidentId,
        sql`${table.createdAtMs} DESC`,
      ),
      index(`${prefix}operational_incident_events_retention`).on(table.createdAtMs),
    ],
  );

  return { operationalIncidents, operationalIncidentEvents };
}
