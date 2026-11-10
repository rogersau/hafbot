import { createGuildRoute } from "./guild-route-factory";
import { loadContentFeedsRoute } from "../../lib/admin-route-loaders";
export const Route = createGuildRoute({
  path: "content-feeds",
  loader: loadContentFeedsRoute,
  page: {
    load: () => import("../../components/admin-community-tools-page"),
    exportName: "AdminContentFeedsPage",
  },
});
