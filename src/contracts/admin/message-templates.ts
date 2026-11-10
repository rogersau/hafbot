import { z } from "zod";
import { adminOperationErrors, defineAdminOperation } from "./core";
import { managedMessageEmbedSchema } from "./managed-messages";

export const messageTemplateSchema = z.object({
  id: z.string(),
  guildId: z.string(),
  internalName: z.string(),
  embeds: z.array(managedMessageEmbedSchema),
  availableForTicketReplies: z.boolean(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

const guildQuerySchema = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
});
const saveBodySchema = z.object({
  action: z.enum(["save", "duplicate"]).optional(),
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  id: z.string().min(1).nullable().optional(),
  internalName: z.string(),
  embeds: z.array(managedMessageEmbedSchema).optional(),
  availableForTicketReplies: z.boolean().optional(),
});
const deleteBodySchema = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  id: z.string().min(1),
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
  tags: ["Managed Messages"],
  feature: undefined,
  entitlement: "messageTemplatesMax",
} as const;

export const deleteMessageTemplate = defineAdminOperation({
  ...metadata,
  operationId: "messageTemplates.delete",
  method: "DELETE",
  path: "/admin/api/message-templates",
  summary: "Delete a Message Template",
  body: deleteBodySchema,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true), deleted: z.boolean() }),
    description: "Whether the Message Template was deleted",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const listMessageTemplates = defineAdminOperation({
  ...metadata,
  operationId: "messageTemplates.get",
  method: "GET",
  path: "/admin/api/message-templates",
  summary: "List Message Templates",
  query: guildQuerySchema,
  success: {
    status: 200,
    schema: z.object({ guildId: z.string(), templates: z.array(messageTemplateSchema) }),
    description: "Message Templates for the Guild",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "read" },
});

export const saveMessageTemplate = defineAdminOperation({
  ...metadata,
  operationId: "messageTemplates.post",
  method: "POST",
  path: "/admin/api/message-templates",
  summary: "Save or duplicate a Message Template",
  body: saveBodySchema,
  success: {
    status: 200,
    schema: z.object({ template: messageTemplateSchema }),
    description: "The saved Message Template",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const messageTemplateContracts = {
  list: listMessageTemplates,
  save: saveMessageTemplate,
  delete: deleteMessageTemplate,
} as const;
