import { createGuildRoute } from "./guild-route-factory";
import { loadAutomationRoute } from "../../lib/admin-route-loaders";
export const Route = createGuildRoute({
  path: "automation",
  loader: loadAutomationRoute,
  page: {
    load: () => import("../../components/admin-community-tools-page"),
    exportName: "AdminAutomationPage",
  },
});
