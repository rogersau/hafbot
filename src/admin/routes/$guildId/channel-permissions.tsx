import { createGuildRoute } from "./guild-route-factory";

export const Route = createGuildRoute({
  path: "channel-permissions",
  loader: async () => ({ data: null, loadedAt: Date.now() }),
  page: {
    load: () => import("../../components/admin-channel-permissions-page"),
    exportName: "AdminChannelPermissionsPage",
  },
  initialData: false,
  useInvalidation: false,
});
