import { and, asc, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import { operationalIncidentTables } from "../../db/postgres/operational-incident-tables";
const { operationalIncidentEvents, operationalIncidents } = operationalIncidentTables();
import type {
  OperationalIncident,
  OperationalIncidentEvent,
  OperationalIncidentKey,
  OperationalSafeArgs,
  OperationalSeverity,
} from "../../operations/incidents";
import type {
  OperationalIncidentFailureInput,
  OperationalIncidentStore,
} from "../../operations/incidents/store";
import { isRecord } from "../../unknown-parse";
import type { PostgresDatabaseCapability } from "./postgres-capability";

type IncidentRow = typeof operationalIncidents.$inferSelect;
type IncidentEventRow = typeof operationalIncidentEvents.$inferSelect;

export function createPostgresOperationalIncidentStore(
  database: PostgresDatabaseCapability,
  scope: "default" | "ban-cases" = "default",
): OperationalIncidentStore {
  const { operationalIncidents, operationalIncidentEvents } = operationalIncidentTables(
    scope === "ban-cases" ? "ban_case_" : "",
  );
  const db = database.drizzle;

  const store: OperationalIncidentStore = {
    async observeFailure(input: OperationalIncidentFailureInput) {
      const existing = await db
        .select()
        .from(operationalIncidents)
        .where(
          and(
            eq(operationalIncidents.guildId, input.guildId),
            eq(operationalIncidents.incidentKey, formatKey(input.key)),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);

      const duplicateObservation = input.observationId
        ? Boolean(
            existing &&
            (await db
              .select({ id: operationalIncidentEvents.id })
              .from(operationalIncidentEvents)
              .where(
                and(
                  eq(operationalIncidentEvents.incidentId, existing.id),
                  eq(operationalIncidentEvents.observationId, input.observationId),
                ),
              )
              .limit(1)
              .then((rows) => rows[0])),
          )
        : false;

      if (!existing) {
        const row = await db
          .insert(operationalIncidents)
          .values({
            id: input.id,
            guildId: input.guildId,
            incidentKey: formatKey(input.key),
            feature: input.key.feature,
            resourceKind: input.key.resourceKind,
            resourceId: input.key.resourceId,
            condition: input.key.condition,
            severity: input.severity,
            status: "open",
            summaryCode: input.summaryCode,
            safeArgsJson: JSON.stringify(input.safeArgs),
            remediationCode: input.remediationCode,
            firstSeenAtMs: input.observedAtMs,
            openSinceMs: input.observedAtMs,
            lastSeenAtMs: input.observedAtMs,
            resolvedAtMs: null,
            occurrenceCount: 1,
            lastCorrelationId: input.correlationId,
            version: 1,
            createdAtMs: input.observedAtMs,
            updatedAtMs: input.observedAtMs,
          })
          .returning()
          .then((rows) => rows[0]);
        if (row) {
          await insertEvent(db, operationalIncidentEvents, {
            incidentId: row.id,
            guildId: row.guildId,
            eventType: "opened",
            observationId: input.observationId,
            reasonCode: input.key.condition,
            safeArgs: input.safeArgs,
            correlationId: input.correlationId,
            actorUserId: null,
            createdAtMs: input.observedAtMs,
          });
          return rowToIncident(row);
        }
      }

      const current = existing ?? (await readById(input.guildId, input.id));
      if (!current) throw new Error("Operational incident could not be read after upsert.");
      if (duplicateObservation) return rowToIncident(current);

      const reopened = current.status === "resolved";
      const severityChanged = current.severity !== input.severity;
      const updated = await db
        .update(operationalIncidents)
        .set({
          severity: input.severity,
          status: "open",
          summaryCode: input.summaryCode,
          safeArgsJson: JSON.stringify(input.safeArgs),
          remediationCode: input.remediationCode,
          openSinceMs: reopened ? input.observedAtMs : current.openSinceMs,
          lastSeenAtMs: input.observedAtMs,
          resolvedAtMs: null,
          occurrenceCount: sql`${operationalIncidents.occurrenceCount} + 1`,
          lastCorrelationId: input.correlationId,
          version: sql`${operationalIncidents.version} + 1`,
          updatedAtMs: input.observedAtMs,
        })
        .where(eq(operationalIncidents.id, current.id))
        .returning()
        .then((rows) => rows[0]);
      if (!updated) throw new Error("Operational incident update did not return a row.");

      await insertEvent(db, operationalIncidentEvents, {
        incidentId: updated.id,
        guildId: updated.guildId,
        eventType: reopened ? "reopened" : severityChanged ? "severity_changed" : "observed",
        observationId: input.observationId,
        reasonCode: input.key.condition,
        safeArgs: input.safeArgs,
        correlationId: input.correlationId,
        actorUserId: null,
        createdAtMs: input.observedAtMs,
      });
      return rowToIncident(updated);
    },

    async observeHealthy(input) {
      const row = await db
        .select()
        .from(operationalIncidents)
        .where(
          and(
            eq(operationalIncidents.guildId, input.guildId),
            eq(operationalIncidents.incidentKey, formatKey(input.key)),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      if (!row || row.status === "resolved") return row ? rowToIncident(row) : null;
      const updated = await db
        .update(operationalIncidents)
        .set({
          status: "resolved",
          resolvedAtMs: input.observedAtMs,
          lastSeenAtMs: input.observedAtMs,
          version: sql`${operationalIncidents.version} + 1`,
          updatedAtMs: input.observedAtMs,
        })
        .where(and(eq(operationalIncidents.id, row.id), eq(operationalIncidents.status, "open")))
        .returning()
        .then((rows) => rows[0]);
      if (!updated) return rowToIncident(row);
      await insertEvent(db, operationalIncidentEvents, {
        incidentId: updated.id,
        guildId: updated.guildId,
        eventType: "resolved",
        observationId: input.observationId,
        reasonCode: "healthy_observation",
        safeArgs: {},
        correlationId: input.correlationId,
        actorUserId: null,
        createdAtMs: input.observedAtMs,
      });
      return rowToIncident(updated);
    },

    async readById(guildId, id) {
      const row = await db
        .select()
        .from(operationalIncidents)
        .where(and(eq(operationalIncidents.guildId, guildId), eq(operationalIncidents.id, id)))
        .limit(1)
        .then((rows) => rows[0]);
      return row ? rowToIncident(row) : null;
    },

    async listByGuild(input) {
      const filters = [
        eq(operationalIncidents.guildId, input.guildId),
        eq(operationalIncidents.status, input.status),
      ];
      if (input.feature) filters.push(eq(operationalIncidents.feature, input.feature));
      if (input.severity) filters.push(eq(operationalIncidents.severity, input.severity));
      if (input.resolvedSinceMs !== undefined) {
        filters.push(gte(operationalIncidents.resolvedAtMs, input.resolvedSinceMs));
      }
      if (input.before) {
        filters.push(
          or(
            lt(operationalIncidents.lastSeenAtMs, input.before.lastSeenAtMs),
            and(
              eq(operationalIncidents.lastSeenAtMs, input.before.lastSeenAtMs),
              lt(operationalIncidents.id, input.before.id),
            ),
          )!,
        );
      }
      const rows = await db
        .select()
        .from(operationalIncidents)
        .where(and(...filters))
        .orderBy(desc(operationalIncidents.lastSeenAtMs), asc(operationalIncidents.id))
        .limit(Math.min(Math.max(input.limit, 1), 100))
        .execute();
      return rows.map(rowToIncident);
    },

    async listEvents(guildId, incidentId, limit = 100) {
      const rows = await db
        .select()
        .from(operationalIncidentEvents)
        .where(
          and(
            eq(operationalIncidentEvents.guildId, guildId),
            eq(operationalIncidentEvents.incidentId, incidentId),
          ),
        )
        .orderBy(desc(operationalIncidentEvents.createdAtMs))
        .limit(Math.min(Math.max(limit, 1), 100))
        .execute();
      return rows.map(rowToEvent);
    },

    async appendEvent(input) {
      await insertEvent(db, operationalIncidentEvents, input);
    },

    async purgeResolved(beforeMs, limit = 100) {
      const rows = await db
        .select({ id: operationalIncidents.id })
        .from(operationalIncidents)
        .where(
          and(
            eq(operationalIncidents.status, "resolved"),
            lt(operationalIncidents.resolvedAtMs, beforeMs),
          ),
        )
        .orderBy(asc(operationalIncidents.resolvedAtMs))
        .limit(Math.min(Math.max(limit, 1), 500))
        .execute();
      if (rows.length === 0) return 0;
      for (const { id } of rows) {
        await db
          .delete(operationalIncidentEvents)
          .where(eq(operationalIncidentEvents.incidentId, id))
          .execute();
        await db.delete(operationalIncidents).where(eq(operationalIncidents.id, id)).execute();
      }
      return rows.length;
    },
  };

  return store;

  async function readById(guildId: string, id: string): Promise<IncidentRow | null> {
    return (
      (await db
        .select()
        .from(operationalIncidents)
        .where(and(eq(operationalIncidents.guildId, guildId), eq(operationalIncidents.id, id)))
        .limit(1)
        .then((rows) => rows[0])) ?? null
    );
  }
}

async function insertEvent(
  db: PostgresDatabaseCapability["drizzle"],
  eventsTable: typeof operationalIncidentEvents,
  input: Omit<OperationalIncidentEvent, "id">,
): Promise<void> {
  const id = input.observationId
    ? `${input.incidentId}:${input.observationId}`.slice(0, 240)
    : crypto.randomUUID();
  await db
    .insert(eventsTable)
    .values({
      id,
      incidentId: input.incidentId,
      guildId: input.guildId,
      eventType: input.eventType,
      observationId: input.observationId,
      reasonCode: input.reasonCode,
      safeArgsJson: JSON.stringify(input.safeArgs),
      correlationId: input.correlationId,
      actorUserId: input.actorUserId,
      createdAtMs: input.createdAtMs,
    })
    .onConflictDoNothing()
    .execute();
}

function formatKey(key: OperationalIncidentKey): string {
  return `${key.feature}:${key.resourceKind}:${key.resourceId}:${key.condition}`;
}

function rowToIncident(row: IncidentRow): OperationalIncident {
  return {
    id: row.id,
    guildId: row.guildId,
    key: row.incidentKey,
    feature: row.feature as OperationalIncident["feature"],
    resource: { kind: row.resourceKind, id: row.resourceId },
    condition: row.condition,
    severity: row.severity as OperationalSeverity,
    status: row.status as OperationalIncident["status"],
    summaryCode: row.summaryCode as OperationalIncident["summaryCode"],
    safeArgs: parseJson(row.safeArgsJson),
    remediationCode: row.remediationCode as OperationalIncident["remediationCode"],
    firstSeenAtMs: row.firstSeenAtMs,
    openSinceMs: row.openSinceMs,
    lastSeenAtMs: row.lastSeenAtMs,
    resolvedAtMs: row.resolvedAtMs,
    occurrenceCount: row.occurrenceCount,
    lastCorrelationId: row.lastCorrelationId,
    version: row.version,
  };
}

function rowToEvent(row: IncidentEventRow): OperationalIncidentEvent {
  return {
    id: row.id,
    incidentId: row.incidentId,
    guildId: row.guildId,
    eventType: row.eventType as OperationalIncidentEvent["eventType"],
    observationId: row.observationId,
    reasonCode: row.reasonCode,
    safeArgs: parseJson(row.safeArgsJson),
    correlationId: row.correlationId,
    actorUserId: row.actorUserId,
    createdAtMs: row.createdAtMs,
  };
}

function parseJson(value: string): OperationalSafeArgs {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? (parsed as OperationalSafeArgs) : {};
  } catch {
    return {};
  }
}
