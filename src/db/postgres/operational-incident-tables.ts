import { pgTable, text, index, uniqueIndex } from "drizzle-orm/pg-core";
import { bigInteger } from "./column-types";
import { sql } from "drizzle-orm";

export function operationalIncidentTables(prefix = "") {
  const operationalIncidents = pgTable(
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
      firstSeenAtMs: bigInteger("first_seen_at_ms").notNull(),
      openSinceMs: bigInteger("open_since_ms").notNull(),
      lastSeenAtMs: bigInteger("last_seen_at_ms").notNull(),
      resolvedAtMs: bigInteger("resolved_at_ms"),
      occurrenceCount: bigInteger("occurrence_count").notNull().default(1),
      lastCorrelationId: text("last_correlation_id"),
      version: bigInteger("version").notNull().default(1),
      createdAtMs: bigInteger("created_at_ms").notNull(),
      updatedAtMs: bigInteger("updated_at_ms").notNull(),
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

  const operationalIncidentEvents = pgTable(
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
      createdAtMs: bigInteger("created_at_ms").notNull(),
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
