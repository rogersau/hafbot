import { z } from "zod";
import type { ReputationService } from "../../reputation/service";
import {
  ReputationError,
  reputationSettingsSchema,
  reputationSnowflakeSchema,
} from "../../reputation/types";
import { bodyGuildScopedAccess, guildScopedAccess } from "../admin-route-guards";
import { defineRoute, type Route } from "../admin-route-registry";

const scope = z.object({
  guildId: reputationSnowflakeSchema,
  workspaceId: z.string().min(1).optional(),
});

export function createReputationAdminRoutes(options: {
  serviceForGuild: (guildId: string) => ReputationService | Promise<ReputationService>;
}): Route<any, any, Response>[] {
  return [
    defineRoute({
      operationId: "reputation.get",
      method: "GET",
      path: "/admin/api/reputation",
      query: scope,
      access: guildScopedAccess("read"),
      handler: async ({ query }) =>
        Response.json({
          guildId: query.guildId,
          config: await (await options.serviceForGuild(query.guildId)).getConfig(query.guildId),
        }),
    }),
    defineRoute({
      operationId: "reputation.config.post",
      method: "POST",
      path: "/admin/api/reputation/config",
      body: scope.extend({
        settings: reputationSettingsSchema,
        expectedRevision: z.number().int().nonnegative(),
      }),
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        try {
          const service = await options.serviceForGuild(body.guildId);
          return Response.json({
            config: await service.saveConfig(body.guildId, body.settings, body.expectedRevision),
          });
        } catch (error) {
          if (error instanceof ReputationError)
            return Response.json(
              { error: error.message },
              { status: error.code === "conflict" ? 409 : 400 },
            );
          throw error;
        }
      },
    }),
  ];
}
