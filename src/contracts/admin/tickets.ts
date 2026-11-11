import { z } from "zod";
import {
  DISCORD_COMPONENT_CUSTOM_ID_MAX_LENGTH,
  DISCORD_MODAL_LABEL_MAX_LENGTH,
  DISCORD_TEXT_INPUT_CUSTOM_ID_MAX_LENGTH,
  DISCORD_TEXT_INPUT_PLACEHOLDER_MAX_LENGTH,
} from "../../discord/constants";
import { buildTicketOpenCustomId } from "../../tickets";
import { adminOperationErrors, defineAdminOperation } from "./core";

const optionalWorkspaceIdSchema = z.string().min(1).optional();
export const ticketQuerySchema = z.object({
  guildId: z.string().min(1),
  workspaceId: optionalWorkspaceIdSchema,
});
export const closedTicketsQuerySchema = ticketQuerySchema.extend({
  panelId: z.string().optional(),
  limit: z.string().optional(),
  beforeOpenedAtMs: z.string().optional(),
});
export const ticketSetupCheckQuerySchema = ticketQuerySchema.extend({
  panelId: z.string().optional(),
});
export const ticketPanelActionSchema = z.object({
  guildId: z.string().min(1),
  workspaceId: optionalWorkspaceIdSchema,
  panelId: z.string().min(1),
});
export const ticketTestActionSchema = ticketPanelActionSchema.extend({
  action: z.enum(["panel-post", "transcript-upload", "ai-summary"]),
});
export const ticketTranscriptActionSchema = z.object({
  guildId: z.string().min(1),
  workspaceId: optionalWorkspaceIdSchema,
  channelId: z.string().min(1),
});
export const createTicketPanelSchema = z.object({
  guildId: z.string().min(1),
  workspaceId: optionalWorkspaceIdSchema,
  mode: z.enum(["blank", "clone"]),
  sourcePanelId: z.string().min(1).optional(),
});

const ticketResponseConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("has-role"), roleId: z.string().min(1) }),
  z.object({ kind: z.literal("lacks-role"), roleId: z.string().min(1) }),
  z.object({
    kind: z.literal("lacks-platform-linked-role"),
    platform: z.enum(["steam", "xbox", "playstation"]).optional(),
  }),
]);
const ticketResponseRuleSchema = z.object({
  id: z.string().min(1),
  conditions: z.array(ticketResponseConditionSchema).max(5),
  message: z
    .string()
    .max(2000)
    .refine((value) => value.trim().length > 0, "Response Rule message cannot be empty"),
});
const ticketQuestionSchema = z.object({
  id: z.string().min(1).max(DISCORD_TEXT_INPUT_CUSTOM_ID_MAX_LENGTH),
  label: z.string().min(1).max(DISCORD_MODAL_LABEL_MAX_LENGTH),
  style: z.enum(["short", "paragraph"]),
  placeholder: z.string().max(DISCORD_TEXT_INPUT_PLACEHOLDER_MAX_LENGTH).nullable(),
  required: z.boolean(),
  validation: z.enum(["none", "steamId"]).optional(),
});
const ticketTypeShape = {
  enabled: z.boolean().optional(),
  id: z.string().min(1),
  label: z.string().min(1),
  emoji: z.string().nullable(),
  buttonStyle: z.enum(["primary", "secondary", "success", "danger"]),
  supportRoleId: z.string(),
  allowedCreatorRoleIds: z.array(z.string().min(1)).optional(),
  channelNamePrefix: z.string().min(1),
  questions: z.array(ticketQuestionSchema).max(5),
  defaultTicketLinkPlatform: z.enum(["steam", "xbox", "playstation"]).nullable().optional(),
  responseRules: z.array(ticketResponseRuleSchema).max(10).optional(),
  anonymousSupportEnabled: z.boolean().optional(),
  staffDiscussionThreadEnabled: z.boolean().optional(),
  ticketHistoryPromptVisibility: z.enum(["off", "staff-thread"]).optional(),
  participantManagementEnabled: z.boolean().optional(),
  limitExclusion: z.boolean().optional(),
  mentionSupportRole: z.boolean().optional(),
};
const ticketTypeSchema = z.object({
  ...ticketTypeShape,
  label: z.string().min(1).max(DISCORD_MODAL_LABEL_MAX_LENGTH),
});
const ticketPanelShapeSchema = z.object({
  guildId: z.string().min(1),
  workspaceId: optionalWorkspaceIdSchema,
  panelId: z.string().min(1).optional(),
  panelName: z.string().min(1).optional(),
  panelChannelId: z.string(),
  categoryChannelId: z.string(),
  transcriptChannelId: z.string(),
  panelEmoji: z.string().nullable().optional(),
  panelTitle: z.string().nullable().optional(),
  panelDescription: z.string().nullable().optional(),
  panelFooter: z.string().nullable().optional(),
  panelColor: z.number().int().min(0).max(0xffffff).optional(),
  panelMessageId: z.string().nullable(),
  ticketCreationLimit: z.number().int().min(1).max(50).nullable().optional(),
  ticketLimitRejectionMessage: z.string().nullable().optional(),
  enableTicketClaiming: z.boolean().optional(),
  aiTranscriptSummariesEnabled: z.boolean().optional(),
  ticketTypes: z.array(ticketTypeSchema),
});
export const ticketPanelConfigSchema = ticketPanelShapeSchema.superRefine((panel, context) => {
  const ids = new Set<string>();
  panel.ticketTypes.forEach((ticketType, index) => {
    if (ids.has(ticketType.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ticketTypes", index, "id"],
        message: "Duplicate Ticket Type id",
      });
    }
    ids.add(ticketType.id);
    if (
      buildTicketOpenCustomId(ticketType.id, panel.panelId ?? "main").length >
      DISCORD_COMPONENT_CUSTOM_ID_MAX_LENGTH
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ticketTypes", index, "id"],
        message: `Ticket Type open custom ID must be ${DISCORD_COMPONENT_CUSTOM_ID_MAX_LENGTH} characters or fewer`,
      });
    }
  });
});
const ticketTypeResponseSchema = z.object({
  ...ticketTypeShape,
  label: z.string().min(1).max(DISCORD_MODAL_LABEL_MAX_LENGTH),
  participantManagementEnabled: z.boolean(),
  responseRules: z.array(ticketResponseRuleSchema),
  limitExclusion: z.boolean(),
});
const ticketPanelResponseSchema = ticketPanelShapeSchema
  .extend({
    panelEmoji: z.string().nullable(),
    panelTitle: z.string().nullable(),
    panelDescription: z.string().nullable(),
    panelFooter: z.string().nullable(),
    ticketCreationLimit: z.number().int().min(1).max(50).nullable(),
    ticketLimitRejectionMessage: z.string().nullable(),
    enableTicketClaiming: z.boolean(),
    ticketTypes: z.array(ticketTypeResponseSchema),
  })
  .omit({ workspaceId: true });
