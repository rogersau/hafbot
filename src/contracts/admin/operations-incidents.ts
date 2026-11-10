import { z } from "zod";
import { adminOperationErrors, defineAdminOperation } from "./core";

const guildQuery = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
});
const listQuery = guildQuery.extend({
  status: z.enum(["open", "resolved"]).optional(),
  feature: z.string().min(1).optional(),
  severity: z.enum(["warning", "error", "critical"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});
export const operationalIncidentViewSchema = z.object({
  id: z.string(),
  guildId: z.string(),
  key: z.string(),
  feature: z.enum(["managed-messages", "webhooks", "player-count"]),
  resource: z.object({ kind: z.string(), id: z.string() }),
  condition: z.string(),
  severity: z.enum(["warning", "error", "critical"]),
  status: z.enum(["open", "resolved"]),
  summaryCode: z.string(),
  safeArgs: z.object({}).passthrough(),
  remediationCode: z.string(),
  firstSeenAtMs: z.number(),
  openSinceMs: z.number(),
  lastSeenAtMs: z.number(),
  resolvedAtMs: z.number().nullable(),
  occurrenceCount: z.number().int(),
  lastCorrelationId: z.string().nullable(),
  version: z.number().int(),
  summary: z.string(),
  impact: z.string(),
  deepLink: z.string(),
  remediation: z.object({ code: z.string(), label: z.string(), executable: z.boolean() }),
});
const event = z.object({
  id: z.string(),
  incidentId: z.string(),
  guildId: z.string(),
  eventType: z.string(),
  observationId: z.string().nullable(),
  reasonCode: z.string().nullable(),
  safeArgs: z.object({}).passthrough(),
  correlationId: z.string().nullable(),
  actorUserId: z.string().nullable(),
  createdAtMs: z.number(),
});
const readErrors = [
  adminOperationErrors.invalidRequest,
  adminOperationErrors.authenticationRequired,
  adminOperationErrors.permissionDenied,
  adminOperationErrors.resourceNotFound,
  adminOperationErrors.unavailable,
  adminOperationErrors.internal,
] as const;
const writeErrors = [...readErrors, adminOperationErrors.conflict] as const;
const metadata = {
  tags: ["Operations"],
  access: { scope: "guild", mode: "read" },
  feature: undefined,
  entitlement: undefined,
} as const;

export const getOperationalIncidentCapabilities = defineAdminOperation({
  ...metadata,
  operationId: "operationsIncidents.capabilities.get",
  method: "GET",
  path: "/admin/api/operations/incidents/capabilities",
  summary: "Read operational incident remediation capabilities",
  query: guildQuery,
  success: {
    status: 200,
    schema: z.object({ canWrite: z.boolean() }),
    description: "Whether the actor can remediate incidents",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "write" },
});

export const listOperationalIncidents = defineAdminOperation({
  ...metadata,
  operationId: "operationsIncidents.get",
  method: "GET",
  path: "/admin/api/operations/incidents",
  summary: "List Guild operational incidents",
  query: listQuery,
  success: {
    status: 200,
    schema: z.object({
      guildId: z.string(),
      incidents: z.array(operationalIncidentViewSchema),
      nextCursor: z.string().nullable(),
    }),
    description: "Open or recent resolved incidents for the Guild",
  },
  errors: readErrors,
});

export const getOperationalIncident = defineAdminOperation({
  ...metadata,
  operationId: "operationsIncidents.getById",
  method: "GET",
  path: "/admin/api/operations/incidents/:incidentId",
  summary: "Read an operational incident and lifecycle history",
  query: guildQuery,
  success: {
    status: 200,
    schema: z.object({ incident: operationalIncidentViewSchema, events: z.array(event) }),
    description: "Incident details and lifecycle history",
  },
  errors: readErrors,
});

export const remediateOperationalIncident = defineAdminOperation({
  ...metadata,
  operationId: "operationsIncidents.remediate",
  method: "POST",
  path: "/admin/api/operations/incidents/:incidentId/remediate",
  summary: "Execute a safe operational incident remediation",
  body: z.object({
    guildId: z.string().min(1),
    workspaceId: z.string().min(1).optional(),
    incidentId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    action: z.string().min(1),
  }),
  success: {
    status: 200,
    schema: z.object({
      ok: z.literal(true),
      message: z.string(),
      incident: operationalIncidentViewSchema.nullable(),
    }),
    description: "Remediation outcome and refreshed incident",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});
