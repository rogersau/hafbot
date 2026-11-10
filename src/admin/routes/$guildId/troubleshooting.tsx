import { createGuildRoute } from "./guild-route-factory";
import { loadTroubleshootingRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "troubleshooting",
  loader: loadTroubleshootingRoute,
  page: {
    load: () => import("../../components/admin-troubleshooting-page"),
    exportName: "AdminTroubleshootingPage",
  },
  useInvalidation: false,
  initialData: (loaderData) => loaderData ?? null,
  key: (context, loaderData) =>
    `${context.selectedWorkspaceId}:${context.pathGuildId || "no-guild"}:${loaderData?.loadedAt ?? 0}`,
});
