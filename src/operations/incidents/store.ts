import type {
  OperationalIncident,
  OperationalIncidentEvent,
  OperationalIncidentKey,
  OperationalSafeArgs,
  OperationalSeverity,
} from "./types";

export interface OperationalIncidentFailureInput {
  id: string;
  guildId: string;
  key: OperationalIncidentKey;
  severity: OperationalSeverity;
  summaryCode: string;
  safeArgs: OperationalSafeArgs;
  remediationCode: string;
  observationId: string | null;
  correlationId: string | null;
  observedAtMs: number;
}

export interface OperationalIncidentStore {
  observeFailure(input: OperationalIncidentFailureInput): Promise<OperationalIncident>;
  observeHealthy(input: {
    guildId: string;
    key: OperationalIncidentKey;
    observationId: string | null;
    correlationId: string | null;
    observedAtMs: number;
  }): Promise<OperationalIncident | null>;
  readById(guildId: string, id: string): Promise<OperationalIncident | null>;
  listByGuild(input: {
    guildId: string;
    status: "open" | "resolved";
    feature?: string;
    severity?: OperationalSeverity;
    resolvedSinceMs?: number;
    limit: number;
    before?: { lastSeenAtMs: number; id: string } | null;
  }): Promise<OperationalIncident[]>;
  listEvents(
    guildId: string,
    incidentId: string,
    limit?: number,
  ): Promise<OperationalIncidentEvent[]>;
  appendEvent(input: Omit<OperationalIncidentEvent, "id">): Promise<void>;
  purgeResolved(beforeMs: number, limit?: number): Promise<number>;
}
