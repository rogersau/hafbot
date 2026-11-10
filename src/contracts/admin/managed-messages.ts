import { z } from "zod";
import { MAX_MANAGED_MEDIA_BASE64_LENGTH } from "../../managed-media";
import { adminOperationErrors, defineAdminOperation } from "./core";

const guildQuery = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
});
export const managedMessageEmbedFieldSchema = z.object({
  name: z.string(),
  value: z.string(),
  inline: z.boolean(),
});
export const managedMessageEmbedSchema = z.object({
  title: z.string().optional(),
  description: z.string(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  imageUrl: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  footer: z.string().optional(),
  fields: z.array(managedMessageEmbedFieldSchema),
});
export const managedMessageLinkButtonSchema = z.object({
  label: z.string().max(80),
  url: z.string().max(512),
  emoji: z.string().max(100).optional(),
});
const announcement = z.object({
  roleIds: z.array(z.string()),
  everyone: z.boolean(),
  here: z.boolean(),
  notifyOnCreate: z.boolean(),
});
const message = z.object({
  id: z.string(),
  guildId: z.string(),
  internalName: z.string(),
  channelId: z.string(),
  messageId: z.string(),
  embeds: z.array(managedMessageEmbedSchema),
  buttons: z.array(managedMessageLinkButtonSchema).max(5).optional(),
  announcement,
  status: z.enum(["published", "missing", "unpublishing", "unpublished"]),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});
const draft = z.object({
  id: z.string(),
  guildId: z.string(),
  internalName: z.string(),
  channelId: z.string(),
  embeds: z.array(managedMessageEmbedSchema),
  buttons: z.array(managedMessageLinkButtonSchema).max(5).optional(),
  announcement,
  status: z.enum(["draft", "scheduled", "failed"]),
  scheduledAtMs: z.number().nullable(),
  failureReason: z.string().nullable(),
  attemptCount: z.number().int(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});
const saveBody = z.object({
  action: z
    .enum([
      "save",
      "save-draft",
      "schedule",
      "cancel-schedule",
      "publish-draft",
      "unpublish",
      "republish",
    ])
    .optional(),
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  id: z.string().nullable().optional(),
  internalName: z.string(),
  channelId: z.string().min(1),
  embeds: z.array(managedMessageEmbedSchema),
  buttons: z.array(managedMessageLinkButtonSchema).max(5).optional(),
  announcement,
  scheduledAtMs: z.number().int().positive().optional(),
});
const deleteBody = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  id: z.string().min(1),
  draft: z.boolean().optional(),
});
const uploadMediaBody = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  filename: z.string().min(1).max(255),
  contentType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  dataBase64: z.string().min(1).max(MAX_MANAGED_MEDIA_BASE64_LENGTH),
});
const managedMedia = z.object({
  url: z.string(),
  filename: z.string(),
  contentType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  sizeBytes: z.number().int().positive(),
});
const resource = z.object({ id: z.string(), name: z.string() });

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
const managedMessagesMetadata = {
  tags: ["Managed Messages"],
  access: { scope: "guild", mode: "read" },
  feature: undefined,
  entitlement: undefined,
} as const;

export const deleteManagedMessage = defineAdminOperation({
  ...managedMessagesMetadata,
  operationId: "managedMessages.delete",
  method: "DELETE",
  path: "/admin/api/managed-messages",
  summary: "Delete a Managed Message or draft",
  body: deleteBody,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true), deleted: z.boolean() }),
    description: "Whether the Managed Message or draft was deleted",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const listManagedMessages = defineAdminOperation({
  ...managedMessagesMetadata,
  operationId: "managedMessages.get",
  method: "GET",
  path: "/admin/api/managed-messages",
  summary: "List Managed Messages and drafts",
  query: guildQuery,
  success: {
    status: 200,
    schema: z.object({ guildId: z.string(), messages: z.array(message), drafts: z.array(draft) }),
    description: "Managed Messages and drafts for the Guild",
  },
  errors: readErrors,
});

export const saveManagedMessage = defineAdminOperation({
  ...managedMessagesMetadata,
  operationId: "managedMessages.post",
  method: "POST",
  path: "/admin/api/managed-messages",
  summary: "Save, schedule, or publish a Managed Message",
  body: saveBody,
  success: {
    status: 200,
    schema: z.union([z.object({ message }), z.object({ draft })]),
    description: "The saved Managed Message or draft",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
  entitlement: "managedMessagesMax",
});

export const uploadManagedMessageMedia = defineAdminOperation({
  ...managedMessagesMetadata,
  operationId: "managedMessages.media.post",
  method: "POST",
  path: "/admin/api/managed-messages/media",
  summary: "Upload an image for a Managed Message embed",
  body: uploadMediaBody,
  success: {
    status: 200,
    schema: z.object({ media: managedMedia }),
    description: "The uploaded Guild-managed image",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const getManagedMessageCapabilities = defineAdminOperation({
  ...managedMessagesMetadata,
  operationId: "managedMessagesCapabilities.get",
  method: "GET",
  path: "/admin/api/managed-messages/capabilities",
  summary: "Read Managed Messages capabilities",
  query: guildQuery,
  success: {
    status: 200,
    schema: z.object({ canWrite: z.boolean() }),
    description: "Managed Messages capabilities for the actor",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "write" },
});

export const getManagedMessageResources = defineAdminOperation({
  ...managedMessagesMetadata,
  operationId: "managedMessagesResources.get",
  method: "GET",
  path: "/admin/api/managed-messages/resources",
  summary: "List Discord resources for Managed Messages",
  query: guildQuery,
  success: {
    status: 200,
    schema: z.object({
      guildId: z.string(),
      roles: z.array(resource),
      categories: z.array(resource),
      textChannels: z.array(resource),
      voiceChannels: z.array(resource),
      stageChannels: z.array(resource),
      forumChannels: z.array(resource),
    }),
    description: "Discord roles and channels available to Managed Messages",
  },
  errors: [...readErrors, adminOperationErrors.discordRateLimited],
});

export const managedMessageContracts = {
  list: listManagedMessages,
  resources: getManagedMessageResources,
  capabilities: getManagedMessageCapabilities,
  save: saveManagedMessage,
  uploadMedia: uploadManagedMessageMedia,
  delete: deleteManagedMessage,
} as const;
