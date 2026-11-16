import { z } from "zod";
import { adminOperationErrors, defineAdminOperation } from "./core";

export const configurationFeatureSchema = z.enum([
  "tickets",
  "webhook-proxy",
  "mention-protection",
  "bot-defense",
  "member-verification",
  "guild-audit-log",
]);

const workspaceId = z.string().min(1).optional();
const baseQuery = z.object({
  guildId: z.string().min(1),
  workspaceId,
});
const pageQuery = baseQuery.extend({
  feature: configurationFeatureSchema,
  resourceKey: z.string().min(1),
  limit: z.string().optional(),
  beforeCreatedAtMs: z.string().optional(),
});
const detailQuery = baseQuery.extend({ revisionId: z.string().min(1) });
const compareQuery = baseQuery.extend({
  beforeRevisionId: z.string().min(1).optional(),
  afterRevisionId: z.string().min(1),
});
const exportQuery = baseQuery.extend({
  format: z.enum(["json", "jsonl"]).optional(),
  limit: z.string().optional(),
  beforeCreatedAtMs: z.string().optional(),
});
const restorePreviewBody = z.object({
  guildId: z.string().min(1),
  workspaceId,
  feature: configurationFeatureSchema,
  resourceKey: z.string().min(1),
  revisionId: z.string().min(1),
  secretReplacements: z
    .array(z.object({ slot: z.string().min(1), value: z.string().min(1) }))
    .optional(),
  omittedSecretSlots: z.array(z.string()).optional(),
});
const restoreBody = restorePreviewBody.extend({ previewToken: z.string().min(1) });

export const revisionSummarySchema = z.object({
  id: z.string(),
  guildId: z.string(),
  feature: configurationFeatureSchema,
  resourceKey: z.string(),
  schemaVersion: z.number().int().positive(),
  operation: z.enum(["baseline", "create", "update", "delete", "restore", "clone"]),
  source: z.enum(["dashboard-save", "restore", "clone", "system-snapshot"]),
  actorUserId: z.string().nullable(),
  operationId: z.string(),
  correlationId: z.string().nullable(),
  previousRevisionId: z.string().nullable(),
  restoredFromRevisionId: z.string().nullable(),
  snapshotHash: z.string(),
  createdAtMs: z.number(),
});
export const revisionSchema = revisionSummarySchema.extend({ snapshotJson: z.string() });
export const safeDiffSchema = z.object({
  path: z.string(),
  kind: z.enum(["added", "removed", "changed"]),
  label: z.string().optional(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  sensitivity: z.enum(["normal", "secret-state"]).optional(),
});

const readErrors = [
  adminOperationErrors.invalidRequest,
  adminOperationErrors.authenticationRequired,
  adminOperationErrors.permissionDenied,
  adminOperationErrors.entitlementRequired,
  adminOperationErrors.unavailable,
  adminOperationErrors.internal,
] as const;
const metadata = {
  tags: ["Configuration Revisions"],
  feature: "configurationRevisions",
  entitlement: "premium-only-features",
} as const;

export const listConfigurationRevisions = defineAdminOperation({
  ...metadata,
  operationId: "configurationRevisions.get",
  method: "GET",
  path: "/admin/api/configuration-revisions",
  summary: "List configuration revision history",
  query: pageQuery,
  success: {
    status: 200,
    schema: z.object({
      revisions: z.array(revisionSummarySchema),
      nextCursor: z.number().nullable(),
    }),
    description: "A bounded page of redacted configuration revisions",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "read" },
});

export const compareConfigurationRevisions = defineAdminOperation({
  ...metadata,
  operationId: "configurationRevisionsCompare.get",
  method: "GET",
  path: "/admin/api/configuration-revisions/compare",
  summary: "Compare two configuration revisions",
  query: compareQuery,
  success: {
    status: 200,
    schema: z.object({ diff: z.array(safeDiffSchema) }),
    description: "A structural safe diff",
  },
  errors: [...readErrors, adminOperationErrors.resourceNotFound],
  access: { scope: "guild", mode: "read" },
});

export const getConfigurationRevision = defineAdminOperation({
  ...metadata,
  operationId: "configurationRevisionsDetail.get",
  method: "GET",
  path: "/admin/api/configuration-revisions/detail",
  summary: "Read one redacted configuration revision",
  query: detailQuery,
  success: {
    status: 200,
    schema: z.object({ revision: revisionSchema }),
    description: "A redacted configuration revision",
  },
  errors: [...readErrors, adminOperationErrors.resourceNotFound],
  access: { scope: "guild", mode: "read" },
});

export const exportConfigurationRevisions = defineAdminOperation({
  ...metadata,
  operationId: "configurationRevisionsExport.get",
  method: "GET",
  path: "/admin/api/configuration-revisions/export",
  summary: "Export bounded redacted configuration revisions",
  query: exportQuery,
  success: {
    status: 200,
    schema: z.object({
      revisions: z.array(revisionSchema),
      nextCursor: z.number().nullable(),
    }),
    description: "A bounded redacted JSON or JSONL export",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "read" },
});

const restorePreviewResponseSchema = z.object({
  diff: z.array(safeDiffSchema),
  warnings: z.array(z.string()),
  requiredSecretInputs: z.array(z.string()),
  followUpActions: z.array(z.string()),
  previewToken: z.string(),
  expiresAtMs: z.number(),
  destructive: z.boolean(),
});

export const restoreConfigurationRevision = defineAdminOperation({
  ...metadata,
  operationId: "configurationRevisionsRestore.post",
  method: "POST",
  path: "/admin/api/configuration-revisions/restore",
  summary: "Restore a server-validated configuration revision",
  body: restoreBody,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true), followUpActions: z.array(z.string()) }),
    description: "A new restore revision was committed",
  },
  errors: [...readErrors, adminOperationErrors.conflict],
  access: { scope: "guild", mode: "write" },
});

export const previewConfigurationRevisionRestore = defineAdminOperation({
  ...metadata,
  operationId: "configurationRevisionsRestorePreview.post",
  method: "POST",
  path: "/admin/api/configuration-revisions/restore-preview",
  summary: "Preview a server-validated configuration revision restore",
  body: restorePreviewBody,
  success: {
    status: 200,
    schema: restorePreviewResponseSchema,
    description: "A signed short-lived restore preview",
  },
  errors: [...readErrors, adminOperationErrors.conflict],
  access: { scope: "guild", mode: "write" },
});

export const configurationRevisionContracts = {
  list: listConfigurationRevisions,
  compare: compareConfigurationRevisions,
  detail: getConfigurationRevision,
  export: exportConfigurationRevisions,
  restore: restoreConfigurationRevision,
  restorePreview: previewConfigurationRevisionRestore,
} as const;
