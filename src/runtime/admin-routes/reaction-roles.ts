import { z } from "zod";
import { DiscordApiError } from "../../discord/client";
import { listGuildTicketResources, listGuildEmojis } from "../../discord/guilds";
import { createDiscordReactionRoleOperations } from "../../discord/reaction-roles";
import { reactionRoleSettingsSchema } from "../../reaction-roles";
import { ReactionRoleError, ReactionRoleService } from "../../services/reaction-role-service";
import { postMemberAuditEvent } from "../../services/guild-audit-log-service";
import { defineRoute, type Route } from "../admin-route-registry";
import {
  bodyGuildScopedAccess,
  guildScopedAccess,
  requireGuildQueryId,
} from "../admin-route-guards";
import type { AdminRoutesOptions } from "./index";

const scope = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  panelId: z.string().min(1).max(100).optional(),
});

export function createReactionRolesAdminRoutes(
  options: AdminRoutesOptions,
): Route<any, any, Response>[] {
  const store = options.stores.reactionRoles;
  if (!store) return [];
  const resolveBot = async (guildId: string) =>
    options.resolveGuildBotIdentity
      ? options.resolveGuildBotIdentity(guildId)
      : { token: options.discordBotToken, userId: options.discordBotUserId ?? "" };
  async function mutate(
    request: Request,
    guildId: string,
    action: string,
    operation: (service: ReactionRoleService) => Promise<unknown>,
  ) {
    try {
      const bot = await resolveBot(guildId);
      const panel = await operation(
        new ReactionRoleService(store!, createDiscordReactionRoleOperations(bot.token), bot.userId),
      );
      const actorUserId = (await options.readCustomerAdminSession?.(request))?.user.discordUserId;
      await postMemberAuditEvent(
        "reaction-role.config-change",
        {
          guildId,
          ...(actorUserId ? { user: { id: actorUserId } } : {}),
          context: { Action: action },
        },
        options.stores.guildAuditLog,
        bot.token,
      );
      return Response.json({ panel: panel ?? null, panels: await store!.listPanels(guildId) });
    } catch (error) {
      if (error instanceof ReactionRoleError)
        return Response.json({ error: error.message }, { status: 409 });
      if (error instanceof DiscordApiError && (error.status === 403 || error.status === 404)) {
        return Response.json(
          {
            error:
              "Discord could not update the panel. Check that the channel, message, emoji, and roles still exist and HAF Bot has the required permissions. Retry publishing after correcting them.",
          },
          { status: 409 },
        );
      }
      throw error;
    }
  }
  return [
    defineRoute({
      method: "GET",
      path: "/admin/api/reaction-roles/resources",
      feature: "reactionRoles",
      query: scope.partial(),
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const bot = await resolveBot(guildId);
        const [resources, emojis] = await Promise.all([
          listGuildTicketResources(guildId, bot.token),
          listGuildEmojis(guildId, bot.token),
        ]);
        return Response.json({
          guildId,
          roles: resources.roles.map(({ id, name }) => ({ id, name })),
          textChannels: resources.channels
            .filter((channel) => channel.type === 0 || channel.type === 5)
            .map(({ id, name }) => ({ id, name })),
          categories: [],
          voiceChannels: [],
          forumChannels: [],
          emojis: emojis
            .filter((emoji) => emoji.id && emoji.name)
            .map((emoji) => ({
              id: emoji.id,
              name: emoji.name,
              animated: emoji.animated === true,
              available: emoji.available !== false,
            })),
        });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/reaction-roles",
      feature: "reactionRoles",
      query: scope.partial(),
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        return Response.json({
          panel: await store.readPanel(guildId, query.panelId),
          panels: await store.listPanels(guildId),
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/reaction-roles",
      feature: "reactionRoles",
      body: scope.extend({
        settings: reactionRoleSettingsSchema,
        panelId: z.string().min(1).max(100).nullable().optional(),
      }),
      access: bodyGuildScopedAccess("write"),
      handler: ({ body, request }) =>
        mutate(request, body.guildId, "Save panel", (service) =>
          service.save(body.guildId, body.settings, body.panelId),
        ),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/reaction-roles/publish",
      feature: "reactionRoles",
      body: scope,
      access: bodyGuildScopedAccess("write"),
      handler: ({ body, request }) =>
        mutate(request, body.guildId, "Publish panel", (service) =>
          service.publish(body.guildId, body.panelId),
        ),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/reaction-roles/enabled",
      feature: "reactionRoles",
      body: scope.extend({ enabled: z.boolean() }),
      access: bodyGuildScopedAccess("write"),
      handler: ({ body, request }) =>
        mutate(request, body.guildId, body.enabled ? "Enable panel" : "Pause panel", (service) =>
          service.setEnabled(body.guildId, body.enabled, body.panelId),
        ),
    }),
    defineRoute({
      method: "DELETE",
      path: "/admin/api/reaction-roles",
      feature: "reactionRoles",
      body: scope,
      access: bodyGuildScopedAccess("write"),
      handler: ({ body, request }) =>
        mutate(request, body.guildId, "Delete panel", (service) =>
          service.delete(body.guildId, body.panelId),
        ),
    }),
  ];
}
