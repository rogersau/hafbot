import { z } from "zod";
import { defineRoute, type Route } from "../admin-route-registry";
import {
  guildScopedAccess,
  bodyGuildScopedAccess,
  requireGuildQueryId,
} from "../admin-route-guards";
import type { RuntimeStores } from "../app-types";
import type { CustomerSession } from "../auth/customer-session";
import { getCachedGuildTicketResources } from "../admin-discord-cache";
import { postAuditExclusionPolicyChangeEvent } from "../../services/guild-audit-log-service";
import {
  AUDIT_EVENT_GROUP_LABELS,
  AUDIT_EVENT_LABELS,
  type AuditEventGroupId,
  type AuditEventId,
} from "../../types";
import type { ConfigurationActorContext } from "../../configuration-revisions";
import { guildAuditLogRevisionAdapter } from "../../configuration-revisions/adapters";
import { commitVersionedConfigurationMutation } from "../../configuration-revisions/coordinator";

const auditEventGroupSchema = z.enum(
  Object.keys(AUDIT_EVENT_GROUP_LABELS) as [AuditEventGroupId, ...AuditEventGroupId[]],
);
const auditEventSchema = z.enum(
  Object.keys(AUDIT_EVENT_LABELS) as [AuditEventId, ...AuditEventId[]],
);

const auditEventStatesSchema = z.object({
  groups: z.partialRecord(auditEventGroupSchema, z.boolean()).optional().default({}),
  overrides: z.partialRecord(auditEventSchema, z.boolean()).optional().default({}),
});

const channelIdSchema = z.string().regex(/^$|^\d{17,20}$/, "Choose a valid Discord channel.");
const resourceIdSchema = z.string().regex(/^\d{17,20}$/);

const guildAuditLogConfigBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
  auditChannelId: channelIdSchema.optional().default(""),
  groupChannelIds: z.partialRecord(auditEventGroupSchema, channelIdSchema).optional().default({}),
  eventStates: auditEventStatesSchema.optional().default({ groups: {}, overrides: {} }),
  excludedChannelIds: z.array(resourceIdSchema).optional().default([]),
  excludedRoleIds: z.array(resourceIdSchema).optional().default([]),
});

export interface GuildAuditLogAdminRoutesOptions {
  stores: Pick<RuntimeStores, "guildAuditLog" | "guildEntitlements" | "configurationRevisions">;
  discordBotToken: string;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
}

