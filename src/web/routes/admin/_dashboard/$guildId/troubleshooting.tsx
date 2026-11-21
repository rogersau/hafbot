import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadTroubleshootingRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/troubleshooting")(
  guildRouteOptions({
    path: "troubleshooting",
    loader: loadTroubleshootingRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-troubleshooting-page"),
      exportName: "AdminTroubleshootingPage",
    },
    useInvalidation: false,
    initialData: (loaderData) => loaderData ?? null,
    key: (context, loaderData) =>
      `${context.selectedWorkspaceId}:${context.pathGuildId || "no-guild"}:${loaderData?.loadedAt ?? 0}`,
  }),
);
