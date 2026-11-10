import { z } from "zod";
import { DiscordApiError } from "../../discord/client";
import {
  DISCORD_RESOURCE_NAME_MAX_LENGTH,
  isDiscordResourceNameLengthValid,
} from "../../discord/resource-name";
import {
  createSetupCategory,
  createSetupForumChannel,
  grantSetupChannelRoleAccess,
  createSetupRole,
  createSetupTextChannel,
  createSetupVoiceChannel,
} from "../../discord/setup-resources";
import { getGuildPermissionResources } from "../../discord/guilds";
import { readFeatureResourceCatalogEntry } from "../../feature-resource-catalog";
import type {
  FeatureSetupDefinition,
  SetupResource,
  SetupResourceChoice,
  SetupResourceKind,
} from "../../feature-setup";
import { FeatureSetupError, FeatureSetupRunner } from "../../services/feature-setup-runner";
import { postFeatureResourceSetupAuditEvent } from "../../services/guild-audit-log-service";
import {
  DISCORD_PERMISSION_FLAGS,
  getBaseGuildPermissions,
  getChannelPermissions,
  hasPermission,
} from "../admin-permissions";

import { defineRoute, type Route } from "../admin-route-registry";
import type { RuntimeStores } from "../app-types";
import type { CustomerSession } from "../auth/customer-session";

const choiceSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reuse"), resourceId: z.string().min(1) }),
  z.object({
    action: z.literal("create"),
    name: z
      .string()
      .trim()
      .min(1)
      .refine(isDiscordResourceNameLengthValid, {
        message: `Name must be ${DISCORD_RESOURCE_NAME_MAX_LENGTH} characters or fewer.`,
      }),
  }),
]);
const bodySchema = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  surfaceKey: z.string().min(1).max(64),
  dependencyKey: z.string().min(1).max(64),
  choice: choiceSchema,
  confirmationId: z.string().uuid().optional(),
  accessRoleIds: z.array(z.string().min(1)).max(25).optional().default([]),
  accessChannelIds: z.array(z.string().min(1)).max(10).optional().default([]),
});

