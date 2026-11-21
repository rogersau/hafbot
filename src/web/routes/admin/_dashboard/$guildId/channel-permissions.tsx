import { createFileRoute } from "@tanstack/react-router";
import {
  getGuildId,
  getWorkspaceId,
  wrapLoaded,
} from "../../../../../admin/lib/admin-loader-client";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";

export const Route = createFileRoute("/admin/_dashboard/$guildId/channel-permissions")(
  guildRouteOptions({
    path: "channel-permissions",
    loader: async (ctx) => {
      const { getChannelPermissionCopyResources } =
        await import("../../../../../admin/lib/channel-permission-copy");
      return wrapLoaded(
        await getChannelPermissionCopyResources(
          getWorkspaceId(ctx),
          getGuildId(ctx),
          ctx.abortController?.signal,
        ),
      );
    },
    page: {
      load: () => import("../../../../../admin/components/admin-channel-permissions-page"),
      exportName: "AdminChannelPermissionsPage",
    },
    useInvalidation: false,
  }),
);
