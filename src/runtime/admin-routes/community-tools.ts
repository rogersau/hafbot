import { z } from "zod";
import {
  CommunityToolsError,
  communityConfigSchemas,
  snowflake,
  type CommunityFeature,
} from "../../community-tools/config";
import type { CommunityToolsService } from "../../community-tools/service";
import { defineRoute, type Route } from "../admin-route-registry";
import { bodyGuildScopedAccess, guildScopedAccess } from "../admin-route-guards";

const scope = z.object({ guildId: snowflake, workspaceId: z.string().min(1).optional() });
export function createCommunityToolsAdminRoutes(
  service: CommunityToolsService,
): Route<any, any, Response>[] {
  return (Object.keys(communityConfigSchemas) as CommunityFeature[]).flatMap((feature) => [
    defineRoute({
      method: "GET",
      path: `/admin/api/community-${feature}`,
      query: scope,
      access: guildScopedAccess("read"),
      handler: async ({ query }) =>
        Response.json({
          guildId: query.guildId,
          ...(await service.dashboard(query.guildId, feature)),
        }),
    }),
    defineRoute({
      method: "POST",
      path: `/admin/api/community-${feature}`,
      body: scope.extend({
        config: communityConfigSchemas[feature],
        revision: z.number().int().nonnegative(),
      }),
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        try {
          return Response.json(
            await service.save(body.guildId, feature, body.config, body.revision),
          );
        } catch (error) {
          if (error instanceof CommunityToolsError)
            return Response.json({ error: error.message }, { status: error.status });
          throw error;
        }
      },
    }),
    ...(feature === "moderation"
      ? [
          defineRoute({
            method: "GET",
            path: "/admin/api/community-moderation/history",
            query: scope.extend({ userId: snowflake.optional() }),
            access: guildScopedAccess("read"),
            handler: async ({ query }) =>
              Response.json({ cases: await service.store.history(query.guildId, query.userId) }),
          }),
        ]
      : []),
  ]);
}