export function createFeatureResourceSetupAdminRoutes(options: {
  stores: RuntimeStores;
  discordBotToken: string;
  discordBotUserId?: string;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
}): Array<Route<any, any, Response>> {
  return [
    defineRoute({
      method: "POST",
      path: "/admin/api/feature-resource-setup/preview",
      body: bodySchema,
      access: ({ body }) => {
        const input = body as z.infer<typeof bodySchema>;
        return {
          mode: "write",
          guildId: input.guildId,
          workspaceId: input.workspaceId,
          ...(input.surfaceKey === "guild_access"
            ? { guildCapability: "manage-delegation" as const }
            : {}),
        };
      },
      handler: async ({ body }) => {
        const context = createContext(
          options,
          body.guildId,
          body.surfaceKey,
          body.dependencyKey,
          body.accessRoleIds ?? [],
          body.accessChannelIds ?? [],
        );
        if (context instanceof Response) return context;
        try {
          const preview = await context.runner.preview(context.definition, {
            [body.dependencyKey]: body.choice as SetupResourceChoice,
          });
          return Response.json({ preview: { ...preview, confirmationId: crypto.randomUUID() } });
        } catch (cause) {
          return featureSetupErrorResponse(cause);
        }
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/feature-resource-setup/execute",
      body: bodySchema,
      access: ({ body }) => {
        const input = body as z.infer<typeof bodySchema>;
        return {
          mode: "write",
          guildId: input.guildId,
          workspaceId: input.workspaceId,
          ...(input.surfaceKey === "guild_access"
            ? { guildCapability: "manage-delegation" as const }
            : {}),
        };
      },
      handler: async ({ body, request }) => {
        const context = createContext(
          options,
          body.guildId,
          body.surfaceKey,
          body.dependencyKey,
          body.accessRoleIds ?? [],
          body.accessChannelIds ?? [],
        );
        if (context instanceof Response) return context;
        try {
          const session = await options.readCustomerAdminSession?.(request);
          const actorUserId = session?.user.discordUserId ?? session?.user.id ?? "admin-ui";
          const run = await context.runner.execute(
            context.definition,
            actorUserId,
            { [body.dependencyKey]: body.choice as SetupResourceChoice },
            body.confirmationId,
          );
          const resolution = run.resolutions.find(
            (candidate) => candidate.dependencyKey === body.dependencyKey,
          );
          return Response.json({ run, resource: resolution?.resource ?? null });
        } catch (cause) {
          return featureSetupErrorResponse(cause);
        }
      },
    }),
  ];
}

function createContext(
  options: {
    stores: RuntimeStores;
    discordBotToken: string;
    discordBotUserId?: string;
  },
  guildId: string,
  surfaceKey: string,
  dependencyKey: string,
  accessRoleIds: string[],
  accessChannelIds: string[],
): { runner: FeatureSetupRunner; definition: FeatureSetupDefinition } | Response {
  if (!options.stores.featureSetup || !options.discordBotUserId) {
    return Response.json({ error: "Feature Resource Setup is unavailable." }, { status: 503 });
  }
  const catalog = readFeatureResourceCatalogEntry(surfaceKey, dependencyKey);
  if (!catalog) {
    return Response.json(
      { error: "This feature resource cannot be created by HAF." },
      { status: 400 },
    );
  }
  if (!catalog.pairedAccess && (accessRoleIds.length > 0 || accessChannelIds.length > 0)) {
    return Response.json(
      { error: "This feature dependency does not permit paired permission changes." },
      { status: 400 },
    );
  }
  let resourcesPromise: ReturnType<typeof getGuildPermissionResources> | null = null;
  const readResources = () =>
    (resourcesPromise ??= getGuildPermissionResources(
      guildId,
      options.discordBotUserId!,
      options.discordBotToken,
    ));
  const definition: FeatureSetupDefinition = {
    guildId,
    featureKey: `surface:${surfaceKey}:${dependencyKey}`,
    version: 1,
    dependencies: [
      {
        key: dependencyKey,
        label: catalog.label,
        kind: catalog.kind,
        recommendedName: catalog.recommendedName,
        createdRelationship: catalog.relationship,
        templateVersion: 1,
        permissionSummary: [
          catalog.permissionSummary,
          accessRoleIds.length > 0
            ? `Grants ${accessRoleIds.length} selected feature role(s) access during creation.`
            : null,
          accessChannelIds.length > 0
            ? `Grants the new role access to ${accessChannelIds.length} selected feature channel(s) before setup completes.`
            : null,
        ]
          .filter(Boolean)
          .join(" "),
        validateReuse: async (resourceId) =>
          validateResource(
            guildId,
            resourceId,
            catalog.kind,
            options.discordBotUserId!,
            await readResources(),
          ),
        create: (name) =>
          createResource(
            catalog.kind,
            {
              guildId,
              name,
              private: catalog.private,
              botUserId: options.discordBotUserId!,
              accessRoleIds,
            },
            options.discordBotToken,
          ),
        apply: async (resource) => {
          if (catalog.kind !== "role") return;
          for (const channelId of accessChannelIds) {
            await grantSetupChannelRoleAccess(channelId, resource.id, options.discordBotToken);
          }
        },
      },
    ],
    preflight: async () => {
      const resources = await readResources();
      const permissions = getBaseGuildPermissions({
        guildId,
        botUserId: options.discordBotUserId!,
        ...resources,
      });
      const required = catalog.kind === "role" ? "manageRoles" : "manageChannels";
      if (!hasPermission(permissions, DISCORD_PERMISSION_FLAGS[required])) {
        throw new Error(
          catalog.kind === "role"
            ? "HAF needs Manage Roles to create this resource."
            : "HAF needs Manage Channels to create this resource.",
        );
      }
      if (
        catalog.kind === "role" &&
        accessChannelIds.length > 0 &&
        !hasPermission(permissions, DISCORD_PERMISSION_FLAGS.manageChannels)
      ) {
        throw new Error("HAF needs Manage Channels to grant the new role access.");
      }
      for (const roleId of accessRoleIds) {
        if (!resources.roles.some((role) => role.id === roleId && role.managed !== true)) {
          throw new Error("One of the selected access roles is missing or managed by Discord.");
        }
      }
      for (const channelId of accessChannelIds) {
        if (!resources.channels.some((channel) => channel.id === channelId)) {
          throw new Error("One of the selected access channels is missing from this Guild.");
        }
      }
    },
    readConfiguration: async () => ({
      enabled: false,
      dormant: false,
      resourceIds: { [dependencyKey]: null },
    }),
    record: (event, run) =>
      postFeatureResourceSetupAuditEvent(
        {
          guildId,
          setupRunId: run.id,
          surfaceKey,
          dependencyKey,
          event,
          actorUserId: run.actorUserId,
          resourceIds: run.resolutions.map((resolution) => resolution.resource.id),
          failureMessage: run.failureMessage,
        },
        options.stores.guildAuditLog,
        options.discordBotToken,
      ),
  };
  return { runner: new FeatureSetupRunner(options.stores.featureSetup), definition };
}

async function createResource(
  kind: SetupResourceKind,
  input: {
    guildId: string;
    name: string;
    private: boolean;
    botUserId: string;
    accessRoleIds: string[];
  },
  botToken: string,
): Promise<SetupResource> {
  switch (kind) {
    case "text_channel":
      return createSetupTextChannel(input, botToken);
    case "voice_channel":
      return createSetupVoiceChannel(input, botToken);
    case "forum_channel":
      return createSetupForumChannel(input, botToken);
    case "category":
      return createSetupCategory(input, botToken);
    case "role":
      return createSetupRole(input, botToken);
  }
}

function validateResource(
  guildId: string,
  resourceId: string,
  kind: SetupResourceKind,
  botUserId: string,
  resources: Awaited<ReturnType<typeof getGuildPermissionResources>>,
): SetupResource {
  if (kind === "role") {
    const role = resources.roles.find(
      (candidate) =>
        candidate.id === resourceId && candidate.id !== guildId && candidate.managed !== true,
    );
    if (!role) throw new Error("The selected role is missing, managed, or not in this Guild.");
    return { id: role.id, name: role.name, kind };
  }
  const expectedType = { text_channel: 0, voice_channel: 2, category: 4, forum_channel: 15 }[kind];
  const channel = resources.channels.find(
    (candidate) => candidate.id === resourceId && candidate.type === expectedType,
  );
  if (!channel) throw new Error("The selected Discord resource is missing or has the wrong type.");
  const permissions = getChannelPermissions({ guildId, botUserId, ...resources }, channel);
  if (!hasPermission(permissions, DISCORD_PERMISSION_FLAGS.viewChannel)) {
    throw new Error("HAF cannot view the selected Discord resource.");
  }
  return { id: channel.id, name: channel.name, kind };
}

function featureSetupErrorResponse(cause: unknown): Response {
  if (cause instanceof FeatureSetupError) {
    return Response.json(
      { error: cause.message, code: cause.code },
      { status: cause.code === "active_run_conflict" ? 409 : 400 },
    );
  }
  if (cause instanceof DiscordApiError && cause.status >= 400 && cause.status < 500) {
    return Response.json({ error: conciseDiscordResourceError(cause) }, { status: 400 });
  }
  throw cause;
}

function conciseDiscordResourceError(error: DiscordApiError): string {
  try {
    const details = JSON.parse(error.details) as { message?: unknown };
    if (typeof details.message === "string" && details.message.trim()) {
      return details.message.trim();
    }
  } catch {
    // Discord occasionally returns a non-JSON body; keep the UI message concise.
  }
  return "Discord rejected that resource name. Check the name and try again.";
}
