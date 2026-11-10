import { createGuildRoute } from "./guild-route-factory";
import { loadManagedMessagesRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "managed-messages",
  loader: loadManagedMessagesRoute,
  page: {
    load: () => import("../../components/admin-managed-messages-page"),
    exportName: "AdminManagedMessagesPage",
  },
});
