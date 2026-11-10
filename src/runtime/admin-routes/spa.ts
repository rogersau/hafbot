import { z } from "zod";

import {
  MAX_BLOCKLIST_BATCH_EMOJIS,
  normalizeBlocklistEmojis,
  parseBlocklistEmojis,
} from "../../blocklist";
import {
  describeTimedRoleAssignmentFailure,
  describeTimedRoleRemovalFailure,
  parseTimedRoleDuration,
} from "../../timed-roles";
import {
  createDiscordGuildResourceValidator,
  type GuildResourceValidator,
} from "../../discord/guild-resource-validator";
import { validateTimedRoleDmTemplate } from "../../services/timed-role-service";
import { QuantityLimitError } from "../entitlement-checks";
import { defineRoute, type Route } from "../admin-route-registry";
import { bodyGuildScopedAccess, guildScopedAccess } from "../admin-route-guards";
import { bindAdminContract } from "../admin-contract-route";
import {
  getAdminOverview,
  linkWorkspaceGuild,
  listWorkspaceGuilds,
  listWorkspaces,
  unlinkWorkspaceGuild,
} from "../../contracts/admin/cross-cutting";
import type { AdminRoutesOptions } from "./index";

const guildIdQuerySchema = z.object({
  guildId: z.string().min(1, "guildId is required"),
  workspaceId: z.string().min(1).optional(),
});
const blocklistMutationBodySchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
    guildId: z.string().min(1, "Missing guildId"),
    action: z.enum(["add", "remove"]),
    emoji: z.string().min(1, "Missing emoji").optional(),
    emojis: z
      .array(z.string().min(1, "Missing emoji").max(100, "Emoji is too long"))
      .min(1, "At least one emoji is required")
      .max(
        MAX_BLOCKLIST_BATCH_EMOJIS,
        `A batch may contain at most ${MAX_BLOCKLIST_BATCH_EMOJIS} emojis`,
      )
      .optional(),
  })
  .strict()
  .superRefine((body, context) => {
    const hasSingleEmoji = body.emoji !== undefined;
    const hasBatchEmojis = body.emojis !== undefined;
    if (hasSingleEmoji === hasBatchEmojis) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasBatchEmojis ? "emoji" : "emojis"],
        message: "Provide either emoji or emojis, not both.",
      });
    }
    if (hasBatchEmojis && body.action !== "add") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "Batch emoji mutations only support add.",
      });
    }
  });

const channelBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
  notificationChannelId: z.string().nullable(),
});

const channelFilterBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
  channelMode: z.enum(["include", "exclude"]).default("include"),
  channelIds: z.array(z.string()).default([]),
});

const timedRoleRuleSchema = z.object({
  enabled: z.boolean().optional(),
  roleId: z.string().min(1, "Missing roleId"),
  durationInput: z.string().min(1, "Missing durationInput"),
  dmMessage: z.string().max(500).nullable().optional(),
  suspendedRoleIds: z.array(z.string().min(1)).optional(),
});

const timedRoleConfigBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
  roles: z.array(timedRoleRuleSchema),
});

const timedRoleMutationBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    guildId: z.string().min(1, "Missing guildId"),
    userId: z.string().min(1, "Missing userId"),
    roleId: z.string().min(1, "Missing roleId"),
    duration: z.string().min(1, "Missing duration"),
    suspendedRoleIds: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    action: z.literal("remove"),
    guildId: z.string().min(1, "Missing guildId"),
    userId: z.string().min(1, "Missing userId"),
    roleId: z.string().min(1, "Missing roleId"),
  }),
]);