export function createGuildAuditLogAdminRoutes(
  options: GuildAuditLogAdminRoutesOptions,
): Array<Route<any, any, Response>> {
  return [
    defineRoute({
      method: "GET",
      path: "/admin/api/guild-audit-log",
      query: z.object({
        guildId: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
      }),
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const config = await options.stores.guildAuditLog.readConfig(guildId);
        return Response.json({ guildId, config });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/guild-audit-log/capabilities",
      query: z.object({
        guildId: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
      }),
      access: guildScopedAccess("write"),
      handler: async () => Response.json({ canWrite: true }),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/guild-audit-log/config",
      body: guildAuditLogConfigBodySchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request, adminRequest }) => {
        const resources = await getCachedGuildTicketResources(
          body.guildId,
          options.discordBotToken,
          true,
        );

        const allChannelIds = [
          body.auditChannelId,
          ...Object.values(body.groupChannelIds ?? {}),
          ...(body.excludedChannelIds ?? []),
        ].filter((id): id is string => Boolean(id));

        const selectedChannels = resources.channels.filter((channel) =>
          allChannelIds.includes(channel.id),
        );

        const excludedChannelIds = [...new Set(body.excludedChannelIds ?? [])];
        for (const channelId of excludedChannelIds) {
          const selected = selectedChannels.find((channel) => channel.id === channelId);
          if (!selected || ![0, 2, 5, 13, 15].includes(selected.type)) {
            return Response.json(
              { error: "Choose existing Guild channels for the Audit Exclusion Policy." },
              { status: 400 },
            );
          }
        }

        const excludedRoleIds = [...new Set(body.excludedRoleIds ?? [])];
        const knownRoleIds = new Set(resources.roles.map((role) => role.id));
        if (excludedRoleIds.some((roleId) => !knownRoleIds.has(roleId))) {
          return Response.json(
            { error: "Choose existing Guild roles for the Audit Exclusion Policy." },
            { status: 400 },
          );
        }

        if (body.auditChannelId) {
          const selected = selectedChannels.find((channel) => channel.id === body.auditChannelId);
          if (!selected || selected.type !== 0) {
            return Response.json(
              { error: "Choose an existing text channel for the Audit Destination." },
              { status: 400 },
            );
          }
        }

        const groupChannelIds: Partial<Record<AuditEventGroupId, string>> = {};
        for (const [groupId, channelId] of Object.entries(body.groupChannelIds ?? {})) {
          if (!channelId) continue;
          const selected = selectedChannels.find((channel) => channel.id === channelId);
          if (!selected || selected.type !== 0) {
            return Response.json(
              {
                error: `Choose an existing text channel for ${AUDIT_EVENT_GROUP_LABELS[groupId as AuditEventGroupId]}.`,
              },
              { status: 400 },
            );
          }
          groupChannelIds[groupId as AuditEventGroupId] = channelId;
        }

        const eventStates = body.eventStates ?? { groups: {}, overrides: {} };
        const previous = await options.stores.guildAuditLog.readConfig(body.guildId);
        const config = {
          guildId: body.guildId,
          auditChannelId: body.auditChannelId ?? "",
          groupChannelIds,
          eventStates: {
            groups: eventStates.groups ?? {},
            overrides: eventStates.overrides ?? {},
          },
          excludedChannelIds,
          excludedRoleIds,
          updatedAtMs: Date.now(),
        };
        const session = options.readCustomerAdminSession
          ? await options.readCustomerAdminSession(request)
          : null;
        const actor: ConfigurationActorContext = {
          actorUserId: session?.user.discordUserId ?? null,
          source: "dashboard-save",
          operationId: adminRequest?.operationId ?? "guildAuditLogConfig.post",
          correlationId: adminRequest?.correlationId ?? null,
        };
        await commitVersionedConfigurationMutation({
          revisions: options.stores.configurationRevisions,
          entitlements: options.stores.guildEntitlements,
          mutation: {
            guildId: body.guildId,
            feature: "guild-audit-log",
            resourceKey: "default",
            current: previous,
            next: config,
            adapter: guildAuditLogRevisionAdapter,
            actor,
          },
          commitFree: () => options.stores.guildAuditLog.upsertConfig(config),
        });

        const previousChannelIds = previous?.excludedChannelIds ?? [];
        const previousRoleIds = previous?.excludedRoleIds ?? [];
        const addedChannelIds = excludedChannelIds.filter((id) => !previousChannelIds.includes(id));
        const removedChannelIds = previousChannelIds.filter(
          (id) => !excludedChannelIds.includes(id),
        );
        const addedRoleIds = excludedRoleIds.filter((id) => !previousRoleIds.includes(id));
        const removedRoleIds = previousRoleIds.filter((id) => !excludedRoleIds.includes(id));
        if (
          addedChannelIds.length > 0 ||
          removedChannelIds.length > 0 ||
          addedRoleIds.length > 0 ||
          removedRoleIds.length > 0
        ) {
          const actorUserId = session?.user.discordUserId;
          await postAuditExclusionPolicyChangeEvent(
            {
              guildId: body.guildId,
              actorUserId,
              actorLabel: actorUserId ? undefined : "Global admin session",
              addedChannelIds,
              removedChannelIds,
              addedRoleIds,
              removedRoleIds,
            },
            options.stores.guildAuditLog,
            options.discordBotToken,
          );
        }
        return Response.json({ guildId: body.guildId, config });
      },
    }),
  ];
}