const ticketInstanceSchema = z.object({
  guildId: z.string(),
  channelId: z.string(),
  panelId: z.string().nullable().optional(),
  ticketTypeId: z.string(),
  ticketTypeLabel: z.string(),
  openerUserId: z.string(),
  supportRoleId: z.string().nullable(),
  status: z.enum(["open", "closed"]),
  answers: z.array(z.object({ questionId: z.string(), label: z.string(), value: z.string() })),
  openedAtMs: z.number(),
  closedAtMs: z.number().nullable(),
  closedByUserId: z.string().nullable(),
  transcriptMessageId: z.string().nullable(),
  staffThreadId: z.string().nullable(),
  claimedByUserId: z.string().nullable().optional(),
  claimedAtMs: z.number().nullable().optional(),
});
const configurationRevisionOperationSchema = z.enum([
  "baseline",
  "create",
  "update",
  "delete",
  "restore",
  "clone",
]);
const configurationRevisionSourceSchema = z.enum([
  "dashboard-save",
  "restore",
  "clone",
  "system-snapshot",
]);
const configurationRevisionSummarySchema = z.object({
  id: z.string(),
  operation: configurationRevisionOperationSchema,
  source: configurationRevisionSourceSchema,
  actorUserId: z.string().nullable(),
  operationId: z.string(),
  correlationId: z.string().nullable(),
  previousRevisionId: z.string().nullable(),
  restoredFromRevisionId: z.string().nullable(),
  snapshotHash: z.string(),
  createdAtMs: z.number(),
});
const ticketRevisionHistoryQuerySchema = ticketQuerySchema.extend({
  panelId: z.string().min(1),
  limit: z.string().optional(),
  beforeCreatedAtMs: z.string().optional(),
});
const ticketRevisionDetailQuerySchema = ticketQuerySchema.extend({
  revisionId: z.string().min(1),
});
const ticketRevisionRestorePreviewSchema = z.object({
  guildId: z.string().min(1),
  workspaceId: optionalWorkspaceIdSchema,
  revisionId: z.string().min(1),
});
const ticketRevisionRestoreSchema = ticketRevisionRestorePreviewSchema.extend({
  previewToken: z.string().min(1),
});
const configurationRevisionSchema = configurationRevisionSummarySchema.extend({
  guildId: z.string(),
  feature: z.literal("tickets"),
  resourceKey: z.string(),
  schemaVersion: z.number().int().positive(),
  snapshotJson: z.string(),
});
const configurationDiffEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(["added", "removed", "changed"]),
  label: z.string().optional(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  sensitivity: z.enum(["normal", "secret-state"]).optional(),
});
const resourceSchema = z.object({ id: z.string(), name: z.string() });
const setupStatusSchema = z.enum(["ok", "warning", "error"]);
const ticketSetupCheckResponseSchema = z.object({
  guildId: z.string(),
  panelId: z.string().nullable(),
  overallStatus: setupStatusSchema,
  checks: z.array(
    z.object({ id: z.string(), label: z.string(), status: setupStatusSchema, detail: z.string() }),
  ),
  testActions: z.array(
    z.object({
      action: z.enum(["panel-post", "transcript-upload", "ai-summary"]),
      label: z.string(),
      enabled: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
});
const readErrors = [
  adminOperationErrors.invalidRequest,
  adminOperationErrors.authenticationRequired,
  adminOperationErrors.permissionDenied,
  adminOperationErrors.unavailable,
  adminOperationErrors.internal,
] as const;
const writeErrors = [
  ...readErrors,
  adminOperationErrors.entitlementRequired,
  adminOperationErrors.resourceNotFound,
  adminOperationErrors.conflict,
] as const;
const metadata = {
  tags: ["Tickets"],
  feature: "tickets",
  entitlement: undefined,
} as const;

export const listClosedTickets = defineAdminOperation({
  ...metadata,
  operationId: "ticketsClosed.get",
  method: "GET",
  path: "/admin/api/tickets/closed",
  summary: "List closed Tickets",
  query: closedTicketsQuerySchema,
  success: {
    status: 200,
    schema: z.object({
      tickets: z.array(ticketInstanceSchema),
      total: z.number(),
      nextCursor: z.number().nullable(),
    }),
    description: "A page of closed Tickets",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "read" },
});

export const createTicketPanel = defineAdminOperation({
  ...metadata,
  operationId: "ticketsPanelCreate.post",
  method: "POST",
  path: "/admin/api/tickets/panel/create",
  summary: "Create a Ticket Panel",
  body: createTicketPanelSchema,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true), panel: ticketPanelResponseSchema }),
    description: "The created Ticket Panel",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const deleteTicketPanel = defineAdminOperation({
  ...metadata,
  operationId: "ticketsPanelDelete.post",
  method: "POST",
  path: "/admin/api/tickets/panel/delete",
  summary: "Delete or reset a Ticket Panel",
  body: ticketPanelActionSchema,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true) }),
    description: "The Ticket Panel was deleted or reset",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const getTicketPanel = defineAdminOperation({
  ...metadata,
  operationId: "ticketsPanel.get",
  method: "GET",
  path: "/admin/api/tickets/panel",
  summary: "Read Ticket Panels",
  query: ticketQuerySchema,
  success: {
    status: 200,
    schema: z.object({
      panel: ticketPanelResponseSchema.nullable(),
      panels: z.array(ticketPanelResponseSchema),
    }),
    description: "Ticket Panels for the Guild",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "read" },
});

export const saveTicketPanel = defineAdminOperation({
  ...metadata,
  operationId: "ticketsPanel.post",
  method: "POST",
  path: "/admin/api/tickets/panel",
  summary: "Save a Ticket Panel",
  body: ticketPanelConfigSchema,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true), panel: ticketPanelResponseSchema }),
    description: "The saved Ticket Panel",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const publishTicketPanel = defineAdminOperation({
  ...metadata,
  operationId: "ticketsPanelPublish.post",
  method: "POST",
  path: "/admin/api/tickets/panel/publish",
  summary: "Publish a Ticket Panel",
  body: ticketPanelConfigSchema,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true), panelMessageId: z.string() }),
    description: "The published Ticket Panel message",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const getTicketPanelRevision = defineAdminOperation({
  ...metadata,
  operationId: "ticketsPanelRevision.get",
  method: "GET",
  path: "/admin/api/tickets/panel/revision",
  summary: "Read one Ticket Panel configuration revision",
  query: ticketRevisionDetailQuerySchema,
  success: {
    status: 200,
    schema: z.object({
      revision: configurationRevisionSchema,
      diff: z.array(configurationDiffEntrySchema),
    }),
    description: "A safe Ticket Panel revision and its structural diff",
  },
  errors: [...readErrors, adminOperationErrors.resourceNotFound],
  access: { scope: "guild", mode: "read" },
});

