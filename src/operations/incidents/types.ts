import type { z } from "zod";

export type OperationalFeature =
  | "ban-cases"
  | "managed-messages"
  | "webhooks"
  | "player-count"
  | "platform-link";
export type OperationalSeverity = "warning" | "error" | "critical";
export type OperationalIncidentStatus = "open" | "resolved";

export type OperationalSummaryCode =
  | "ban_case_enforcement_uncertain"
  | "managed_message_scheduled_publish_failed"
  | "managed_message_canonical_missing"
  | "webhook_destination_delivery_failing"
  | "player_count_server_offline"
  | "platform_link_panel_publish_permission_denied";

export type OperationalRemediationCode =
  | "retry_managed_message_draft"
  | "republish_managed_message"
  | "review_webhook_destination"
  | "refresh_player_count_server"
  | "operator_intervention_required";

export type OperationalSafeArg = string | number | boolean | null;
export type OperationalSafeArgs = Record<string, OperationalSafeArg>;

export interface OperationalIncidentKey {
  feature: OperationalFeature;
  resourceKind: string;
  resourceId: string;
  condition: string;
}

export interface OperationalIncident {
  id: string;
  guildId: string;
  key: string;
  feature: OperationalFeature;
  resource: { kind: string; id: string };
  condition: string;
  severity: OperationalSeverity;
  status: OperationalIncidentStatus;
  summaryCode: OperationalSummaryCode;
  safeArgs: OperationalSafeArgs;
  remediationCode: OperationalRemediationCode;
  firstSeenAtMs: number;
  openSinceMs: number;
  lastSeenAtMs: number;
  resolvedAtMs: number | null;
  occurrenceCount: number;
  lastCorrelationId: string | null;
  version: number;
}

export interface OperationalIncidentEvent {
  id: string;
  incidentId: string;
  guildId: string;
  eventType:
    | "opened"
    | "observed"
    | "severity_changed"
    | "remediation_started"
    | "remediation_succeeded"
    | "remediation_failed"
    | "resolved"
    | "reopened";
  observationId: string | null;
  reasonCode: string | null;
  safeArgs: OperationalSafeArgs;
  correlationId: string | null;
  actorUserId: string | null;
  createdAtMs: number;
}

export interface OperationalIncidentDefinition<
  TArgs extends OperationalSafeArgs = OperationalSafeArgs,
> {
  feature: OperationalFeature;
  condition: string;
  summaryCode: OperationalSummaryCode;
  defaultSeverity: OperationalSeverity;
  argsSchema: z.ZodType<TArgs>;
  summary(args: TArgs): string;
  impact(args: TArgs): string;
  deepLink(incident: OperationalIncident): string;
  remediation: {
    code: OperationalRemediationCode;
    label: string;
    executable: boolean;
  };
}

export interface OperationalIncidentView extends OperationalIncident {
  summary: string;
  impact: string;
  deepLink: string;
  remediation: OperationalIncidentDefinition["remediation"];
}
