import { z } from "zod";
import type {
  OperationalIncident,
  OperationalIncidentDefinition,
  OperationalSafeArgs,
} from "./types";

const safeId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const safeCount = z.number().int().min(0).max(1_000_000);
const safeTimestamp = z.number().int().nonnegative().nullable();

const managedPublishArgs = z
  .object({
    draftId: safeId,
    attemptCount: safeCount,
    failureCategory: z.enum([
      "discord_rate_limited",
      "discord_permission_denied",
      "destination_missing",
      "database_failure",
      "unknown",
    ]),
    scheduledAtMs: safeTimestamp,
  })
  .strict();

const managedMissingArgs = z.object({ managedMessageId: safeId }).strict();

const webhookFailureArgs = z
  .object({
    publicId: safeId,
    destinationId: safeId,
    failureReasonCode: z.enum([
      "credential_missing",
      "credential_decrypt_failed",
      "destination_invalid",
      "discord_webhook_not_found",
      "provider_rejected",
      "provider_rate_limited",
      "provider_unavailable",
      "provider_network_error",
      "credential_unavailable",
      "unknown",
    ]),
    consecutiveFailureCount: safeCount,
    lastStatusFamily: z.enum(["2xx", "4xx", "5xx", "network", "unknown"]),
  })
  .strict();

const playerCountArgs = z
  .object({
    serverId: safeId,
    consecutiveFailureCount: safeCount,
    lastSuccessfulFetchAtMs: safeTimestamp,
    providerErrorCategory: z.enum([
      "provider_not_configured",
      "provider_unavailable",
      "provider_rejected",
      "provider_network_error",
      "unknown",
    ]),
  })
  .strict();

const platformLinkPanelPublishArgs = z
  .object({
    platform: z.enum(["steam", "xbox", "playstation"]),
    panelChannelId: safeId,
  })
  .strict();

function guildFeatureLink(incident: OperationalIncident, path: string): string {
  return `/admin/${encodeURIComponent(incident.guildId)}${path}?incidentId=${encodeURIComponent(incident.id)}`;
}

function attempts(count: number): string {
  return `${count} ${count === 1 ? "attempt" : "attempts"}`;
}

export const operationalIncidentDefinitions = [
  {
    feature: "ban-cases",
    condition: "enforcement-uncertain",
    summaryCode: "ban_case_enforcement_uncertain",
    defaultSeverity: "error",
    argsSchema: z.object({ operationId: safeId }).strict(),
    summary: () => "A Ban Case server action has an uncertain outcome.",
    impact: () =>
      "Further actions for this target and subject remain blocked. Do not resend the command.",
    deepLink: (incident) => guildFeatureLink(incident, "/ban-cases"),
    remediation: {
      code: "operator_intervention_required",
      label: "Review server action",
      executable: false,
    },
  },
  {
    feature: "managed-messages",
    condition: "scheduled-publish-failed",
    summaryCode: "managed_message_scheduled_publish_failed",
    defaultSeverity: "error",
    argsSchema: managedPublishArgs,
    summary: (args) =>
      `Scheduled Managed Message publish failed after ${attempts(Number(args.attemptCount))}.`,
    impact: () => "The scheduled announcement was not published to Discord.",
    deepLink: (incident) => guildFeatureLink(incident, "/managed-messages"),
    remediation: {
      code: "retry_managed_message_draft",
      label: "Retry publish",
      executable: true,
    },
  },
  {
    feature: "managed-messages",
    condition: "canonical-message-missing",
    summaryCode: "managed_message_canonical_missing",
    defaultSeverity: "error",
    argsSchema: managedMissingArgs,
    summary: () => "A published Managed Message is missing from Discord.",
    impact: () => "Members cannot see the canonical message until it is republished.",
    deepLink: (incident) => guildFeatureLink(incident, "/managed-messages"),
    remediation: {
      code: "republish_managed_message",
      label: "Republish message",
      executable: true,
    },
  },
  {
    feature: "webhooks",
    condition: "delivery-failing",
    summaryCode: "webhook_destination_delivery_failing",
    defaultSeverity: "warning",
    argsSchema: webhookFailureArgs,
    summary: (args) =>
      `Webhook delivery has failed ${args.consecutiveFailureCount} consecutive times.`,
    impact: () => "Events accepted by HAF may not be reaching the configured destination.",
    deepLink: (incident) => guildFeatureLink(incident, "/webhooks"),
    remediation: {
      code: "review_webhook_destination",
      label: "Review destination",
      executable: false,
    },
  },
  {
    feature: "player-count",
    condition: "offline",
    summaryCode: "player_count_server_offline",
    defaultSeverity: "warning",
    argsSchema: playerCountArgs,
    summary: (args) =>
      `Player Count has failed ${args.consecutiveFailureCount} consecutive checks.`,
    impact: () => "The configured server's player population is not being refreshed.",
    deepLink: (incident) => guildFeatureLink(incident, "/playercount"),
    remediation: {
      code: "refresh_player_count_server",
      label: "Refresh server",
      executable: true,
    },
  },
  {
    feature: "platform-link",
    condition: "panel-publish-permission-denied",
    summaryCode: "platform_link_panel_publish_permission_denied",
    defaultSeverity: "warning",
    argsSchema: platformLinkPanelPublishArgs,
    summary: (args) =>
      `HAF cannot publish the ${args.platform} Player Link panel because it lacks channel permission.`,
    impact: () => "Members cannot begin linking their account from the configured panel.",
    deepLink: (incident) => guildFeatureLink(incident, "/player-link"),
    remediation: {
      code: "operator_intervention_required",
      label: "Review channel permissions",
      executable: false,
    },
  },
] satisfies readonly OperationalIncidentDefinition[];

const definitionsBySummaryCode = new Map(
  operationalIncidentDefinitions.map((definition) => [definition.summaryCode, definition]),
);
const definitionsByKey = new Map(
  operationalIncidentDefinitions.map((definition) => [
    `${definition.feature}:${definition.condition}`,
    definition,
  ]),
);

export function getOperationalIncidentDefinition(summaryCode: string) {
  return definitionsBySummaryCode.get(summaryCode as OperationalIncidentDefinition["summaryCode"]);
}

export function getOperationalIncidentDefinitionForKey(feature: string, condition: string) {
  return definitionsByKey.get(`${feature}:${condition}`);
}

export function incidentDefinitionKey(feature: string, condition: string): string {
  return `${feature}:${condition}`;
}

export function parseSafeIncidentArgs(
  definition: OperationalIncidentDefinition,
  value: unknown,
): OperationalSafeArgs {
  const result = definition.argsSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid safe arguments for operational incident ${definition.summaryCode}.`);
  }
  return result.data;
}
