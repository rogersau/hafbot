import { createGuildRoute } from "./guild-route-factory";
import { loadMentionProtectionRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "mention-protection",
  loader: loadMentionProtectionRoute,
  page: {
    load: () => import("../../components/admin-mention-protection-page"),
    exportName: "AdminMentionProtectionPage",
  },
  extraProps: (context, loaderData) => ({
    entitlement: context.entitlement ?? loaderData?.data.entitlement ?? null,
  }),
});
