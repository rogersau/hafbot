import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadGuildSettingsRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/guild-settings")(
  guildRouteOptions({
    path: "guild-settings",
    loader: loadGuildSettingsRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-guild-settings-page"),
      exportName: "AdminGuildSettingsPage",
    },
  }),
);
