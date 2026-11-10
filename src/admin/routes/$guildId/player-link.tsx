import { z } from "zod";

import { createGuildRoute } from "./guild-route-factory";
import { loadPlayerLinkRoute, type PlayerLinkLoaderData } from "../../lib/admin-route-loaders";

const playerLinkSearchSchema = z.object({
  platform: z.enum(["steam", "xbox", "playstation"]).optional(),
});

type PlayerLinkSearch = z.infer<typeof playerLinkSearchSchema>;

export const Route = createGuildRoute<PlayerLinkLoaderData>({
  path: "player-link",
  loader: loadPlayerLinkRoute,
  page: {
    load: () => import("../../components/admin-steam-link-page"),
    exportName: "AdminSteamLinkPage",
  },
  validateSearch: (search) => playerLinkSearchSchema.parse(search),
  loaderDeps: ({ search }) => {
    const parsed = search as PlayerLinkSearch;
    return {
      platform:
        parsed.platform === "xbox" || parsed.platform === "playstation" ? parsed.platform : "steam",
    };
  },
  extraProps: (context) => ({
    entitlement: context.entitlement,
    activePlatform:
      context.playerLinkPlatform === "playstation" && !context.playstationLinkEnabled
        ? "steam"
        : context.playerLinkPlatform,
  }),
});