export function createSpaAdminRoutes(
  options: AdminRoutesOptions,
): Array<Route<any, any, Response>> {
  const services = options.adminRouteServices;
  if (!services) return [];
  const guildResources =
    options.guildResources ?? createDiscordGuildResourceValidator(options.discordBotToken);

  return [
    defineRoute({
      method: "POST",
      path: "/admin/api/blocklist/enabled",
      body: z.object({ guildId: z.string().min(1), enabled: z.boolean() }),
      access: bodyGuildScopedAccess("write"),
      feature: "blocklist",
      handler: async ({ body }) => {
        await services.blocklistService.setEnabled(body.guildId, body.enabled);
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      ...bindAdminContract(listWorkspaces),
      method: "GET",
      path: "/admin/api/workspaces",
      access: { mode: "read", customerSessionOnly: true },
      handler: async ({ request }) => {
        if (!options.workspaceApi) {
          return Response.json(
            { error: "Workspace administration is not configured." },
            { status: 404 },
          );
        }
        return Response.json(await options.workspaceApi.listWorkspaces(request));
      },
    }),
    defineRoute({
      ...bindAdminContract(listWorkspaceGuilds),
      method: "GET",
      path: "/admin/api/workspace-guilds",
      access: ({ query }) => ({
        mode: "read",
        workspaceId: (query as { workspaceId: string }).workspaceId,
      }),
      handler: async ({ request, query }) => {
        if (!options.workspaceApi) {
          return Response.json(
            { error: "Workspace administration is not configured." },
            { status: 404 },
          );
        }
        const value = await options.workspaceApi.listWorkspaceGuilds(request, query.workspaceId);
        return value instanceof Response ? value : Response.json(value);
      },
    }),
    defineRoute({
      ...bindAdminContract(linkWorkspaceGuild),
      method: "POST",
      path: "/admin/api/workspace-guilds",
      access: { mode: "write", workspaceOnly: true },
      handler: ({ request, body }) =>
        options.workspaceApi
          ? options.workspaceApi.linkGuild(request, body)
          : Response.json(
              { error: "Workspace administration is not configured." },
              { status: 404 },
            ),
    }),
    defineRoute({
      ...bindAdminContract(unlinkWorkspaceGuild),
      method: "POST",
      path: "/admin/api/workspace-guilds/delete",
      access: { mode: "write", workspaceOnly: true },
      handler: ({ request, body }) =>
        options.workspaceApi
          ? options.workspaceApi.unlinkGuild(request, body)
          : Response.json(
              { error: "Workspace administration is not configured." },
              { status: 404 },
            ),
    }),
    defineRoute({
      ...bindAdminContract(getAdminOverview),
      method: "GET",
      path: "/admin/api/overview",
      access: { mode: "read", allowGuildAdminDirectory: true },
      handler: async ({ request, url }) => {
        const overview = await services.adminOverviewService.getOverview(
          url.searchParams.get("refresh") === "1",
        );
        if (!options.listAuthorizedCustomerGuildIds) return Response.json(overview);
        const authorizedGuildIds = await options.listAuthorizedCustomerGuildIds(request);
        if (authorizedGuildIds instanceof Response) return authorizedGuildIds;
        if (authorizedGuildIds === null) return Response.json(overview);
        const allowed = new Set(authorizedGuildIds);
        return Response.json({
          ...overview,
          guilds: overview.guilds.filter((guild) => allowed.has(guild.guildId)),
        });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/blocklist",
      query: guildIdQuerySchema,
      access: guildScopedAccess("read"),
      feature: "blocklist",
      handler: async ({ query }) => {
        const guildConfig = await services.blocklistService.getGuildBlocklist(query.guildId);
        return Response.json({
          guildId: query.guildId,
          ...guildConfig,
          notificationChannelId: await services.blocklistService.getGuildNotificationChannel(
            query.guildId,
          ),
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/blocklist",
      body: blocklistMutationBodySchema,
      access: bodyGuildScopedAccess("write"),
      feature: "blocklist",
      handler: async ({ body }) => {
        if (body.emojis !== undefined) {
          const normalizedBatch = normalizeBlocklistEmojis(body.emojis);
          if (normalizedBatch.length === 0) {
            return Response.json({ error: "Invalid emoji" }, { status: 400 });
          }
          if (normalizedBatch.length > MAX_BLOCKLIST_BATCH_EMOJIS) {
            return Response.json(
              {
                error: `A batch may contain at most ${MAX_BLOCKLIST_BATCH_EMOJIS} emojis`,
              },
              { status: 400 },
            );
          }
          try {
            const result = await services.blocklistService.addEmojis(body.guildId, body.emojis, {
              label: "Admin dashboard",
            });
            return Response.json({
              ok: true,
              ...result,
              blocklist: await services.blocklistService.getGuildBlocklist(body.guildId),
            });
          } catch (error) {
            if (error instanceof QuantityLimitError)
              return Response.json({ error: error.message }, { status: 400 });
            throw error;
          }
        }

        const emojis = parseBlocklistEmojis(body.emoji ?? null);
        if (emojis.length === 0) return Response.json({ error: "Invalid emoji" }, { status: 400 });
        if (body.action === "add") {
          try {
            await services.blocklistService.addEmojis(body.guildId, emojis, {
              label: "Admin dashboard",
            });
          } catch (error) {
            if (error instanceof QuantityLimitError)
              return Response.json({ error: error.message }, { status: 400 });
            throw error;
          }
        } else {
          for (const emoji of emojis) {
            await services.blocklistService.removeEmoji(body.guildId, emoji, {
              label: "Admin dashboard",
            });
          }
        }
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/blocklist-channel",
      body: channelBodySchema,
      access: bodyGuildScopedAccess("write"),
      feature: "blocklist",
      handler: async ({ body }) => {
        if (body.notificationChannelId)
          await guildResources.requireTextChannel(body.guildId, body.notificationChannelId);
        await services.blocklistService.updateGuildNotificationChannel(
          body.guildId,
          body.notificationChannelId,
        );
        return Response.json(body);
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/blocklist-channel-filter",
      body: channelFilterBodySchema,
      access: bodyGuildScopedAccess("write"),
      feature: "blocklist",
      handler: async ({ body }) => {
        const resources = await guildResources.forGuild(body.guildId);
        resources.requireChannels(body.channelIds ?? []);
        await services.blocklistService.updateGuildChannelFilter(
          body.guildId,
          body.channelMode ?? "include",
          body.channelIds ?? [],
        );
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/timed-roles",
      query: guildIdQuerySchema,
      access: guildScopedAccess("read"),
      feature: "timedRoles",
      handler: async ({ query }) =>
        Response.json({
          guildId: query.guildId,
          assignments: await services.timedRoleService.listTimedRoles(query.guildId),
          notificationChannelId: await services.timedRoleService.getGuildNotificationChannel(
            query.guildId,
          ),
          newMemberRoleConfig: await services.timedRoleService.getNewMemberTimedRoleConfig(
            query.guildId,
          ),
          manualAssignmentRoleConfig:
            await services.timedRoleService.getManualAssignmentTimedRoleConfig(query.guildId),
        }),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/timed-role-channel",
      body: channelBodySchema,
      access: bodyGuildScopedAccess("write"),
      feature: "timedRoles",
      handler: async ({ body }) => {
        if (body.notificationChannelId)
          await guildResources.requireTextChannel(body.guildId, body.notificationChannelId);
        await services.timedRoleService.updateGuildNotificationChannel(
          body.guildId,
          body.notificationChannelId,
        );
        return Response.json(body);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/timed-roles/resources",
      query: guildIdQuerySchema,
      access: guildScopedAccess("read"),
      feature: "timedRoles",
      handler: async ({ query }) => {
        const resources = await services.timedRoleService.getManageableGuildResources(
          query.guildId,
        );
        return Response.json({
          guildId: query.guildId,
          roles: resources.roles,
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
          emojis: [],
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/timed-roles/new-member-config",
      body: timedRoleConfigBodySchema,
      access: bodyGuildScopedAccess("write"),
      feature: "timedRoles",
      handler: async ({ body }) =>
        updateTimedRoleConfig(body, "new-member", services, guildResources),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/timed-roles/manual-assignment-config",
      body: timedRoleConfigBodySchema,
      access: bodyGuildScopedAccess("write"),
      feature: "timedRoles",
      handler: async ({ body }) => updateTimedRoleConfig(body, "manual", services, guildResources),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/timed-roles",
      body: timedRoleMutationBodySchema,
      access: bodyGuildScopedAccess("write"),
      feature: "timedRoles",
      handler: async ({ body }) => {
        await guildResources.requireRole(body.guildId, body.roleId);
        if (body.action === "add") {
          const parsedDuration = parseTimedRoleDuration(body.duration, Date.now());
          if (!parsedDuration) return invalidDurationResponse();
          try {
            await services.timedRoleService.assignTimedRole(
              {
                guildId: body.guildId,
                userId: body.userId,
                roleId: body.roleId,
                durationInput: parsedDuration.durationInput,
                expiresAtMs: parsedDuration.expiresAtMs,
                suspendedRoleIds: body.suspendedRoleIds,
              },
              { label: "Admin dashboard" },
            );
          } catch (error) {
            return Response.json(
              { error: describeTimedRoleAssignmentFailure(error) },
              { status: 502 },
            );
          }
        } else {
          const activeAssignment = (
            await services.timedRoleService.listTimedRoles(body.guildId)
          ).find(
            (assignment) => assignment.userId === body.userId && assignment.roleId === body.roleId,
          );
          try {
            await services.timedRoleService.removeTimedRole(
              {
                guildId: body.guildId,
                userId: body.userId,
                roleId: body.roleId,
                durationInput: activeAssignment?.durationInput,
                expiresAtMs: activeAssignment?.expiresAtMs,
                suspendedRoleIds: activeAssignment?.suspendedRoleIds,
                pendingSuspensionRoleIds: activeAssignment?.pendingSuspensionRoleIds,
                removedRoleIds: activeAssignment?.removedRoleIds,
                pendingRestorationRoleIds: activeAssignment?.pendingRestorationRoleIds,
                restorationStartedAtMs: activeAssignment?.restorationStartedAtMs,
                targetRoleRemovalCompletedAtMs: activeAssignment?.targetRoleRemovalCompletedAtMs,
              },
              { label: "Admin dashboard" },
            );
          } catch (error) {
            return Response.json(
              { error: describeTimedRoleRemovalFailure(error) },
              { status: 502 },
            );
          }
        }
        return Response.json({
          guildId: body.guildId,
          assignments: await services.timedRoleService.listTimedRoles(body.guildId),
          notificationChannelId: await services.timedRoleService.getGuildNotificationChannel(
            body.guildId,
          ),
        });
      },
    }),
  ];
}

async function updateTimedRoleConfig(
  body: z.infer<typeof timedRoleConfigBodySchema>,
  target: "new-member" | "manual",
  services: NonNullable<AdminRoutesOptions["adminRouteServices"]>,
  guildResources: GuildResourceValidator,
): Promise<Response> {
  for (const rule of body.roles) {
    if (!parseTimedRoleDuration(rule.durationInput, Date.now())) return invalidDurationResponse();
    if (rule.dmMessage) {
      const result = validateTimedRoleDmTemplate(rule.dmMessage);
      if (!result.valid) return Response.json({ error: result.error }, { status: 400 });
    }
  }
  if (new Set(body.roles.map((rule) => rule.roleId)).size !== body.roles.length) {
    return Response.json({ error: "Duplicate roleId" }, { status: 400 });
  }
  const resources = await guildResources.forGuild(body.guildId);
  resources.requireRoles(
    body.roles.filter((rule) => rule.enabled !== false).map((rule) => rule.roleId),
  );
  if (target === "new-member") {
    await services.timedRoleService.updateNewMemberTimedRoleConfig(body);
    return Response.json({
      newMemberRoleConfig: await services.timedRoleService.getNewMemberTimedRoleConfig(
        body.guildId,
      ),
    });
  }
  await services.timedRoleService.updateManualAssignmentTimedRoleConfig(body);
  return Response.json({
    manualAssignmentRoleConfig: await services.timedRoleService.getManualAssignmentTimedRoleConfig(
      body.guildId,
    ),
  });
}

function invalidDurationResponse(): Response {
  return Response.json(
    { error: "Invalid duration. Use values like 1h, 1w, or 1m." },
    { status: 400 },
  );
}
