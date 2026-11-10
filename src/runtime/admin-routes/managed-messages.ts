import { defineRoute, type Route } from "../admin-route-registry";
import { bodyGuildScopedAccess, guildScopedAccess } from "../admin-route-guards";
import type { ManagedMessageService } from "../../services/managed-message-service";
import { ManagedMessageError } from "../../services/managed-message-service";
import { ManagedMediaError, type ManagedMediaService } from "../../managed-media";
import { QuantityLimitError } from "../entitlement-checks";
import type { CustomerSession } from "../auth/customer-session";
import { adminErrorEnvelopeSchema, managedMessageContracts } from "../../contracts/admin";
import {
  getCachedGuildTicketResources,
  shouldRefreshAdminDiscordCache,
} from "../admin-discord-cache";

export function createManagedMessageAdminRoutes(options: {
  service: ManagedMessageService;
  mediaService: ManagedMediaService;
  discordBotToken: string;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
}): Array<Route<any, any, Response>> {
  return [
    defineRoute({
      ...managedMessageContracts.resources,
      feature: undefined,
      success: managedMessageContracts.resources.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      handler: async ({ query, url }) => {
        const resources = await getCachedGuildTicketResources(
          query.guildId,
          options.discordBotToken,
          shouldRefreshAdminDiscordCache(url),
        );
        return Response.json({
          guildId: query.guildId,
          roles: resources.roles.map(({ id, name }) => ({ id, name })),
          categories: resources.channels
            .filter((channel) => channel.type === 4)
            .map(({ id, name }) => ({ id, name })),
          textChannels: resources.channels
            .filter((channel) => channel.type === 0)
            .map(({ id, name }) => ({ id, name })),
          voiceChannels: resources.channels
            .filter((channel) => channel.type === 2)
            .map(({ id, name }) => ({ id, name })),
          stageChannels: resources.channels
            .filter((channel) => channel.type === 13)
            .map(({ id, name }) => ({ id, name })),
          forumChannels: resources.channels
            .filter((channel) => channel.type === 15)
            .map(({ id, name }) => ({ id, name })),
        });
      },
    }),
    defineRoute({
      ...managedMessageContracts.capabilities,
      feature: undefined,
      success: managedMessageContracts.capabilities.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("write"),
      handler: async () => Response.json({ canWrite: true }),
    }),
    defineRoute({
      ...managedMessageContracts.list,
      feature: undefined,
      success: managedMessageContracts.list.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      handler: async ({ query }) =>
        Response.json({
          guildId: query.guildId,
          messages: await options.service.list(query.guildId),
          drafts: await options.service.listDrafts(query.guildId),
        }),
    }),
    defineRoute({
      ...managedMessageContracts.uploadMedia,
      feature: undefined,
      success: managedMessageContracts.uploadMedia.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        try {
          const media = await options.mediaService.upload({
            guildId: body.guildId,
            contentType: body.contentType,
            dataBase64: body.dataBase64,
            requestOrigin: request.url,
          });
          try {
            await options.service.registerMediaAsset(body.guildId, media.filename);
          } catch (error) {
            await options.mediaService.delete({ guildId: body.guildId, filename: media.filename });
            throw error;
          }
          return Response.json({ media });
        } catch (error) {
          if (error instanceof ManagedMediaError) {
            return Response.json({ error: error.message }, { status: error.status });
          }
          throw error;
        }
      },
    }),
    defineRoute({
      ...managedMessageContracts.save,
      feature: undefined,
      success: managedMessageContracts.save.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        try {
          const actorUserId = await readActorUserId(options.readCustomerAdminSession, request);
          const input = {
            guildId: body.guildId,
            id: body.id,
            internalName: body.internalName,
            channelId: body.channelId,
            embeds: body.embeds,
            buttons: body.buttons ?? [],
            announcement: {
              roleIds: body.announcement?.roleIds ?? [],
              everyone: body.announcement?.everyone === true,
              here: body.announcement?.here === true,
              notifyOnCreate: body.announcement?.notifyOnCreate === true,
            },
          };
          if (body.action === "unpublish") {
            if (!body.id) throw new ManagedMessageError("Missing Managed Message id.");
            return Response.json({
              message: await options.service.unpublish(body.guildId, body.id, actorUserId),
            });
          }
          if (body.action === "save-draft") {
            return Response.json({ draft: await options.service.saveDraft(input) });
          }
          if (body.action === "schedule") {
            if (body.scheduledAtMs === undefined) {
              throw new ManagedMessageError("Missing Scheduled Publish time.");
            }
            return Response.json({
              draft: await options.service.scheduleDraft(input, body.scheduledAtMs, actorUserId),
            });
          }
          if (body.action === "cancel-schedule") {
            if (!body.id) throw new ManagedMessageError("Missing Managed Message Draft id.");
            return Response.json({
              draft: await options.service.cancelScheduledDraft(body.guildId, body.id, actorUserId),
            });
          }
          if (body.action === "publish-draft") {
            const draft = await options.service.saveDraft(input);
            return Response.json({
              message: await options.service.publishDraftNow(body.guildId, draft.id, actorUserId),
            });
          }
          return Response.json({
            message: await options.service.save(input, actorUserId, body.action === "republish"),
          });
        } catch (error) {
          if (error instanceof QuantityLimitError || error instanceof ManagedMessageError) {
            return Response.json(
              { error: error.message },
              { status: error instanceof ManagedMessageError ? error.status : 400 },
            );
          }
          throw error;
        }
      },
    }),
    defineRoute({
      ...managedMessageContracts.delete,
      feature: undefined,
      success: managedMessageContracts.delete.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        const actorUserId = await readActorUserId(options.readCustomerAdminSession, request);
        const deleted = body.draft
          ? await options.service.deleteDraft(body.guildId, body.id, actorUserId)
          : await options.service.delete(body.guildId, body.id, actorUserId);
        return Response.json({ ok: true, deleted });
      },
    }),
  ];
}

async function readActorUserId(
  readCustomerAdminSession: ((request: Request) => Promise<CustomerSession | null>) | undefined,
  request: Request,
): Promise<string | undefined> {
  if (!readCustomerAdminSession) return undefined;
  return (await readCustomerAdminSession(request))?.user.discordUserId;
}
