import {
  getOperationalIncidentDefinition,
  getOperationalIncidentDefinitionForKey,
  incidentDefinitionKey,
  parseSafeIncidentArgs,
} from "./definitions";
import type { OperationalIncidentStore } from "./store";
import type {
  OperationalIncident,
  OperationalIncidentKey,
  OperationalIncidentView,
  OperationalRemediationCode,
  OperationalSafeArgs,
  OperationalSeverity,
} from "./types";

export interface OperationalIncidentReporter {
  observeFailure<T extends OperationalSafeArgs>(input: {
    guildId: string;
    key: OperationalIncidentKey;
    observationId?: string;
    severity?: OperationalSeverity;
    resolvedSinceMs?: number;
    summaryCode: string;
    safeArgs: T;
    remediationCode: OperationalRemediationCode;
    correlationId?: string;
    observedAtMs?: number;
  }): Promise<OperationalIncident>;
  observeHealthy(input: {
    guildId: string;
    key: OperationalIncidentKey;
    observationId?: string;
    correlationId?: string;
    observedAtMs?: number;
  }): Promise<OperationalIncident | null>;
}

export interface OperationalRemediationResult {
  ok: boolean;
  message: string;
  incident: OperationalIncident | null;
}

export interface OperationalRemediationHandler {
  execute(input: {
    incident: OperationalIncident;
    actorUserId: string | null;
  }): Promise<{ message: string; incident?: OperationalIncident | null }>;
}

export class OperationalIncidentService implements OperationalIncidentReporter {
  constructor(
    private readonly store: OperationalIncidentStore,
    private readonly handlers: Partial<
      Record<OperationalRemediationCode, OperationalRemediationHandler>
    > = {},
  ) {}

  async observeFailure<T extends OperationalSafeArgs>(
    input: Parameters<OperationalIncidentReporter["observeFailure"]>[0] & { safeArgs: T },
  ): Promise<OperationalIncident> {
    const definition = getOperationalIncidentDefinition(input.summaryCode);
    if (!definition || definition.remediation.code !== input.remediationCode) {
      throw new Error(`Unknown operational incident definition: ${input.summaryCode}.`);
    }
    if (input.key.feature !== definition.feature || input.key.condition !== definition.condition) {
      throw new Error(`Operational incident key does not match ${input.summaryCode}.`);
    }
    const safeArgs = parseSafeIncidentArgs(definition, input.safeArgs);
    const observationId = validateOpaqueId(input.observationId, "observationId");
    const correlationId = validateOpaqueId(input.correlationId, "correlationId");
    return this.store.observeFailure({
      id: await deriveOperationalIncidentId(input.guildId, input.key),
      guildId: input.guildId,
      key: input.key,
      severity: input.severity ?? definition.defaultSeverity,
      summaryCode: definition.summaryCode,
      safeArgs,
      remediationCode: input.remediationCode,
      observationId,
      correlationId,
      observedAtMs: input.observedAtMs ?? Date.now(),
    });
  }

  observeHealthy(input: Parameters<OperationalIncidentReporter["observeHealthy"]>[0]) {
    return this.store.observeHealthy({
      guildId: input.guildId,
      key: input.key,
      observationId: validateOpaqueId(input.observationId, "observationId"),
      correlationId: validateOpaqueId(input.correlationId, "correlationId"),
      observedAtMs: input.observedAtMs ?? Date.now(),
    });
  }

  readById(guildId: string, id: string): Promise<OperationalIncident | null> {
    return this.store.readById(guildId, id);
  }

  async list(input: {
    guildId: string;
    status?: "open" | "resolved";
    feature?: string;
    severity?: OperationalSeverity;
    resolvedSinceMs?: number;
    limit?: number;
    before?: { lastSeenAtMs: number; id: string } | null;
  }): Promise<OperationalIncidentView[]> {
    const incidents = await this.store.listByGuild({
      guildId: input.guildId,
      status: input.status ?? "open",
      feature: input.feature,
      severity: input.severity,
      resolvedSinceMs: input.resolvedSinceMs,
      limit: Math.min(Math.max(input.limit ?? 25, 1), 100),
      before: input.before,
    });
    return incidents.map(toIncidentView);
  }

  async get(guildId: string, id: string): Promise<OperationalIncidentView | null> {
    const incident = await this.store.readById(guildId, id);
    return incident ? toIncidentView(incident) : null;
  }

  listEvents(guildId: string, incidentId: string, limit = 100) {
    return this.store.listEvents(guildId, incidentId, Math.min(Math.max(limit, 1), 100));
  }

  recordEvent(input: Parameters<OperationalIncidentStore["appendEvent"]>[0]): Promise<void> {
    return this.store.appendEvent(input);
  }

  purgeResolved(beforeMs: number, limit = 100): Promise<number> {
    return this.store.purgeResolved(beforeMs, limit);
  }

  async remediate(input: {
    incident: OperationalIncident;
    actorUserId: string | null;
  }): Promise<OperationalRemediationResult> {
    const handler = this.handlers[input.incident.remediationCode];
    if (!handler) {
      return {
        ok: false,
        message: "Operator intervention is required for this incident.",
        incident: toIncidentView(input.incident) as OperationalIncident,
      };
    }
    const result = await handler.execute(input);
    return { ok: true, message: result.message, incident: result.incident ?? null };
  }
}

export function toIncidentView(incident: OperationalIncident): OperationalIncidentView {
  const definition = getOperationalIncidentDefinition(incident.summaryCode);
  if (!definition)
    throw new Error(`Unknown operational incident summary code: ${incident.summaryCode}.`);
  const safeArgs = parseSafeIncidentArgs(definition, incident.safeArgs);
  return {
    ...incident,
    summary: definition.summary(safeArgs),
    impact: (definition.impact as (args: OperationalSafeArgs) => string)(safeArgs),
    deepLink: definition.deepLink(incident),
    remediation: definition.remediation,
  };
}

export function getIncidentKey(input: OperationalIncident): OperationalIncidentKey {
  return {
    feature: input.feature,
    resourceKind: input.resource.kind,
    resourceId: input.resource.id,
    condition: input.condition,
  };
}

export function formatIncidentKey(key: OperationalIncidentKey): string {
  return `${key.feature}:${key.resourceKind}:${key.resourceId}:${key.condition}`;
}

export function isKnownIncidentKey(key: OperationalIncidentKey): boolean {
  return Boolean(getOperationalIncidentDefinitionForKey(key.feature, key.condition));
}

export { incidentDefinitionKey };

export async function deriveOperationalIncidentId(
  guildId: string,
  key: OperationalIncidentKey,
): Promise<string> {
  const input = new TextEncoder().encode(`${guildId}\u0000${formatIncidentKey(key)}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function validateOpaqueId(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new Error(`Invalid operational incident ${label}.`);
  }
  return value;
}
