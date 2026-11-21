import { z } from "zod";
import {
  CommunityToolsError,
  snowflake,
  wardogsLinkPanelDraftSchema,
  type WardogsLinkPanel,
} from "../../community-tools/config";
import type { WardogsGoldStatus } from "../../wardogs/community-data";
import { STEAM_ID64 } from "../../wardogs/community-data";
import { DiscordApiError } from "../../discord/client";
import { defineRoute, type Route } from "../admin-route-registry";
import { bodyGuildScopedAccess, guildScopedAccess } from "../admin-route-guards";
import type { AdminRoutesOptions } from "./index";

export type PublishedWardogsPanel = Omit<WardogsLinkPanel, "botUserId">;
export interface WardogsCommunityDashboard {
  enabled: boolean;
  canWrite: boolean;
  steamLinkReady: boolean;
  trackerConnectAvailable: boolean;
  goldAvailable: boolean;
  gold: WardogsGoldStatus | null;
  goldChannelId: string | null;
  panel: PublishedWardogsPanel | null;
}

const scope = z.object({ guildId: snowflake, workspaceId: z.string().min(1).optional() });
const path = "/admin/api/wardogs/community";

export function createWardogsCommunityAdminRoutes(
  options: Pick<
    AdminRoutesOptions,
    "adminAccess" | "features" | "stores" | "wardogsCommunity" | "communityTools"
  >,
): Route<any, any, Response>[] {
  const { communityTools } = options;
  if (!communityTools) return [];
  const runtime =
    options.features?.wardogsCommunity === false ? undefined : options.wardogsCommunity;
  const steamLinkReady = async (guildId: string) => {
    if (options.features?.steamLink === false) return false;
    const config = await options.stores.platformLink.readPlatformLinkConfig(guildId, "steam");
    return Boolean(config && config.enabled !== false);
  };
  return [
    defineRoute({
      method: "GET",
      path,
      query: scope,
      access: guildScopedAccess("read"),
      handler: async ({ query, request }) => {
        const [settings, linkReady, gold, writeAccess] = await Promise.all([
          communityTools.readWardogsSettings(query.guildId),
          runtime ? steamLinkReady(query.guildId) : false,
          runtime?.data.readGoldStatus().catch(() => null) ?? null,
          options.adminAccess.authorize(request, {
            guildId: query.guildId,
            workspaceId: query.workspaceId,
            mode: "write",
          }),
        ]);
        return Response.json({
          enabled: Boolean(runtime),
          canWrite: writeAccess.ok,
          steamLinkReady: linkReady,
          trackerConnectAvailable: Boolean(runtime?.connect),
          goldAvailable: runtime?.data.goldAvailable ?? false,
          gold,
          goldChannelId: settings.goldChannelId,
          panel: settings.panel ? publicPanel(settings.panel) : null,
        } satisfies WardogsCommunityDashboard);
      },
    }),
    defineRoute({
      method: "POST",
      path,
      access: bodyGuildScopedAccess("write"),
      maxBodyBytes: 4096,
      body: z.discriminatedUnion("action", [
        scope.extend({ action: z.literal("gold"), channelId: snowflake.nullable() }).strict(),
        scope
          .extend(wardogsLinkPanelDraftSchema.shape)
          .extend({ action: z.literal("publish-panel") })
          .strict(),
      ]),
      handler: async ({ body }) => {
        if (!runtime)
          return Response.json(
            { error: "WARDOGS community features are unavailable." },
            { status: 503 },
          );
        try {
          if (body.action === "gold") {
            await communityTools.configureWardogsGold(body.guildId, body.channelId);
            const { goldChannelId } = await communityTools.readWardogsSettings(body.guildId);
            return Response.json({ goldChannelId });
          }
          if (!(await steamLinkReady(body.guildId))) {
            return Response.json(
              { error: "Set up and enable Steam Player Link for this server first." },
              { status: 409 },
            );
          }
          const panel = await communityTools.publishWardogsLinkPanel(body.guildId, {
            channelId: body.channelId,
            title: body.title,
            description: body.description,
          });
          return Response.json({ panel: publicPanel(panel) });
        } catch (error) {
          if (error instanceof CommunityToolsError)
            return Response.json({ error: error.message }, { status: error.status });
          if (error instanceof DiscordApiError && [403, 404].includes(error.status)) {
            return Response.json(
              { error: "HAF Bot needs access to view and post in the selected channel." },
              { status: 409 },
            );
          }
          throw error;
        }
      },
    }),
    defineRoute({
      method: "GET",
      path: `${path}/player`,
      access: guildScopedAccess("read"),
      query: scope.extend({ steamId: z.string().regex(STEAM_ID64) }),
      handler: async ({ query }) => {
        if (!runtime)
          return Response.json(
            { error: "WARDOGS community features are unavailable." },
            { status: 503 },
          );
        try {
          return Response.json({ stats: await runtime.data.readPublicStats(query.steamId) });
        } catch {
          return Response.json(
            { error: "WARDOGS Tracker is temporarily unavailable. Try again shortly." },
            { status: 502 },
          );
        }
      },
    }),
  ];
}

function publicPanel({
  channelId,
  messageId,
  title,
  description,
}: WardogsLinkPanel): PublishedWardogsPanel {
  return { channelId, messageId, title, description };
}
