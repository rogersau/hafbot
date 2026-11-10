import type {
  OperationalIncident,
  OperationalIncidentEvent,
  OperationalIncidentKey,
} from "./types";
import type { OperationalIncidentStore } from "./store";

export function createMemoryOperationalIncidentStore(): OperationalIncidentStore {
  const incidents = new Map<string, OperationalIncident>();
  const events = new Map<string, OperationalIncidentEvent>();
  const observationKeys = new Set<string>();

  return {
    async observeFailure(input) {
      const key = formatKey(input.key);
      const existing = incidents.get(key);
      const observationKey = input.observationId ? `${input.id}:${input.observationId}` : null;
      if (observationKey && observationKeys.has(observationKey) && existing) return clone(existing);
      const reopened = existing?.status === "resolved";
      const incident: OperationalIncident = existing
        ? {
            ...existing,
            severity: input.severity,
            status: "open",
            summaryCode: input.summaryCode as OperationalIncident["summaryCode"],
            safeArgs: input.safeArgs,
            remediationCode: input.remediationCode as OperationalIncident["remediationCode"],
            openSinceMs: reopened ? input.observedAtMs : existing.openSinceMs,
            lastSeenAtMs: input.observedAtMs,
            resolvedAtMs: null,
            occurrenceCount: existing.occurrenceCount + 1,
            lastCorrelationId: input.correlationId,
            version: existing.version + 1,
          }
        : {
            id: input.id,
            guildId: input.guildId,
            key,
            feature: input.key.feature,
            resource: { kind: input.key.resourceKind, id: input.key.resourceId },
            condition: input.key.condition,
            severity: input.severity,
            status: "open",
            summaryCode: input.summaryCode as OperationalIncident["summaryCode"],
            safeArgs: input.safeArgs,
            remediationCode: input.remediationCode as OperationalIncident["remediationCode"],
            firstSeenAtMs: input.observedAtMs,
            openSinceMs: input.observedAtMs,
            lastSeenAtMs: input.observedAtMs,
            resolvedAtMs: null,
            occurrenceCount: 1,
            lastCorrelationId: input.correlationId,
            version: 1,
          };
      incidents.set(key, incident);
      if (observationKey) observationKeys.add(observationKey);
      addEvent({
        incidentId: incident.id,
        guildId: incident.guildId,
        eventType: existing ? (reopened ? "reopened" : "observed") : "opened",
        observationId: input.observationId,
        reasonCode: input.key.condition,
        safeArgs: input.safeArgs,
        correlationId: input.correlationId,
        actorUserId: null,
        createdAtMs: input.observedAtMs,
      });
      return clone(incident);
    },
    async observeHealthy(input) {
      const incident = incidents.get(formatKey(input.key));
      if (!incident || incident.status === "resolved") return incident ? clone(incident) : null;
      const updated = {
        ...incident,
        status: "resolved" as const,
        resolvedAtMs: input.observedAtMs,
        lastSeenAtMs: input.observedAtMs,
        version: incident.version + 1,
      };
      incidents.set(updated.key, updated);
      addEvent({
        incidentId: updated.id,
        guildId: updated.guildId,
        eventType: "resolved",
        observationId: input.observationId,
        reasonCode: "healthy_observation",
        safeArgs: {},
        correlationId: input.correlationId ?? null,
        actorUserId: null,
        createdAtMs: input.observedAtMs,
      });
      return clone(updated);
    },
    async readById(guildId, id) {
      const incident = [...incidents.values()].find(
        (item) => item.guildId === guildId && item.id === id,
      );
      return incident ? clone(incident) : null;
    },
    async listByGuild(input) {
      return [...incidents.values()]
        .filter(
          (incident) =>
            incident.guildId === input.guildId &&
            incident.status === input.status &&
            (!input.feature || incident.feature === input.feature) &&
            (!input.severity || incident.severity === input.severity) &&
            (input.resolvedSinceMs === undefined ||
              (incident.resolvedAtMs !== null && incident.resolvedAtMs >= input.resolvedSinceMs)) &&
            (!input.before ||
              incident.lastSeenAtMs < input.before.lastSeenAtMs ||
              (incident.lastSeenAtMs === input.before.lastSeenAtMs &&
                incident.id < input.before.id)),
        )
        .sort(
          (left, right) =>
            right.lastSeenAtMs - left.lastSeenAtMs || left.id.localeCompare(right.id),
        )
        .slice(0, input.limit)
        .map(clone);
    },
    async listEvents(guildId, incidentId, limit = 100) {
      return [...events.values()]
        .filter((event) => event.guildId === guildId && event.incidentId === incidentId)
        .sort((left, right) => right.createdAtMs - left.createdAtMs)
        .slice(0, limit)
        .map(clone);
    },
    async appendEvent(input) {
      addEvent(input);
    },
    async purgeResolved(beforeMs, limit = 100) {
      const expired = [...incidents.values()]
        .filter(
          (incident) =>
            incident.status === "resolved" && (incident.resolvedAtMs ?? Infinity) < beforeMs,
        )
        .slice(0, limit);
      for (const incident of expired) {
        incidents.delete(incident.key);
        for (const [id, event] of events) if (event.incidentId === incident.id) events.delete(id);
      }
      return expired.length;
    },
  };

  function addEvent(input: Omit<OperationalIncidentEvent, "id">): void {
    const id = input.observationId
      ? `${input.incidentId}:${input.observationId}`
      : crypto.randomUUID();
    if (events.has(id)) return;
    events.set(id, { ...input, id });
  }
}

function formatKey(key: OperationalIncidentKey): string {
  return `${key.feature}:${key.resourceKind}:${key.resourceId}:${key.condition}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
