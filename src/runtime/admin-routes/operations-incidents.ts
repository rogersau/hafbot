import { defineRoute, type Route } from "../admin-route-registry";
import { bodyGuildScopedAccess, guildScopedAccess } from "../admin-route-guards";
import { adminErrorEnvelopeSchema } from "../../contracts/admin";
import {
  getOperationalIncident,
  getOperationalIncidentCapabilities,
  listOperationalIncidents,
  remediateOperationalIncident,
} from "../../contracts/admin";
import type { CustomerSession } from "../auth/customer-session";
import type { RuntimeStores } from "../app-types";
import type { ManagedMessageService } from "../../services/managed-message-service";
import type { PlayerCountService } from "../../services/player-count-service";
import type { OperationalIncidentService } from "../../operations/incidents";

export function createOperationalIncidentAdminRoutes(options: {
  stores: RuntimeStores;
  service: OperationalIncidentService;
  managedMessageService?: ManagedMessageService;
  playerCountService?: PlayerCountService;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
}): Array<Route<any, any, Response>> {
  return [
    defineRoute({
      ...getOperationalIncidentCapabilities,
      feature: undefined,
      success: getOperationalIncidentCapabilities.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("write"),
      handler: async () => Response.json({ canWrite: true }),
    }),
    defineRoute({
      ...listOperationalIncidents,
      feature: undefined,
      success: listOperationalIncidents.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const before = decodeCursor(query.cursor);
        const incidents = await options.service.list({
          guildId: query.guildId,
          status: query.status,
          feature: query.feature,
          severity: query.severity,
          limit: query.limit,
          before,
          resolvedSinceMs:
            query.status === "resolved" ? Date.now() - 30 * 24 * 60 * 60 * 1000 : undefined,
        });
        const last = incidents.at(-1);
        return Response.json({
          guildId: query.guildId,
          incidents,
          nextCursor:
            last && incidents.length === (query.limit ?? 25)
              ? encodeCursor(last.lastSeenAtMs, last.id)
              : null,
        });
      },
    }),
    defineRoute({
      ...getOperationalIncident,
      feature: undefined,
      success: getOperationalIncident.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      handler: async ({ query, params }) => {
        const incident = await options.service.get(query.guildId, params.incidentId!);
        if (!incident) return Response.json({ error: "Incident not found." }, { status: 404 });
        const events = await options.service.listEvents(query.guildId, incident.id);
        return Response.json({ incident, events });
      },
    }),
    defineRoute({
      ...remediateOperationalIncident,
      feature: undefined,
      success: remediateOperationalIncident.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, params, request }) => {
        if (body.incidentId !== params.incidentId) {
          return Response.json({ error: "Incident id does not match the route." }, { status: 400 });
        }
        const incident = await options.service.get(body.guildId, body.incidentId);
        if (!incident) return Response.json({ error: "Incident not found." }, { status: 404 });
        if (incident.version !== body.expectedVersion || incident.status !== "open") {
          return Response.json(
            { error: "The incident changed; refresh and try again." },
            { status: 409 },
          );
        }
        if (incident.remediation.code !== body.action) {
          return Response.json(
            { error: "That remediation is not valid for this incident." },
            { status: 409 },
          );
        }
        const actorUserId =
          (await options.readCustomerAdminSession?.(request))?.user.discordUserId ?? null;
        await recordRemediationEvent(
          options,
          incident,
          "remediation_started",
          actorUserId,
          body.action,
        );
        let result: { ok: boolean; message: string };
        try {
          result = await executeRemediation(options, incident, actorUserId);
        } catch (error) {
          await recordRemediationEvent(
            options,
            incident,
            "remediation_failed",
            actorUserId,
            "handler_failed",
          );
          throw error;
        }
        if (!result.ok) {
          await recordRemediationEvent(
            options,
            incident,
            "remediation_failed",
            actorUserId,
            body.action,
          );
          return Response.json({ error: result.message }, { status: 409 });
        }
        await recordRemediationEvent(
          options,
          incident,
          "remediation_succeeded",
          actorUserId,
          body.action,
        );
        const refreshed = await options.service.get(body.guildId, body.incidentId);
        return Response.json({ ok: true, message: result.message, incident: refreshed });
      },
    }),
  ];
}

async function executeRemediation(
  options: Parameters<typeof createOperationalIncidentAdminRoutes>[0],
  incident: Awaited<ReturnType<OperationalIncidentService["get"]>> & object,
  actorUserId: string | null,
): Promise<{ ok: boolean; message: string }> {
  if (incident.remediation.code === "review_webhook_destination") {
    return { ok: false, message: "Review this destination from the Webhooks page." };
  }
  if (incident.remediation.code === "operator_intervention_required") {
    return { ok: false, message: "Operator intervention is required for this incident." };
  }
  if (incident.remediation.code === "retry_managed_message_draft") {
    const draftId = incident.safeArgs.draftId;
    if (typeof draftId !== "string" || !options.managedMessageService) {
      return { ok: false, message: "Managed Message retry is unavailable." };
    }
    await options.managedMessageService.publishDraftNow(
      incident.guildId,
      draftId,
      actorUserId ?? undefined,
    );
    return { ok: true, message: "Managed Message publish retried." };
  }
  if (incident.remediation.code === "republish_managed_message") {
    const messageId = incident.safeArgs.managedMessageId;
    if (typeof messageId !== "string" || !options.managedMessageService) {
      return { ok: false, message: "Managed Message repair is unavailable." };
    }
    await options.managedMessageService.repairMissing(
      incident.guildId,
      messageId,
      actorUserId ?? undefined,
    );
    return { ok: true, message: "Managed Message republished." };
  }
  const serverId = incident.safeArgs.serverId;
  if (typeof serverId !== "string" || !options.playerCountService) {
    return { ok: false, message: "Player Count refresh is unavailable." };
  }
  const result = await options.playerCountService.refreshServer(incident.guildId, serverId);
  return result.ok
    ? { ok: true, message: "Player Count refreshed." }
    : { ok: false, message: result.error };
}

async function recordRemediationEvent(
  options: Parameters<typeof createOperationalIncidentAdminRoutes>[0],
  incident: Awaited<ReturnType<OperationalIncidentService["get"]>> & object,
  eventType: "remediation_started" | "remediation_succeeded" | "remediation_failed",
  actorUserId: string | null,
  reasonCode: string,
): Promise<void> {
  await options.service.recordEvent({
    incidentId: incident.id,
    guildId: incident.guildId,
    eventType,
    observationId: null,
    reasonCode,
    safeArgs: incident.safeArgs,
    correlationId: incident.lastCorrelationId,
    actorUserId,
    createdAtMs: Date.now(),
  });
}

function encodeCursor(lastSeenAtMs: number, id: string): string {
  return btoa(`${lastSeenAtMs}:${id}`);
}

function decodeCursor(value: string | undefined): { lastSeenAtMs: number; id: string } | null {
  if (!value) return null;
  try {
    const decoded = atob(value);
    const separator = decoded.indexOf(":");
    const lastSeenAtMs = Number(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    return separator > 0 && Number.isSafeInteger(lastSeenAtMs) && id ? { lastSeenAtMs, id } : null;
  } catch {
    return null;
  }
}
