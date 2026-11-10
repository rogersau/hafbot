import { createGuildRoute } from "./guild-route-factory";
import { loadGuildSettingsRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "guild-settings",
  loader: loadGuildSettingsRoute,
  page: {
    load: () => import("../../components/admin-guild-settings-page"),
    exportName: "AdminGuildSettingsPage",
  },
});