export const listTicketPanelRevisions = defineAdminOperation({
  ...metadata,
  operationId: "ticketsPanelRevisions.get",
  method: "GET",
  path: "/admin/api/tickets/panel/revisions",
  summary: "List Ticket Panel configuration revisions",
  query: ticketRevisionHistoryQuerySchema,
  success: {
    status: 200,
    schema: z.object({
      revisions: z.array(configurationRevisionSummarySchema),
      nextCursor: z.number().nullable(),
    }),
    description: "A page of safe Ticket Panel revision history",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "read" },
});

export const previewTicketPanelRevisionRestore = defineAdminOperation({
  ...metadata,
  operationId: "ticketsPanelRevisionRestorePreview.post",
  method: "POST",
  path: "/admin/api/tickets/panel/revision/restore-preview",
  summary: "Preview a validated Ticket Panel revision restore",
  body: ticketRevisionRestorePreviewSchema,
  success: {
    status: 200,
    schema: z.object({
      diff: z.array(configurationDiffEntrySchema),
      warnings: z.array(z.string()),
      requiredSecretInputs: z.array(z.string()),
      followUpActions: z.array(z.string()),
      previewToken: z.string(),
      expiresAtMs: z.number(),
      destructive: z.boolean(),
    }),
    description: "A server-authoritative safe restore preview",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const restoreTicketPanelRevision = defineAdminOperation({
  ...metadata,
  operationId: "ticketsPanelRevisionRestore.post",
  method: "POST",
  path: "/admin/api/tickets/panel/revision/restore",
  summary: "Restore a validated Ticket Panel revision",
  body: ticketRevisionRestoreSchema,
  success: {
    status: 200,
    schema: z.object({
      ok: z.literal(true),
      panel: ticketPanelResponseSchema.nullable(),
      followUpActions: z.array(z.string()),
    }),
    description: "The newly versioned restored Ticket Panel configuration",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const unpublishTicketPanel = defineAdminOperation({
  ...metadata,
  operationId: "ticketsPanelUnpublish.post",
  method: "POST",
  path: "/admin/api/tickets/panel/unpublish",
  summary: "Unpublish a Ticket Panel",
  body: ticketPanelActionSchema,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true), panel: ticketPanelResponseSchema }),
    description: "The unpublished Ticket Panel",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const getTicketResources = defineAdminOperation({
  ...metadata,
  operationId: "ticketsResources.get",
  method: "GET",
  path: "/admin/api/tickets/resources",
  summary: "List Discord resources for Tickets",
  query: ticketQuerySchema.extend({ refresh: z.string().optional() }),
  success: {
    status: 200,
    schema: z.object({
      guildId: z.string(),
      roles: z.array(resourceSchema),
      categories: z.array(resourceSchema),
      textChannels: z.array(resourceSchema),
      voiceChannels: z.array(resourceSchema),
      stageChannels: z.array(resourceSchema),
      forumChannels: z.array(resourceSchema),
      emojis: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          animated: z.boolean(),
          available: z.boolean(),
        }),
      ),
      configuredTicketLinkPlatforms: z.array(z.enum(["steam", "xbox", "playstation"])),
    }),
    description: "Discord resources available to Tickets",
  },
  errors: [...readErrors, adminOperationErrors.discordRateLimited],
  access: { scope: "guild", mode: "read" },
});

export const getTicketSetupCheck = defineAdminOperation({
  ...metadata,
  operationId: "ticketsSetupCheck.get",
  method: "GET",
  path: "/admin/api/tickets/setup-check",
  summary: "Diagnose Ticket Panel setup",
  query: ticketSetupCheckQuerySchema,
  success: {
    status: 200,
    schema: ticketSetupCheckResponseSchema,
    description: "Ticket Panel setup diagnostics",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "read" },
});

export const runTicketTestAction = defineAdminOperation({
  ...metadata,
  operationId: "ticketsTestAction.post",
  method: "POST",
  path: "/admin/api/tickets/test-action",
  summary: "Run a Ticket Panel setup test",
  body: ticketTestActionSchema,
  success: {
    status: 200,
    schema: z.object({
      ok: z.boolean(),
      action: z.enum(["panel-post", "transcript-upload", "ai-summary"]),
      status: z.enum(["success", "skipped", "failed"]),
      message: z.string(),
    }),
    description: "The Ticket setup test outcome",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const rotateTicketTranscript = defineAdminOperation({
  ...metadata,
  operationId: "ticketsTranscriptRotate.post",
  method: "POST",
  path: "/admin/api/tickets/transcript/rotate",
  summary: "Rotate a Ticket transcript bearer link",
  body: ticketTranscriptActionSchema,
  success: {
    status: 200,
    schema: z.object({ url: z.string().min(1), expiresAtMs: z.number().int() }),
    description: "A replacement Ticket transcript link",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const revokeTicketTranscript = defineAdminOperation({
  ...metadata,
  operationId: "ticketsTranscriptRevoke.post",
  method: "POST",
  path: "/admin/api/tickets/transcript/revoke",
  summary: "Revoke a Ticket transcript bearer link",
  body: ticketTranscriptActionSchema,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true) }),
    description: "The Ticket transcript link was revoked",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const ticketContracts = {
  closed: listClosedTickets,
  createPanel: createTicketPanel,
  deletePanel: deleteTicketPanel,
  panel: getTicketPanel,
  savePanel: saveTicketPanel,
  publishPanel: publishTicketPanel,
  revision: getTicketPanelRevision,
  revisions: listTicketPanelRevisions,
  restorePreview: previewTicketPanelRevisionRestore,
  restore: restoreTicketPanelRevision,
  unpublishPanel: unpublishTicketPanel,
  resources: getTicketResources,
  setupCheck: getTicketSetupCheck,
  testAction: runTicketTestAction,
  rotateTranscript: rotateTicketTranscript,
  revokeTranscript: revokeTicketTranscript,
} as const;
