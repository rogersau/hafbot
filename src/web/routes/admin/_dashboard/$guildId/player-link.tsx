import { z } from "zod";

import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import {
  loadPlayerLinkRoute,
  type PlayerLinkLoaderData,
} from "../../../../../admin/lib/admin-route-loaders";

const playerLinkSearchSchema = z.object({
  platform: z.enum(["steam", "xbox", "playstation"]).optional(),
});

type PlayerLinkSearch = z.infer<typeof playerLinkSearchSchema>;

export const Route = createFileRoute("/admin/_dashboard/$guildId/player-link")(
  guildRouteOptions<PlayerLinkLoaderData>({
    path: "player-link",
    loader: loadPlayerLinkRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-platform-link-page"),
      exportName: "AdminPlatformLinkPage",
    },
    validateSearch: (search) => playerLinkSearchSchema.parse(search),
    loaderDeps: ({ search }) => {
      const parsed = search as PlayerLinkSearch;
      return {
        platform:
          parsed.platform === "xbox" || parsed.platform === "playstation"
            ? parsed.platform
            : "steam",
      };
    },
    extraProps: (context) => ({
      entitlement: context.entitlement,
      activePlatform:
        context.playerLinkPlatform === "playstation" && !context.playstationLinkEnabled
          ? "steam"
          : context.playerLinkPlatform,
    }),
  }),
);
